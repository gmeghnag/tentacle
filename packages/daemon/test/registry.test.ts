import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  type HistoryCut,
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection, type ConnectionOptions } from "../src/connection.ts";
import { type Attachment, HostedSession, type UpdateSink } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

// Session ownership moved from `Connection` to `SessionHost` (the registry):
// detach on disconnect, `session/open` (attach + replay, or create),
// `session/close`, fan-out to every attached client. Each test names the
// mutation that must turn it red (AGENTS §9).

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.reject(new Error("unused")),
  readFile: () => Promise.reject(new Error("unused")),
  writeFile: () => Promise.reject(new Error("unused")),
};

/** `n` text chunks, one per macrotask, then done: a turn long enough to drop mid-way. */
function slowModel(n: number): ModelProvider {
  return {
    id: "slow",
    async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
      for (let i = 0; i < n; i++) {
        await tick();
        yield { type: "text", delta: `c${i} ` };
      }
      yield { type: "done" };
    },
  };
}

/** Parks on a gate after its first chunk; `release()` then yields a burst with no awaits. */
class BurstModel implements ModelProvider {
  readonly id = "burst";
  release: () => void = () => {};
  readonly parked: Promise<void>;
  private onParked: () => void = () => {};
  constructor(private readonly burst: number) {
    this.parked = new Promise((r) => {
      this.onParked = r;
    });
  }
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "first " };
    await new Promise<void>((r) => {
      this.release = r;
      this.onParked();
    });
    for (let i = 0; i < this.burst; i++) yield { type: "text", delta: `b${i} ` };
    yield { type: "done" };
  }
}

class FakeJobs implements JobController {
  disposed = 0;
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  get listenerCount(): number {
    return this.listeners.size;
  }
  fire(id: string): void {
    const job: BackgroundJob = { id, command: "x", startedAt: 0, status: "exited", exitCode: 0 };
    for (const l of this.listeners) l(job);
  }
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read() {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {
    this.disposed++;
  }
}

/** A daemon (one `SessionHost`, a spy factory) that any number of clients connect to. */
function daemon(model: () => ModelProvider, env: ExecutionEnvironment = noopEnv) {
  const jobs: FakeJobs[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/registry",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const j = new FakeJobs();
      jobs.push(j);
      const agent = new Agent({
        model: model(),
        tools: new ToolRegistry().register(shellTool),
        env,
        jobs: j,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions, jobs: j };
    },
  });
  const connect = async (
    options: ConnectionOptions = {},
    onRequest?: (method: string, params: unknown) => Promise<unknown>,
  ) => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host, undefined, options);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      ...(onRequest ? { onRequest } : {}),
    });
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown>) =>
      client.request("session/open", params) as Promise<OpenResult>;
    const prompt = (sessionId: string, turnId: string) =>
      client.request("session/prompt", {
        sessionId,
        turnId,
        content: [{ type: "text", text: "go" }],
      });
    return { connection, client, updates, open, prompt };
  };
  return { host, jobs, connect };
}

const seqs = (updates: readonly KnownSessionUpdateParams[]): number[] => updates.map((u) => u.seq);
const types = (updates: readonly KnownSessionUpdateParams[]): string[] =>
  updates.map((u) => u.update.type);
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}
const ended = (updates: readonly KnownSessionUpdateParams[]): boolean =>
  updates.some((u) => u.update.type === "turn_end");

