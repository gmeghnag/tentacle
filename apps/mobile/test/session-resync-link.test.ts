/**
 * fix/mobile-connect-latency T8 (plan 3a): the foreground re-read over a REAL
 * in-process daemon, through the app's own foreground gate, with the screen
 * subscribed to the link SYNCHRONOUSLY exactly as `App.tsx` does
 * (`link.onStatus((s) => created?.link(s.state === "up"))`). The harness is
 * `session-link.test.ts`'s (SessionHost + Connection + createChannelPair, the
 * server end closing its `Connection` on close) composed with
 * `outbox-link.test.ts`'s `createSessionScreen` mount.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { RemoteClient as Client, type RemoteClient } from "@tentacle/client";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost, SessionPersister } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { SpyDaemonStore } from "../../../packages/daemon/test/support/daemon-store-spy.ts";
import { RESYNC_FAILED_NOTICE } from "../src/composer.ts";
import { createForegroundGate } from "../src/foreground-gate.ts";
import { createSessionController } from "../src/session-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";

const CWD = "/tmp/mobile-resync-link";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check()) && Date.now() < deadline) {
    await sleep(5);
  }
}

class EchoModel implements ModelProvider {
  readonly id = "echo";
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    yield { type: "text", delta: `ok:${prompt}` };
    yield { type: "done" };
  }
}

function daemon(): SessionHost {
  const env = {
    id: "e",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: async () => "",
    writeFile: async () => {},
  } as unknown as ExecutionEnvironment;
  return new SessionHost({
    defaultCwd: CWD,
    persister: new SessionPersister({
      store: new SpyDaemonStore(),
      cwd: CWD,
      model: "m",
      onError: () => {},
    }),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model: new EchoModel(),
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
}

/** A client dialling through the app's foreground gate (first dial included, as `openComputer`). */
async function dial(host: SessionHost) {
  const connect = (): DuplexChannel => {
    const [server, client] = createChannelPair();
    let connection: Connection | null = null;
    const serverEnd: DuplexChannel = {
      send: (data) => server.send(data),
      close: () => server.close(),
      setOnMessage: (h) => server.setOnMessage(h),
      setOnClose: (h) =>
        server.setOnClose(() => {
          h();
          connection?.close();
        }),
    };
    connection = new Connection(serverEnd, host);
    return client;
  };
  const gate = createForegroundGate(async () => connect());
  const first = await gate.dial();
  const client = new Client(first, new PermissionBroker(), undefined, {
    channelFactory: gate.dial,
    random: () => 0,
    onError: () => {},
  });
  return { client, gate };
}

async function entryOf(client: RemoteClient, sid: string) {
  const page = await client.sessionList({ limit: 50 });
  return page.sessions.find((s) => s.sessionId === sid);
}

interface Trace {
  readonly kind: string;
  readonly state?: string;
  readonly reason?: string;
}

/**
 * The repro's script: open → `background` + suspend (link drops) → `active`
 * (the resync is OWED: the link is down) → resume → link up. With
 * `concurrentOpen`, the same controller is also asked to open the id at `up`
 * (the hub / outbox do) — the plan's second variant.
 */
async function scenario(o: { readonly concurrentOpen: boolean }) {
  const host = daemon();
  const laptop = await dial(host);
  await laptop.client.initialize();
  const sid = crypto.randomUUID();
  for await (const _event of laptop.client.newSession(undefined, sid).send("hi")) {
    // drain: the session is live
  }
  const phone = await dial(host);
  await phone.client.initialize();
  const traces: Trace[] = [];
  const controller = createSessionController<SendableHandle>({
    newSession: (id, options) =>
      phone.client.newSession(undefined, id, undefined, {
        attach: options.reopen === true ? { reopen: true } : {},
      }) as unknown as SendableHandle,
  });
  const screen = createSessionScreen({
    sessionId: sid,
    archived: false,
    title: "t",
    project: "p",
    controller,
    broker: new PermissionBroker(),
    now: () => Date.now(),
    trace: (event) => traces.push(event as Trace),
  });
  // App.tsx:1835 — synchronous, in the client's `emitStatus` tick.
  phone.client.onLinkStatus((s) => {
    screen.link(s.state === "up");
    if (o.concurrentOpen && s.state === "up") {
      void controller.open(sid, { watch: () => {} });
    }
  });
  screen.appState("active");
  await screen.open();
  expect(screen.state().status.phase).toBe("open");
  await until(async () => (await entryOf(laptop.client, sid))?.attached === 2);

  screen.appState("background");
  phone.gate.suspend();
  await until(() => screen.state().transcript.link === "down");
  screen.appState("active"); // owed: the link is down
  phone.gate.resume();
  await until(() => screen.state().transcript.link === "up");
  await until(() => !screen.state().refreshing && screen.state().status.phase !== "opening");
  await sleep(100);
  await until(async () => (await entryOf(laptop.client, sid))?.attached === 2);
  const attached = (await entryOf(laptop.client, sid))?.attached;
  const state = screen.state();
  screen.dispose();
  laptop.client.close();
  phone.client.close();
  return { state, attached, traces };
}

describe("T8 the foreground re-read over a real daemon (plan 3a)", () => {
  for (const concurrentOpen of [false, true]) {
    const label = concurrentOpen ? " + a concurrent open of the same id" : "";
    test(`owed resync at link up${label}: ends open, editable, attached, no re-read notice`, async () => {
      const { state, attached, traces } = await scenario({ concurrentOpen });
      expect(traces.filter((t) => t.kind === "attach" && t.state === "fail")).toEqual([]);
      expect(state.status.phase).toBe("open");
      expect(state.view.editable).toBe(true);
      expect(state.notice).not.toBe(RESYNC_FAILED_NOTICE);
      expect(attached).toBe(2);
    });
  }
});
