/**
 * New session from the phone against a REAL in-process daemon
 * (docs/feat/mobile-chrome.md slice S7 — its load-bearing check, kept as the
 * regression): a `serve`-shaped `SessionHost` + `Connection` over an in-memory
 * pair, a real `RemoteClient`, and the phone's OWN pieces —
 * `createSessionController` (attach only) and `createFreshSession`.
 *
 * What it pins: the phone's attach-only path can NOT reach a minted id (so the
 * create has to happen at the tap); a create through a handle built WITHOUT
 * `attach` makes the session exist and be listed, live and not archived (it
 * was detached, never closed); the phone's normal attach then opens it and a
 * send lands. Offline: a typed `link` refusal, and nothing is created.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { RemoteClient } from "@tentacle/client";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost, SessionPersister } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { SpyDaemonStore } from "../../../packages/daemon/test/support/daemon-store-spy.ts";
import { createFreshSession, createSessionController } from "../src/session-controller.ts";

const CWD = "/tmp/mobile-new-session-link";

class Model implements ModelProvider {
  readonly id = "echo";
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const prompt = [...request.messages].reverse().find((m) => m.role === "user")?.content ?? "";
    yield { type: "text", delta: `ok:${prompt}` };
    yield { type: "done" };
  }
}

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as unknown as ExecutionEnvironment;

function daemon(): SessionHost {
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
        model: new Model(),
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
}

async function dial(host: SessionHost): Promise<RemoteClient> {
  const [server, client] = createChannelPair();
  new Connection(server, host);
  const remote = new RemoteClient(client, new PermissionBroker(), undefined, { onError: () => {} });
  await remote.initialize();
  return remote;
}

/** The phone's controller exactly as `App.tsx` builds it: attach only, never create. */
function phoneController(client: RemoteClient) {
  return createSessionController({
    newSession: (sessionId, options) =>
      client.newSession(undefined, sessionId, undefined, {
        attach: options.reopen === true ? { reopen: true } : {},
      }),
  });
}

const listed = async (client: RemoteClient, id: string) =>
  (await client.sessionList({ limit: 200 })).sessions.find((s) => s.sessionId === id);

describe("New session from the phone over a real daemon", () => {
  test("the attach-only path cannot reach a minted id; a fresh create makes it exist, listed live (detached, never closed), and the phone's attach then sends to it (mutation: create with an attach handle → not created → red)", async () => {
    const host = daemon();
    const phone = await dial(host);
    const laptop = await dial(host);
    const id = crypto.randomUUID();

    // Why the create is at the tap: the phone's own open never creates.
    const before = await phoneController(phone).open(id);
    expect(before.ok).toBe(false);
    expect(await listed(laptop, id)).toBeUndefined();

    const created = await createFreshSession(phone.newSession(undefined, id));
    expect(created).toEqual({ ok: true });
    const entry = await listed(laptop, id);
    expect(entry?.archived).toBe(false);

    const opened = await phoneController(phone).open(id);
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      const texts: string[] = [];
      for await (const event of opened.session.send("first words")) {
        if (event.type === "text") {
          texts.push(event.delta);
        }
      }
      expect(texts.join("")).toBe("ok:first words");
    }
    const probe = laptop.newSession(undefined, id, undefined, { attach: {} });
    await probe.open();
    const users = ((await probe.snapshot()) ?? []).filter((m) => m.role === "user");
    expect(users.map((m) => m.content)).toEqual(["first words"]);
    phone.close();
    laptop.close();
  });

  test("F8: offline (the link is down) → a typed `link` refusal, and the daemon has no such session", async () => {
    const host = daemon();
    const phone = await dial(host);
    const laptop = await dial(host);
    phone.close();
    const id = crypto.randomUUID();
    const created = await createFreshSession(phone.newSession(undefined, id));
    expect(created).toEqual({ ok: false, reason: "link" });
    expect(await listed(laptop, id)).toBeUndefined();
    laptop.close();
  });
});
