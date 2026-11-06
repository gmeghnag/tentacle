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

/**
 * A daemon whose open answers at once (a live session: `resync`), and whose
 * snapshot pages the test serves by hand, one held request at a time.
 */
function pagedDaemon() {
  const [d, c] = createChannelPair();
  const held: { id: number; cursor?: string }[] = [];
  let opens = 0;
  const reply = (id: number, result: unknown): void =>
    d.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  d.setOnMessage((data: string) => {
    const frame = JSON.parse(data) as {
      id: number;
      method?: string;
      params?: { cursor?: string };
    };
    if (frame.method === "initialize") {
      reply(frame.id, {
        protocolVersion: PROTOCOL_VERSION,
        agentCapabilities: { tools: true, permissions: true },
      });
    } else if (frame.method === "session/open") {
      opens += 1;
      reply(frame.id, { sessionId: "S", epoch: "e1", created: false, resync: true });
    } else if (frame.method === "session/snapshot") {
      held.push({
        id: frame.id,
        ...(frame.params?.cursor !== undefined ? { cursor: frame.params.cursor } : {}),
      });
    }
  });
  d.setOnClose(() => {});
  return {
    channel: c,
    held,
    opens: () => opens,
    /** Answer the held page; `more`: another page follows. */
    page(n: number, more: boolean): void {
      const asked = held.shift();
      if (asked === undefined) throw new Error("no page asked");
      reply(asked.id, {
        messages: [{ role: "user", content: `m${n}` }],
        ...(asked.cursor === undefined ? { since: { epoch: "e1", seq: 0 } } : {}),
        ...(more ? { cursor: `c${n}` } : {}),
      });
    },
    chatter(): void {
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

describe("the attach bound waits for an answer, not for the transfer (F1)", () => {
  const start = (channel: DuplexChannel, redial: () => Promise<DuplexChannel>) => {
    const time = manualClock();
    const client = new RemoteClient(channel, new PermissionBroker(), undefined, {
      channelFactory: redial,
      clock: time.clock,
      random: () => 0,
    });
    const state: { outcome: unknown } = { outcome: "pending" };
    const attach = async (): Promise<void> => {
      await client.initialize();
      void client.attachSession("S", listener).then(
        (id) => {
          state.outcome = id;
        },
        (e: unknown) => {
          state.outcome = e;
        },
      );
      await tick();
    };
    /** `seconds` of the clock, a second and a tick at a time. */
    const pass = async (seconds: number, each: () => void = () => {}): Promise<void> => {
      for (let i = 0; i < seconds; i++) {
        each();
        await tick();
        time.advance(1000);
        await tick();
      }
    };
    return { client, state, attach, pass };
  };
  const noRedial = (): Promise<DuplexChannel> => Promise.reject(new Error("unused"));

  test("a slow attach that keeps getting pages survives well past the bound and goes live", async () => {
    // Round 1 (one fixed deadline) rejects it at 30 s, on the third page.
    const daemon = pagedDaemon();
    const { client, state, attach, pass } = start(daemon.channel, noRedial);
    await attach();
    for (let n = 1; n <= 5; n++) {
      await pass(10);
      expect(state.outcome).toBe("pending");
      daemon.page(n, n < 5);
      await tick();
      await tick();
    }
    expect(state.outcome).toBe("S");
    expect(client.liveSessionIds()).toEqual(["S"]);
    client.close();
  });

  test("the open answered, then no page: fails one whole bound after the answer", async () => {
    const daemon = pagedDaemon();
    const { client, state, attach, pass } = start(daemon.channel, noRedial);
    await attach();
    await pass(29, () => daemon.chatter());
    expect(state.outcome).toBe("pending");
    await pass(2, () => daemon.chatter());
    expect(state.outcome).toBeInstanceOf(AttachTimeoutError);
    expect(client.liveSessionIds()).toEqual([]);
    client.close();
  });

  test("some pages, then a stall: fails one whole bound after the LAST page", async () => {
    // Round 1: it fails at t=30, 10 s after the page.
    const daemon = pagedDaemon();
    const { client, state, attach, pass } = start(daemon.channel, noRedial);
    await attach();
    await pass(20, () => daemon.chatter());
    daemon.page(1, true);
    await tick();
    await tick();
    await pass(29, () => daemon.chatter());
    expect(state.outcome).toBe("pending"); // t=49: 29 s after the page
    await pass(2, () => daemon.chatter());
    expect(state.outcome).toBeInstanceOf(AttachTimeoutError);
    client.close();
  });

  test("a daemon that answers every re-open but never a page is not progress: the bound still ends it", async () => {
    // Mutation: count every answered open as progress → the reconnects re-arm it for ever.
    const first = pagedDaemon();
    const daemons = [first];
    const { client, state, attach, pass } = start(first.channel, async () => {
      const next = pagedDaemon();
      daemons.push(next);
      return next.channel;
    });
    await attach();
    await pass(29); // silence: liveness closes the link at 15 s, the redial re-opens
    expect(daemons.reduce((sum, d) => sum + d.opens(), 0)).toBeGreaterThan(1);
    expect(state.outcome).toBe("pending");
    await pass(3);
    expect(state.outcome).toBeInstanceOf(AttachTimeoutError);
    client.close();
  });
});