describe("detach on disconnect + re-attach (the parent repro, inverted)", () => {
  test("drop mid-turn: the turn runs to its end; a new connection replays the gap — nothing lost or doubled", async () => {
    // Mutation: `Connection.close()` cancels its sessions again → turn_end cancelled.
    const d = daemon(() => slowModel(20));
    const a = await d.connect();
    const opened = await a.open({ sessionId: "X", create: true });
    expect(opened).toMatchObject({ sessionId: "X", created: true, resync: false });
    await a.prompt("X", "t1");
    await until(() => a.updates.length >= 5);
    a.connection.close();
    const lastA = a.updates.at(-1)?.seq ?? 0;
    expect(d.host.get("X")?.running).toBe(true); // still running, unattached

    const b = await d.connect();
    const reopened = await b.open({ sessionId: "X", since: { epoch: opened.epoch, seq: lastA } });
    expect(reopened).toMatchObject({ created: false, resync: false, epoch: opened.epoch });
    await until(() => ended(b.updates));

    const all = [...seqs(a.updates), ...seqs(b.updates)];
    expect(all).toEqual(Array.from({ length: all.length }, (_, i) => i + 1));
    expect(b.updates.at(-1)?.update).toEqual({
      type: "turn_end",
      turnId: "t1",
      stopReason: "end_turn",
    });
    expect(types(b.updates).filter((t) => t === "agent_message_chunk")).toHaveLength(
      20 - types(a.updates).filter((t) => t === "agent_message_chunk").length,
    );
  });

  test("open with an uncovered `since` → resync + everything after the cut; snapshot + buffer is complete", async () => {
    const d = daemon(() => slowModel(3));
    const a = await d.connect();
    await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => ended(a.updates));
    const b = await d.connect();
    const r = await b.open({ sessionId: "X", since: { epoch: "not-this-one", seq: 1 } });
    expect(r.resync).toBe(true);
    // Idle at the cut: nothing after it — the snapshot alone is the state.
    expect(b.updates).toEqual([]);
    const snap = (await b.client.request("session/snapshot", { sessionId: "X" })) as {
      since: HistoryCut;
    };
    expect(snap.since).toEqual({ epoch: r.epoch, seq: a.updates.length });
  });
});

describe("attach atomicity (replay + live in one synchronous step)", () => {
  test("an open landing anywhere inside a microtask-only burst gets every update once, contiguously", async () => {
    // Mutation: add the attachment on a microtask after sending the replay
    // (= an `await` between the two) → a gap.
    for (let k = 0; k < 60; k++) {
      const model = new BurstModel(40);
      const d = daemon(() => model);
      const a = await d.connect();
      const { epoch } = await a.open({ sessionId: "X", create: true });
      const b = await d.connect();
      await a.prompt("X", "t1");
      await model.parked;
      await tick(); // the first chunk is streamed; the burst is parked
      model.release();
      for (let j = 0; j < k; j++) await Promise.resolve();
      const since = a.updates.at(-1)?.seq ?? 0;
      await b.open({ sessionId: "X", since: { epoch, seq: since } });
      await until(() => ended(b.updates));
      const got = seqs(b.updates);
      const last = a.updates.at(-1)?.seq ?? -1;
      expect({ k, got }).toEqual({
        k,
        got: Array.from({ length: last - since }, (_, i) => since + 1 + i),
      });
    }
  });
});

describe("one session per id (the clobber is impossible by construction)", () => {
  test("two concurrent opens of one absent id build ONE agent; the second attaches", async () => {
    // Mutation: drop the live check in `SessionHost.open` → two agents.
    const d = daemon(() => slowModel(1));
    const a = await d.connect();
    const b = await d.connect();
    const [ra, rb] = await Promise.all([
      a.open({ sessionId: "X", create: true }),
      b.open({ sessionId: "X", create: true }),
    ]);
    expect(d.jobs).toHaveLength(1);
    expect([ra.created, rb.created].sort()).toEqual([false, true]);
    expect((ra.created ? rb : ra).resync).toBe(true);
    expect(ra.epoch).toBe(rb.epoch);
    await a.open({ sessionId: "X", create: true, messages: [{ role: "user", content: "x" }] });
    expect(d.jobs).toHaveLength(1);
    expect(d.host.get("X")?.attachedCount).toBe(2);
  });

  test("open of an id that is not live, without create or messages → UnknownSession", async () => {
    const d = daemon(() => slowModel(1));
    const a = await d.connect();
    await expect(a.open({ sessionId: "gone" })).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    expect(d.jobs).toHaveLength(0);
    // No id at all: the daemon picks one and creates.
    const r = await a.open({});
    expect(r.created).toBe(true);
    expect(d.host.get(r.sessionId)).toBeDefined();
  });
});

