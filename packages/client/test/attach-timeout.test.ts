/**
 * The eager attach is bounded (docs/feat/session-settings-apply.md S3): a
 * daemon that never answers `session/open` (or a link that never comes back)
 * rejects the attach at `ATTACH_TIMEOUT_MS` instead of hanging the pre-mount
 * terminal for ever.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { ATTACH_TIMEOUT_MS } from "../src/constants.ts";
import { AttachTimeoutError, type Clock, RemoteClient } from "../src/remote-client.ts";

const noopEnv = { id: "noop" } as unknown as ExecutionEnvironment;
const quiet: ModelProvider = {
  id: "quiet",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  },
};

function manualClock() {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: Clock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      next += 1;
      timers.set(next, { at: now + ms, fn });
      return next;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return {
    clock,
    advance(ms: number): void {
      now += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) return;
        timers.delete(due[0]);
        due[1].fn();
      }
    },
  };
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

/**
 * A daemon that answers `initialize` (so the link is up) and, every second, a
 * stray notification (so liveness never trips), but never answers `session/open`.
 * `answerAt`: a callback that answers the held open later.
 */
function silentDaemon() {
  const [d, c] = createChannelPair();
  const held: number[] = [];
  d.setOnMessage((data: string) => {
    const frame = JSON.parse(data) as { id: number; method?: string };
    if (frame.method === "initialize") {
      d.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: frame.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          },
        }),
      );
    } else if (frame.method === "session/open") {
      held.push(frame.id);
    }
  });
  d.setOnClose(() => {});
  return {
    channel: c,
    held,
    answerOpen(id: number) {
      d.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { sessionId: "S", epoch: "e1", created: false, resync: false },
        }),
      );
    },
    chatter() {
      d.send(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "$/progress",
          params: { id: "x", seq: 0, value: {} },
        }),
      );
    },
  };
}

const listener = { output: () => {}, linkClosed: () => {} } as never;

describe("attachSession is bounded (S3)", () => {
  test("T17 a daemon that never answers the open: rejects at the bound, not before; a late answer changes nothing", async () => {
    const time = manualClock();
    const daemon = silentDaemon();
    const client = new RemoteClient(daemon.channel, new PermissionBroker(), undefined, {
      channelFactory: async (): Promise<DuplexChannel> => silentDaemon().channel,
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    let outcome: unknown = "pending";
    void client.attachSession("S", listener).then(
      (v) => {
        outcome = v;
      },
      (e: unknown) => {
        outcome = e;
      },
    );
    await tick();
    // Keep the link alive with chatter: only the attach bound can end this.
    for (let elapsed = 0; elapsed < ATTACH_TIMEOUT_MS - 1000; elapsed += 1000) {
      daemon.chatter();
      await tick();
      time.advance(1000);
      await tick();
    }
    expect(outcome).toBe("pending");
    daemon.chatter();
    time.advance(1000);
    await tick();
    expect(outcome).toBeInstanceOf(AttachTimeoutError);
    expect((outcome as Error).message).toBe("no answer from the daemon within 30s (session/open)");
    expect(client.liveSessionIds()).toEqual([]);
    // The held open answers late: ignored.
    const [heldId] = daemon.held;
    if (heldId !== undefined) daemon.answerOpen(heldId);
    await tick();
    expect(client.liveSessionIds()).toEqual([]);
    client.close();
  });

  test("T17 a link that never comes back: rejects at the bound too", async () => {
    const time = manualClock();
    const daemon = silentDaemon();
    const client = new RemoteClient(daemon.channel, new PermissionBroker(), undefined, {
      // Every redial fails: before the bound, the attach waited for ever.
      channelFactory: () => Promise.reject(new Error("pod gone")),
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    let outcome: unknown = "pending";
    void client.attachSession("S", listener).catch((e: unknown) => {
      outcome = e;
    });
    await tick();
    daemon.channel.close();
    for (let elapsed = 0; elapsed <= ATTACH_TIMEOUT_MS; elapsed += 500) {
      time.advance(500);
      await tick();
    }
    expect(outcome).toBeInstanceOf(AttachTimeoutError);
    client.close();
  });

  test("T18 an attach answered in time is not rejected when the clock passes the bound", async () => {
    const time = manualClock();
    const host = new SessionHost({
      defaultCwd: "/tmp/w",
      createAgent: () => ({
        agent: new Agent({ model: quiet, tools: new ToolRegistry(), env: noopEnv }),
        permissions: new PermissionBroker(),
      }),
    });
    const dial = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      return c;
    };
    const owner = new RemoteClient(dial(), new PermissionBroker());
    await owner.initialize();
    await owner.openSession(undefined, undefined, "S");
    const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
      channelFactory: async () => dial(),
      clock: time.clock,
      random: () => 0,
    });
    await client.initialize();
    let failed: unknown = null;
    await client.attachSession("S", listener).catch((e: unknown) => {
      failed = e;
    });
    time.advance(ATTACH_TIMEOUT_MS * 2);
    await tick();
    expect(failed).toBeNull();
    expect(client.liveSessionIds()).toEqual(["S"]);
    owner.close();
    client.close();
  });
});
