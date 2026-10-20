import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { BackgroundJobs, HostExecution } from "@tentacle/exec";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { DomainErrorCode, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import type { Attachment } from "../src/hosted-session.ts";
import { SessionHost, type SessionHostOptions } from "../src/session-host.ts";
import {
  type ReapPolicy,
  type ReapReason,
  type SessionLiveness,
  selectExpired,
  startReaper,
} from "../src/session-reaper.ts";

// Detached-session TTL, the opt-in admin cap and daemon-wide limits
// (docs/feat/session-ttl-limits.md). Time is an injected clock (`t`), never a
// fake timer. Each test names the mutation that must turn it red (AGENTS §9).

const H = 60 * 60 * 1000;
const TTL = 24 * H;
const POLICY: ReapPolicy = { idleTtlMs: TTL };
const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const tick = (ms = 1): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await tick();
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.reject(new Error("unused")),
  readFile: () => Promise.reject(new Error("unused")),
  writeFile: () => Promise.reject(new Error("unused")),
};

/** Each model call waits for `release()`, then answers "ok". */
class GatedModel implements ModelProvider {
  readonly id = "gated";
  calls = 0;
  private gates: (() => void)[] = [];
  release(): void {
    for (const open of this.gates.splice(0)) open();
  }
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls++;
    await new Promise<void>((r) => this.gates.push(r));
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

class FakeJobs implements JobController {
  throwOnDispose = false;
  disposed = 0;
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  fire(id: string): void {
    const job: BackgroundJob = { id, command: "x", startedAt: 0, status: "exited", exitCode: 0 };
    for (const l of [...this.listeners]) l(job);
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
    if (this.throwOnDispose) throw new Error("dispose failed");
  }
}

/** A daemon on an injected clock; any number of clients connect to it. */
function daemon(
  opts: {
    model?: () => ModelProvider;
    jobs?: () => JobController;
    host?: Partial<SessionHostOptions>;
  } = {},
) {
  const clock = { t: 0 };
  const jobs: JobController[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/reaper",
    now: () => clock.t,
    ...opts.host,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const j = opts.jobs ? opts.jobs() : new FakeJobs();
      jobs.push(j);
      const agent = new Agent({
        model: opts.model ? opts.model() : new GatedModel(),
        tools: new ToolRegistry(),
        env: noopEnv,
        jobs: j,
        requestPermission: (req) => permissions.request(req),
      });
      return { agent, permissions, jobs: j };
    },
  });
  const connect = async () => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
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
  const reap = (policy: ReapPolicy = POLICY) => host.reapExpired(policy);
  return { host, jobs, clock, connect, reap };
}

const live = (over: Partial<SessionLiveness>): SessionLiveness => ({
  id: "s",
  attached: 0,
  busy: false,
  lastActiveAt: 0,
  lastDetachAt: 0,
  ...over,
});

describe("selectExpired (pure rules)", () => {
  test("the TTL boundary, attached, busy, admin cap, precedence", () => {
    // Mutation: drop the `busy` check → the 30-day busy row is reaped.
    // Mutation: `>` instead of `>=` → the exact-TTL row is kept.
    const cap: ReapPolicy = { idleTtlMs: TTL, adminCapMs: 48 * H };
    const rows: [SessionLiveness, number, ReapPolicy, ReapReason | null][] = [
      [live({}), TTL, POLICY, "idle_ttl"],
      [live({}), TTL - 1, POLICY, null],
      [live({ attached: 1 }), 999 * H, POLICY, null],
      [live({ attached: 1 }), 999 * H, cap, null],
      [live({ busy: true }), 30 * 24 * H, POLICY, null],
      [live({ busy: true }), 48 * H, cap, "admin_cap"],
      [live({ busy: true }), 48 * H - 1, cap, null],
      [live({}), 48 * H, cap, "idle_ttl"],
      [live({ lastActiveAt: 30 * H }), 48 * H, cap, "admin_cap"],
    ];
    for (const [session, now, policy, want] of rows) {
      const got = selectExpired([session], now, policy);
      expect({ session, now, got: got[0]?.reason ?? null }).toEqual({ session, now, got: want });
    }
  });

  test("returns every expired session, by id", () => {
    const got = selectExpired(
      [live({ id: "a" }), live({ id: "b", attached: 1 }), live({ id: "c" })],
      TTL,
      POLICY,
    );
    expect(got).toEqual([
      { id: "a", reason: "idle_ttl" },
      { id: "c", reason: "idle_ttl" },
    ]);
  });
});