describe("fan-out", () => {
  test("two attached clients receive the identical, contiguous stream", async () => {
    // Mutation: single-sink semantics (clear the set before adding) → A misses events.
    const d = daemon(() => slowModel(5));
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "X", create: true });
    await b.open({ sessionId: "X" });
    await b.prompt("X", "t1");
    await until(() => ended(a.updates) && ended(b.updates));
    expect(seqs(a.updates)).toEqual(seqs(b.updates));
    expect(seqs(a.updates)).toEqual(Array.from({ length: a.updates.length }, (_, i) => i + 1));
  });

  test("the same connection opening twice never doubles the stream", async () => {
    // Mutation: skip the pre-detach in `Connection.open` → every update twice.
    const d = daemon(() => slowModel(5));
    const a = await d.connect();
    await a.open({ sessionId: "X", create: true });
    await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => ended(a.updates));
    await tick(5);
    expect(seqs(a.updates)).toEqual(Array.from({ length: a.updates.length }, (_, i) => i + 1));
    expect(d.host.get("X")?.attachedCount).toBe(1);
  });

  test("a command needs an open on THIS connection, even if the session is live", async () => {
    // Mutation: look up through the host only → B drives a stream it does not receive.
    const d = daemon(() => slowModel(1));
    const a = await d.connect();
    await a.open({ sessionId: "X", create: true });
    const b = await d.connect();
    await expect(b.prompt("X", "t1")).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
  });

  test("the steering no-await window survives fan-out to a slow and a fast client", async () => {
    // Mutation: make the fan-out await each send → `turn_end` reaches the fast
    // client only after the next macrotask: an enqueue could slip in.
    const agent = new Agent({
      model: {
        id: "one",
        async *stream() {
          yield { type: "text", delta: "hi" };
          yield { type: "done" };
        },
      },
      tools: new ToolRegistry(),
      env: noopEnv,
    });
    const runMessages = agent.runMessages.bind(agent);
    const hosted = new HostedSession("s1", new Session(agent), new PermissionBroker());
    const fast: KnownSessionUpdateParams[] = [];
    const attach = (send: UpdateSink): Attachment => ({
      send,
    });
    // A sink that "returns" a promise settled on a macrotask (a slow transport).
    hosted.attach(attach((() => new Promise((r) => setTimeout(r, 0))) as unknown as UpdateSink));
    hosted.attach(attach((p) => fast.push(p)));
    const atNextMacrotask: { running: boolean; ended: boolean }[] = [];
    agent.runMessages = (messages, sessionId, signal, drain) =>
      runMessages(messages, sessionId, signal, () => {
        setTimeout(() => atNextMacrotask.push({ running: hosted.running, ended: ended(fast) }), 0);
        return drain?.() ?? [];
      });
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await tick(5);
    expect(atNextMacrotask.at(-1)).toEqual({ running: false, ended: true });
  });
});

