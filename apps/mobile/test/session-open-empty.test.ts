/**
 * docs/fix/mobile-session-open-empty.md T5: a Session screen opened on a session
 * some other holder already follows shows its history, and stays followed. Real
 * in-process daemon and `RemoteClient`, the app's own session and screen
 * controllers; `showsScene` is what `SessionScreen.tsx` draws as "empty".
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { RemoteClient } from "@tentacle/client";
import { type ExecutionEnvironment, type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { Method } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { until } from "../../../packages/client/test/support/fakes.ts";
import { showsScene } from "../src/mascot-scenes.ts";
import { createSessionController } from "../src/session-controller.ts";
import { type SendableHandle, createSessionScreen } from "../src/session-screen-controller.ts";

/** One daemon, a laptop with one finished turn, and the phone's controller. */
async function rig() {
  const model: ModelProvider = {
    id: "m",
    async *stream(request) {
      const content = [...request.messages].reverse().find((m) => m.role === "user")?.content;
      // The last line is the prompt: the daemon puts its time stamp above it.
      yield { type: "text", delta: `ok:${String(content).split("\n").at(-1)}` };
      yield { type: "done" };
    },
  };
  const env = {
    id: "e",
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  } as unknown as ExecutionEnvironment;
  const host = new SessionHost({
    defaultCwd: "/tmp/x",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  /** The methods the PHONE sent. */
  const sent: string[] = [];
  function dial(broker: PermissionBroker, spy?: string[]): RemoteClient {
    const connect = (): DuplexChannel => {
      const [server, client] = createChannelPair();
      new Connection(server, host);
      return {
        send: (data) => {
          const method = (JSON.parse(data) as { method?: string }).method;
          if (method !== undefined) {
            spy?.push(method);
          }
          client.send(data);
        },
        close: () => client.close(),
        setOnMessage: (h) => client.setOnMessage(h),
        setOnClose: (h) => client.setOnClose(h),
      };
    };
    return new RemoteClient(connect(), broker, undefined, {
      channelFactory: async () => connect(),
      random: () => 0,
    });
  }
  const laptop = dial(new PermissionBroker());
  await laptop.initialize();
  const sid = crypto.randomUUID();
  const laptopSession = laptop.newSession(undefined, sid);
  async function laptopTurn(prompt: string): Promise<void> {
    for await (const _event of laptopSession.send(prompt)) {
      // drain
    }
  }
  await laptopTurn("hi");
  const broker = new PermissionBroker(undefined, { holdUntilSet: true });
  const phone = dial(broker, sent);
  await phone.initialize();
  // App.tsx's shape: attach, never create.
  const controller = createSessionController<SendableHandle>({
    newSession: (id) =>
      phone.newSession(undefined, id, undefined, { attach: {} }) as SendableHandle,
  });
  const screen = () =>
    createSessionScreen({
      sessionId: sid,
      archived: false,
      title: "t",
      project: "p",
      controller,
      broker,
      now: () => 1000,
    });
  return {
    sid,
    controller,
    screen,
    laptopTurn,
    detaches: () => sent.filter((m) => m === Method.Detach).length,
    close() {
      phone.close();
      laptop.close();
    },
  };
}

type Screen = ReturnType<Awaited<ReturnType<typeof rig>>["screen"]>;

const shown = (screen: Screen): string => JSON.stringify(screen.state().transcript.rows);

/** The property: history on screen, no empty scene, and a later laptop turn arrives. */
async function expectAlive(
  screen: Screen,
  laptopTurn: (prompt: string) => Promise<void>,
  prompt: string,
): Promise<void> {
  const { status, transcript } = screen.state();
  expect(status.phase).toBe("open");
  expect(transcript.rows.length).toBeGreaterThan(0);
  expect(showsScene({ phase: status.phase, rowCount: transcript.rows.length })).toBe(false);
  expect(shown(screen)).toContain("ok:hi");
  await laptopTurn(prompt);
  await until(() => shown(screen).includes(`ok:${prompt}`));
}

describe("a session opened while another holder follows it", () => {
  test("B: a new screen's open before the old screen's leave", async () => {
    const r = await rig();
    const old = r.screen();
    await old.open();
    const top = r.screen();
    await top.open();
    await old.leave();
    old.dispose();
    await expectAlive(top, r.laptopTurn, "later");
    expect(r.controller.follows(r.sid)).toBe(true);
    await top.leave();
    top.dispose();
    expect(r.controller.follows(r.sid)).toBe(false);
    r.close();
  });

  test("C: a workflow screen opened it without a watch; its handle survives the screen", async () => {
    const r = await rig();
    const workflow = await r.controller.open(r.sid);
    expect(workflow.ok).toBe(true);
    const top = r.screen();
    await top.open();
    await expectAlive(top, r.laptopTurn, "later");
    await top.leave();
    top.dispose();
    // Back on the workflow screen: still attached, nothing was detached.
    expect(r.controller.follows(r.sid)).toBe(true);
    expect(r.detaches()).toBe(0);
    // "Open the session" a second time: the history is spent, so a re-attach.
    const again = r.screen();
    await again.open();
    await expectAlive(again, r.laptopTurn, "again");
    // And the screen's own resync still re-reads on that held entry.
    const before = r.detaches();
    await again.resync();
    expect(r.detaches()).toBe(before + 1);
    await expectAlive(again, r.laptopTurn, "resynced");
    await again.leave();
    again.dispose();
    await r.controller.leave(r.sid); // the workflow screen goes away
    expect(r.controller.follows(r.sid)).toBe(false);
    r.close();
  });

  test("D: a second screen pushed over the first", async () => {
    const r = await rig();
    const lower = r.screen();
    await lower.open();
    const top = r.screen();
    await top.open();
    await expectAlive(top, r.laptopTurn, "later");
    // The lower screen's own leave releases nothing of the top one's.
    await lower.leave();
    lower.dispose();
    expect(r.controller.follows(r.sid)).toBe(true);
    await r.laptopTurn("last");
    await until(() => shown(top).includes("ok:last"));
    await top.leave();
    top.dispose();
    r.close();
  });
});