describe("SessionHost.reapExpired (the sweep)", () => {
  test("load-bearing: reaping a detached session kills its background job's whole tree", async () => {
    // Mutation: `reapExpired` deletes from the registry without `close` → the
    // job's `sleep` survives (`pgrep` finds it).
    const m = `3${Math.floor(Math.random() * 900000 + 100000)}`;
    const alive = (): number =>
      Bun.spawnSync(["pgrep", "-f", `sleep ${m}`])
        .stdout.toString()
        .trim()
        .split("\n")
        .filter(Boolean).length;
    // Grace ≫ the 2 s wait: only the group SIGTERM from `close` can pass.
    const d = daemon({
      jobs: () => new BackgroundJobs(new HostExecution({ killGraceMs: 10_000 })),
    });
    try {
      const a = await d.connect();
      const { sessionId } = await a.open({ create: true });
      d.jobs[0]?.start(`sleep ${m}; true`);
      await until(() => alive() === 2, 2000); // sh + sleep
      a.connection.close();
      d.clock.t = TTL;
      expect(d.reap()).toEqual([{ id: sessionId, reason: "idle_ttl" }]);
      expect(d.host.get(sessionId)).toBeUndefined();
      await until(() => alive() === 0, 2000);
    } finally {
      Bun.spawnSync(["pkill", "-9", "-f", `sleep ${m}`]);
    }
  });

  test("a running turn is never reaped; the TTL counts from the turn's end", async () => {
    // Mutation: stamp only at detach (not when the busy slot is released) →
    // reaped at turnEnd + TTL - 1.
    const model = new GatedModel();
    const d = daemon({ model: () => model });
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    await a.prompt(sessionId, "t1");
    await until(() => model.calls === 1);
    d.clock.t = 1 * H;
    a.connection.close();
    d.clock.t = 25 * H;
    expect(d.reap()).toEqual([]);
    expect(d.host.get(sessionId)?.running).toBe(true);
    d.clock.t = 40 * H;
    model.release();
    await until(() => d.host.get(sessionId)?.running === false);
    d.clock.t = 40 * H + TTL - 1;
    expect(d.reap()).toEqual([]);
    d.clock.t = 40 * H + TTL;
    expect(d.reap()).toEqual([{ id: sessionId, reason: "idle_ttl" }]);
  });

  test("a turn that ends while still attached does not start the TTL; the detach does", async () => {
    // Mutation: stamp only when the busy slot is released (not at detach) →
    // quiet since the turn's end at ~0 → reaped right after the detach at 100 h.
    const model = new GatedModel();
    const d = daemon({ model: () => model });
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    await a.prompt(sessionId, "t1");
    await until(() => model.calls === 1);
    model.release();
    await until(() => d.host.get(sessionId)?.running === false);
    d.clock.t = 100 * H;
    expect(d.reap()).toEqual([]); // attached: never
    a.connection.close();
    d.clock.t = 100 * H + TTL - 1;
    expect(d.reap()).toEqual([]);
    d.clock.t = 100 * H + TTL;
    expect(d.reap()).toEqual([{ id: sessionId, reason: "idle_ttl" }]);
  });

  test("a compaction counts as busy; the TTL counts from its end", async () => {
    // Mutation: no stamp in `compact`'s `finally` → quiet since the detach at
    // 1 h → reaped at 40 h + TTL - 1.
    const model = new GatedModel();
    const d = daemon({ model: () => model });
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    await a.prompt(sessionId, "t1");
    await until(() => model.calls === 1);
    model.release();
    await until(() => d.host.get(sessionId)?.running === false);
    const compacted = a.client.request("session/compact", { sessionId }).catch(() => {});
    await until(() => model.calls === 2); // the summary call, gated
    d.clock.t = 1 * H;
    a.connection.close();
    d.clock.t = 30 * H;
    expect(d.reap()).toEqual([]); // compacting: busy
    d.clock.t = 40 * H;
    model.release();
    await until(() => d.host.get(sessionId)?.running === false);
    void compacted;
    d.clock.t = 40 * H + TTL - 1;
    expect(d.reap()).toEqual([]);
    d.clock.t = 40 * H + TTL;
    expect(d.reap()).toEqual([{ id: sessionId, reason: "idle_ttl" }]);
  });

  test("a re-attach resets the TTL", async () => {
    // Mutation: don't stamp on detach → reaped at 46 h (24 h after creation).
    const d = daemon();
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    a.connection.close(); // detached at 0
    d.clock.t = 23 * H;
    const b = await d.connect();
    await b.open({ sessionId });
    b.connection.close(); // detached at 23 h
    d.clock.t = 46 * H;
    expect(d.reap()).toEqual([]);
    d.clock.t = 47 * H;
    expect(d.reap()).toEqual([{ id: sessionId, reason: "idle_ttl" }]);
  });

  test("a sink dropped because it threw counts as a detach (stamped then)", async () => {
    // Mutation: no stamp in `emit`'s throwing-sink removal → reaped at 24 h
    // from creation although it was attached until 10 h.
    const d = daemon();
    const { hosted } = d.host.open(
      { create: true },
      {
        send: () => {
          throw new Error("broken sink");
        },
      },
    );
    d.clock.t = 10 * H;
    (d.jobs[0] as FakeJobs).fire("bg-1"); // an update → the sink throws → dropped
    expect(hosted.attachedCount).toBe(0);
    d.clock.t = 10 * H + TTL - 1;
    expect(d.reap()).toEqual([]);
    d.clock.t = 10 * H + TTL;
    expect(d.reap()).toEqual([{ id: hosted.id, reason: "idle_ttl" }]);
  });

  test("the admin cap closes a busy detached session (opt-in), with session_closed and the turn cancelled", async () => {
    const model = new GatedModel();
    const d = daemon({ model: () => model });
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    await a.prompt(sessionId, "t1");
    await until(() => model.calls === 1);
    a.connection.close();
    d.clock.t = 30 * 24 * H;
    expect(d.reap()).toEqual([]); // off by default: never, however long
    const hosted = d.host.get(sessionId);
    expect(d.reap({ idleTtlMs: TTL, adminCapMs: 30 * 24 * H })).toEqual([
      { id: sessionId, reason: "admin_cap" },
    ]);
    expect(hosted?.running).toBe(false);
    expect((d.jobs[0] as FakeJobs).disposed).toBe(1);
  });

  test("one session whose close throws does not stop the sweep; the error is reported", () => {
    // Mutation: no per-session try/catch → the throw escapes, `b` survives.
    const d = daemon();
    const sink: Attachment = {
      send: () => {},
    };
    d.host.open({ sessionId: "a", create: true }, sink);
    d.host.open({ sessionId: "b", create: true }, sink);
    (d.jobs[0] as FakeJobs).throwOnDispose = true;
    d.host.get("a")?.detach(sink);
    d.host.get("b")?.detach(sink);
    d.clock.t = TTL;
    const errors: string[] = [];
    const reaped = d.host.reapExpired(POLICY, (e) => errors.push(e.message));
    expect(reaped.map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect(errors).toEqual(["dispose failed"]);
    expect(d.host.size).toBe(0);
  });
});

describe("reaper vs re-attach (both synchronous: one runs first)", () => {
  test("open first: the session is attached, the sweep skips it, updates flow", async () => {
    const model = new GatedModel();
    const d = daemon({ model: () => model });
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    a.connection.close();
    d.clock.t = TTL;
    const b = await d.connect();
    await b.open({ sessionId });
    expect(d.reap()).toEqual([]);
    await b.prompt(sessionId, "t1");
    await until(() => model.calls === 1);
    model.release();
    await until(() => b.updates.some((u) => u.update.type === "turn_end"));
  });

  test("sweep first: open{id} → UnknownSession; open{id, messages} recreates it", async () => {
    const d = daemon();
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    a.connection.close();
    d.clock.t = TTL;
    expect(d.reap()).toHaveLength(1);
    const b = await d.connect();
    await expect(b.open({ sessionId })).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    const messages = [{ role: "user", content: "earlier" }];
    expect(await b.open({ sessionId, messages })).toMatchObject({ sessionId, created: true });
    const snap = (await b.client.request("session/snapshot", { sessionId })) as {
      messages: unknown[];
    };
    expect(snap.messages).toEqual(messages);
  });
});

describe("daemon-wide limits (admission only: never close a session)", () => {
  test("maxSessions counts across connections; attaching at the cap is allowed; a close frees a slot", async () => {
    // Mutation (= today's code): count per connection → B's create succeeds.
    const audit: string[] = [];
    const d = daemon({ host: { maxSessions: 2, onAudit: (l) => audit.push(l) } });
    const a = await d.connect();
    const b = await d.connect();
    const { sessionId } = await a.open({ create: true });
    await b.open({ create: true });
    await expect(b.open({ create: true })).rejects.toMatchObject({
      code: DomainErrorCode.TooManySessions,
      data: { limit: "sessions", max: 2 },
    });
    // Seeded recreate of an absent id is a create too.
    await expect(
      b.open({ sessionId: "new", messages: [{ role: "user", content: "x" }] }),
    ).rejects.toMatchObject({ code: DomainErrorCode.TooManySessions });
    expect((await b.open({ sessionId })).created).toBe(false); // attach: never refused
    expect((await a.open({ sessionId })).created).toBe(false); // a retried open, same connection
    expect(d.host.size).toBe(2);
    expect(audit).toEqual(["session-refused sessions 2/2", "session-refused sessions 2/2"]);
    await a.client.request("session/close", { sessionId });
    expect((await b.open({ create: true })).created).toBe(true);
  });

  test("maxDetachedSessions refuses a new session (never evicts); the TTL reap frees it", async () => {
    // Mutation: evict the oldest detached instead → the first session is gone.
    const audit: string[] = [];
    const d = daemon({ host: { maxDetachedSessions: 1, onAudit: (l) => audit.push(l) } });
    const a = await d.connect();
    const { sessionId: first } = await a.open({ create: true });
    a.connection.close(); // one detached
    const b = await d.connect();
    await expect(b.open({ create: true })).rejects.toMatchObject({
      code: DomainErrorCode.TooManySessions,
      data: { limit: "detached", max: 1 },
    });
    expect(d.host.get(first)).toBeDefined(); // refused, not evicted
    expect(audit).toEqual(["session-refused detached 1/1"]);
    expect((await b.open({ sessionId: first })).created).toBe(false); // re-attach is fine
    b.connection.close();
    d.clock.t = TTL;
    expect(d.reap()).toEqual([{ id: first, reason: "idle_ttl" }]);
    const c = await d.connect();
    expect((await c.open({ create: true })).created).toBe(true);
  });

  test("a busy detached session counts toward the detached cap (D6: detached, busy or not)", async () => {
    // Mutation: count only idle detached sessions → the create succeeds.
    const model = new GatedModel();
    const d = daemon({ model: () => model, host: { maxDetachedSessions: 1 } });
    const a = await d.connect();
    const { sessionId } = await a.open({ create: true });
    await a.prompt(sessionId, "t1");
    await until(() => model.calls === 1);
    a.connection.close();
    expect(d.host.get(sessionId)?.running).toBe(true);
    const b = await d.connect();
    await expect(b.open({ create: true })).rejects.toMatchObject({
      data: { limit: "detached", max: 1 },
    });
    model.release();
  });

  test("a connection forgets a session another client closed (no stale reference kept)", async () => {
    // Mutation: drop `dropStale()` in `Connection.open` → A keeps the closed
    // session reachable and it is never collected.
    const d = daemon();
    const a = await d.connect();
    const b = await d.connect();
    await a.open({ sessionId: "X", create: true });
    const ref = new WeakRef(d.host.get("X") as object);
    await b.client.request("session/close", { sessionId: "X" });
    await a.open({ sessionId: "Y", create: true });
    d.jobs.length = 0; // the test's own reference to X's jobs
    for (let i = 0; i < 5 && ref.deref() !== undefined; i++) {
      Bun.gc(true);
      await tick(5);
    }
    expect(ref.deref()).toBeUndefined();
  });

  test("no limits configured → none enforced (in-process worker, stdio)", async () => {
    const d = daemon();
    const a = await d.connect();
    for (let i = 0; i < 70; i++) await a.open({ create: true });
    expect(d.host.size).toBe(70);
  });
});

describe("startReaper (the loop)", () => {
  test("one interval at sweepIntervalMs, unref'd; each tick sweeps and audits; stop clears it", () => {
    let callback: (() => void) | undefined;
    let interval: number | undefined;
    let unrefs = 0;
    const cleared: unknown[] = [];
    const handle = {
      unref: () => {
        unrefs++;
      },
    };
    const calls: ReapPolicy[] = [];
    const host = {
      reapExpired: (policy: ReapPolicy) => {
        calls.push(policy);
        return [{ id: "x", reason: "idle_ttl" as const }];
      },
    };
    const audit: string[] = [];
    const stop = startReaper(host, POLICY, {
      sweepIntervalMs: 1234,
      onAudit: (l) => audit.push(l),
      setInterval: (fn, ms) => {
        callback = fn;
        interval = ms;
        return handle;
      },
      clearInterval: (h) => cleared.push(h),
    });
    expect(interval).toBe(1234);
    expect(unrefs).toBe(1);
    expect(calls).toEqual([]);
    callback?.();
    expect(calls).toEqual([POLICY]);
    expect(audit).toEqual(["session-reaped x idle_ttl"]);
    stop();
    expect(cleared).toEqual([handle]);
  });

  test("a sweep that throws is reported and the loop keeps going", () => {
    let callback: (() => void) | undefined;
    let n = 0;
    const host = {
      reapExpired: () => {
        n++;
        if (n === 1) throw new Error("boom");
        return [];
      },
    };
    const errors: string[] = [];
    startReaper(host, POLICY, {
      onError: (e) => errors.push(e.message),
      setInterval: (fn) => {
        callback = fn;
        return { unref: () => {} };
      },
      clearInterval: () => {},
    });
    callback?.();
    callback?.();
    expect(errors).toEqual(["boom"]);
    expect(n).toBe(2);
  });
});