describe("session/close", () => {
  test("closes for everyone: session_closed, jobs disposed and unsubscribed, id forgotten; idempotent", async () => {
    // Mutations (each fails one assertion): drop the `dispose`; drop the
    // `onExit` unsubscribe; drop the `session_closed` emit.
    const d = daemon(() => slowModel(1));
    const a = await d.connect();
    const b = await d.connect();
    const first = await a.open({ sessionId: "X", create: true });
    await b.open({ sessionId: "X" });
    const jobs = d.jobs[0];
    if (!jobs) throw new Error("no jobs");

    const listening = jobs.listenerCount; // the session's, plus the agent's own
    expect(await a.client.request("session/close", { sessionId: "X" })).toEqual({});
    await tick();
    expect(b.updates.at(-1)?.update).toEqual({ type: "session_closed", reason: "closed" });
    expect(b.updates.at(-1)?.mandatory).toBe(true);
    expect(jobs.disposed).toBe(1);
    expect(jobs.listenerCount).toBe(listening - 1); // the session stopped listening
    const before = b.updates.length;
    jobs.fire("j1"); // a late exit of a killed job: nobody hears it
    await tick();
    expect(b.updates.length).toBe(before);
    expect(d.host.get("X")).toBeUndefined();

    // Idempotent, needs no open, unknown ids are fine.
    expect(await a.client.request("session/close", { sessionId: "X" })).toEqual({});
    expect(await b.client.request("session/close", { sessionId: "never" })).toEqual({});
    expect(jobs.disposed).toBe(1);

    await expect(b.prompt("X", "t1")).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    await expect(b.open({ sessionId: "X" })).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    const again = await b.open({ sessionId: "X", messages: [{ role: "user", content: "hi" }] });
    expect(again.created).toBe(true);
    expect(again.epoch).not.toBe(first.epoch);
  });

  test("close during a turn: every attached client gets turn_end{cancelled} THEN session_closed", async () => {
    // Mutation: drop the synchronous `finishTurn` in `HostedSession.close` →
    // the turn's end is emitted after the detach: B never sees it (a hang).
    const d = daemon(() => slowModel(50));
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "X", create: true });
    await b.open({ sessionId: "X" });
    await a.prompt("X", "t1");
    await until(() => b.updates.length >= 3);
    await a.client.request("session/close", { sessionId: "X" });
    await tick(20);
    expect(types(b.updates).slice(-2)).toEqual(["turn_end", "session_closed"]);
    expect(b.updates.at(-2)?.update).toMatchObject({ turnId: "t1", stopReason: "cancelled" });
    expect(seqs(b.updates)).toEqual(Array.from({ length: b.updates.length }, (_, i) => i + 1));
  });

  test("a stale attachment never drives the recreated session", async () => {
    // Mutation: look up without the identity check → A prompts B's new session.
    const d = daemon(() => slowModel(1));
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "X", create: true });
    await b.client.request("session/close", { sessionId: "X" });
    await b.open({ sessionId: "X", create: true });
    await expect(a.prompt("X", "t1")).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    expect(d.host.get("X")?.running).toBe(false);
    expect(d.host.get("X")?.attachedCount).toBe(1); // A's stale entry is gone
  });

  test("a `since` from the previous incarnation of an id resyncs, even past its seq", async () => {
    // Mutation: a fixed epoch per session (not a fresh UUID) → resync: false, a wrong replay.
    const d = daemon(() => slowModel(2));
    const a = await d.connect();
    const old = await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => ended(a.updates));
    const oldSince = { epoch: old.epoch, seq: 2 };
    await a.client.request("session/close", { sessionId: "X" });
    const b = await d.connect();
    await b.open({ sessionId: "X", create: true });
    await b.prompt("X", "t2");
    await until(() => ended(b.updates));
    expect(b.updates.length).toBeGreaterThan(oldSince.seq);
    const c = await d.connect();
    expect((await c.open({ sessionId: "X", since: oldSince })).resync).toBe(true);
  });
});

describe("the model-serving connection (`--model-proxy`)", () => {
  test("its detach cancels the turn; the session stays, and a re-attach replays turn_end{cancelled}", async () => {
    // Mutation: ignore `servesModel` → the turn runs to end_turn.
    const d = daemon(() => slowModel(50));
    const a = await d.connect({ servesModel: true });
    const { epoch } = await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => a.updates.length >= 3);
    const lastA = a.updates.at(-1)?.seq ?? 0;
    a.connection.close();
    await until(() => d.host.get("X")?.running === false);
    expect(d.host.get("X")).toBeDefined();
    const b = await d.connect();
    await b.open({ sessionId: "X", since: { epoch, seq: lastA } });
    expect(b.updates.at(-1)?.update).toMatchObject({ type: "turn_end", stopReason: "cancelled" });
  });

  test("a plain connection's detach does not cancel", async () => {
    const d = daemon(() => slowModel(5));
    const a = await d.connect();
    const { epoch } = await a.open({ sessionId: "X", create: true });
    await a.prompt("X", "t1");
    await until(() => a.updates.length >= 2);
    a.connection.close();
    await until(() => d.host.get("X")?.running === false);
    const b = await d.connect();
    await b.open({ sessionId: "X", since: { epoch, seq: 0 } });
    expect(types(b.updates)).toContain("turn_end");
    expect(b.updates.at(-1)?.update).toMatchObject({ stopReason: "end_turn" });
  });
});
