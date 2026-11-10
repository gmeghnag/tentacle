import { describe, expect, test } from "bun:test";
import { Agent, type AgentConfig } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { AgentJobs } from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

// A `serve` daemon wakes its own session on a background-job exit when NOBODY
// is attached (docs/feat/serve-autowake.md). One `FakeJobs` is given to BOTH
// the agent (its `pendingExits` fills) and the host. Each test names the
// mutation that turns it red (AGENTS §9).

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
async function flush(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
/** The wake check is a macrotask: let a few run, each followed by the microtasks. */
async function settle(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
    await flush();
  }
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const shell = (id: string, command: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "shell", arguments: JSON.stringify({ command }) },
});

/** A model step that waits for `release()`. */
function gated(events?: readonly StreamEvent[]): { step: Step; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { step: { gate: promise, ...(events ? { events } : {}) }, release: () => resolve() };
}

type Step =
  | readonly StreamEvent[]
  | { readonly fail: string }
  | { readonly gate: Promise<void>; readonly events?: readonly StreamEvent[] };

/** Records every request; plays `steps` in order, then answers "ok". */
class Model implements ModelProvider {
  readonly id = "model";
  readonly seen: ChatRequest[] = [];
  readonly steps: Step[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request);
    const step = this.steps.shift() ?? [text("ok"), done];
    if ("fail" in step) {
      throw new Error(step.fail);
    }
    if ("gate" in step) {
      await step.gate;
      for (const e of step.events ?? [text("ok"), done]) yield e;
      return;
    }
    for (const e of step) yield e;
  }
  /** The requests that carried job `id`'s `[background]` note as their LAST message. */
  wokeFor(id: string): number {
    return this.seen.filter((r) => {
      const last = r.messages.at(-1);
      return (
        typeof last?.content === "string" && last.content.startsWith(`[background] job ${id} `)
      );
    }).length;
  }
}

class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read(): undefined {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {}
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(id: string): void {
    for (const l of [...this.listeners]) {
      l({ id, command: "sleep 1", startedAt: 0, status: "exited", exitCode: 0 });
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

function rig(
  opts: { wake?: boolean; persister?: SessionPersister; hooks?: object; now?: () => number } = {},
) {
  const jobs = new FakeJobs();
  const model = new Model();
  // The session's background sub-agents (docs/feat/agent-message-two-way.md):
  // the host binds its ledger, the agent subscribes, and a test "child" notifies.
  const agentJobs = new AgentJobs(2);
  const audit: string[] = [];
  const errors: Error[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/serve-autowake",
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.wake !== false ? { wakeOnJobExit: true } : {}),
    ...(opts.persister ? { persister: opts.persister } : {}),
    onAudit: (line) => audit.push(line),
    onTurnError: (error) => errors.push(error),
    createAgent: (_cwd, context) => {
      const permissions = context.reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        jobs,
        agentJobs,
        requestPermission: (req, options) => permissions.request(req, options),
        // A stand-in hook runner: only the members the agent reads (W-7b).
        ...(opts.hooks ? { hooks: opts.hooks as AgentConfig["hooks"] } : {}),
      });
      return {
        agent,
        permissions,
        jobs,
        agentJobs,
        ...(context.settings
          ? { settingsReport: { carried: context.settings, overridden: {} } }
          : {}),
      };
    },
  });
  const connect = async () => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", INIT);
    const open = (params: Record<string, unknown> = {}) =>
      client.request("session/open", { sessionId: "S", ...params }) as Promise<OpenResult>;
    const prompt = (turnId: string, value = "go") =>
      client.request("session/prompt", {
        sessionId: "S",
        turnId,
        content: [{ type: "text", text: value }],
      });
    const detach = () => client.request("session/detach", { sessionId: "S" });
    const resolve = (requestId: string, optionId: string) =>
      client.request("session/resolve_permission", { sessionId: "S", requestId, optionId });
    const of = <T extends SessionUpdate["type"]>(type: T) =>
      updates
        .map((u) => u.update)
        .filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
    return { client, updates, open, prompt, detach, resolve, of };
  };
  const hosted = () => {
    const s = host.get("S");
    if (!s) throw new Error("no session S");
    return s;
  };
  /** A session with one normal turn behind it, then detached: nobody attached. */
  const detachedAfterTurn = async () => {
    const a = await connect();
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    await a.detach();
    await settle();
    return a;
  };
  return { jobs, agentJobs, model, audit, errors, host, connect, hosted, detachedAfterTurn };
}

describe("a serve daemon wakes a session nobody is attached to", () => {
  test("W-1 a job exit with nobody attached starts ONE continuation turn that sees the exit", async () => {
    // Mutation: drop the `kickWake()` in the exit callback → no second model call.
    const r = rig();
    await r.detachedAfterTurn();
    expect(r.model.seen.length).toBe(1);
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.model.wokeFor("j1")).toBe(1);
    // The reply is in the history; the exit is flushed; the slot is free.
    expect(r.hosted().running).toBe(false);
    expect(r.hosted().unflushedExits).toBe(0);
    expect(r.audit).toContain("wake: background job exit S");
    // The audit line never carries the (model-supplied) command.
    expect(r.audit.some((l) => l.includes("sleep"))).toBe(false);
    // A later attach replays the wake turn (an empty prompt) and its end.
    const b = await r.connect();
    expect(await b.open()).not.toHaveProperty("unflushedExits");
  });

  test("W-2 off (no `wakeOnJobExit`, as a pod daemon or the worker): no turn, the exit waits", async () => {
    // Mutation: ignore `enabled` in `daemonWakeGate` → a wake.
    const r = rig({ wake: false });
    await r.detachedAfterTurn();
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(1);
    expect(r.hosted().unflushedExits).toBe(1);
    // The next attach is told (and its TUI wakes by its own rule).
    const b = await r.connect();
    expect((await b.open()).unflushedExits).toBe(1);
  });

  test("W-3 a client attached: the DAEMON wakes (the only waker), once, live to the client", async () => {
    // Owner answer (fix round 2): attached or not, the serve daemon wakes.
    // Mutation: block the gate on `attached > 0` (the old defer rule) → no wake (the live bug).
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.model.wokeFor("j1")).toBe(1);
    expect(r.hosted().unflushedExits).toBe(0);
    // The client watched it live: the exit, then the wake turn (an empty prompt) to its end.
    expect(a.of("background_exit").map((u) => u.jobId)).toEqual(["j1"]);
    const starts = a.of("turn_start");
    expect(starts.map((u) => u.prompt)).toEqual(["go", ""]);
    expect(starts[1]?.turnId.startsWith("wake-")).toBe(true);
    expect(a.of("turn_end").length).toBe(2);
    // Its detach is not a trigger and starts nothing more.
    await a.detach();
    await settle();
    expect(r.model.seen.length).toBe(2);
  });

  test("W-3b a prompt typed during the daemon's wake is enqueued and steers it, as for any turn", async () => {
    // Mutation: none needed in this task's code — pins that a wake is an ordinary turn
    // for the attached client: `session/prompt` → TurnInProgress, `session/enqueue` → steered.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    const { step, release } = gated([shell("c1", "make"), done]);
    r.model.steps.push(step);
    r.jobs.fire("j1");
    await settle();
    expect(r.hosted().running).toBe(true);
    const wakeId = a.of("turn_start")[1]?.turnId ?? "";
    expect(wakeId.startsWith("wake-")).toBe(true);
    let refused: number | undefined;
    try {
      await a.prompt("t2", "also check lint");
    } catch (error) {
      refused = (error as { code?: number }).code;
    }
    expect(refused).toBe(DomainErrorCode.TurnInProgress);
    await a.client.request("session/enqueue", {
      sessionId: "S",
      id: "e1",
      turnId: wakeId,
      text: "also check lint",
    });
    release();
    await settle();
    // Approve the shell call: the steer is drained at the round boundary.
    const ask = a.of("permission_request")[0];
    if (ask) await a.resolve(ask.requestId, "allow_once");
    await settle();
    expect(r.hosted().running).toBe(false);
    expect(a.of("steer").map((u) => u.id)).toEqual(["e1"]);
    const sawSteer = r.model.seen.some((req) =>
      req.messages.some((m) => m.role === "user" && m.content === "also check lint"),
    );
    expect(sawSteer).toBe(true);
  });

  test("W-4 no limit: every job end wakes once", async () => {
    // Mutation: cap the wakes (a counter) → fewer turns than exits.
    const r = rig();
    await r.detachedAfterTurn();
    for (let i = 0; i < 25; i++) {
      r.jobs.fire(`j${i}`);
      await settle();
    }
    expect(r.model.seen.length).toBe(26);
    for (let i = 0; i < 25; i++) expect(r.model.wokeFor(`j${i}`)).toBe(1);
  });

  test("W-5 a bad end stops the chain: no wake after an error or a cancel, until a normal end", async () => {
    // Mutation: never set `lastEndBad` → the failed wake retries on the next exit.
    const r = rig();
    await r.detachedAfterTurn();
    // The wake's model fails (e.g. a 401): exactly one attempt.
    r.model.steps.push({ fail: "401 unauthorized" });
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.errors.map((e) => e.message)).toContain("401 unauthorized");
    // A second exit does not chain a retry.
    r.jobs.fire("j2");
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.hosted().unflushedExits).toBe(1);
    // A normal user turn clears it: the next exit wakes again.
    const a = await r.connect();
    await a.open();
    await a.prompt("t2");
    await settle();
    await a.detach();
    r.jobs.fire("j3");
    await settle();
    expect(r.model.seen.length).toBe(4);
    expect(r.model.wokeFor("j3")).toBe(1);
  });

  test("W-5b a cancelled turn (the user's stop) ends the chain too", async () => {
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    const { step, release } = gated();
    r.model.steps.push(step);
    await a.prompt("t1");
    await flush();
    a.client.notify("session/cancel", { sessionId: "S" });
    await flush();
    release();
    await settle();
    await a.detach();
    await settle();
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(1);
    expect(r.hosted().unflushedExits).toBe(1);
  });

  test("W-6 an exit during a turn wakes at its end; one its start flushed does not", async () => {
    // Mutation: drop the `kickWake()` in `finishTurn` → the first leg gets no wake;
    // a boolean "an exit happened" instead of the count → the second leg wakes twice.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    await a.detach();
    // A turn running with nobody attached (started then detached); the exit lands mid-turn.
    const b = await r.connect();
    await b.open();
    const { step, release } = gated();
    r.model.steps.push(step);
    await b.prompt("t1");
    await flush();
    await b.detach();
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(1);
    release();
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.model.wokeFor("j1")).toBe(1);
    // Second leg: an exit queued, then the user's turn starts and flushes it.
    const c = await r.connect();
    await c.open();
    r.jobs.fire("j2");
    await c.prompt("t2");
    await c.detach();
    await settle();
    // The user's turn saw it; no extra wake for it.
    expect(r.model.seen.length).toBe(3);
    expect(r.hosted().unflushedExits).toBe(0);
  });

  test("W-7 attach while the wake turn runs (past its flush): no unflushed exits; a later exit wakes the daemon once", async () => {
    // Mutation: block the gate on `attached > 0` → no daemon wake on j2 while attached.
    // The pre-flush window: W-7b.
    const r = rig();
    await r.detachedAfterTurn();
    const { step, release } = gated();
    r.model.steps.push(step);
    r.jobs.fire("j1");
    await settle();
    expect(r.hosted().running).toBe(true);
    const b = await r.connect();
    const opened = await b.open();
    expect(opened).not.toHaveProperty("unflushedExits");
    release();
    await settle();
    expect(r.model.seen.length).toBe(2);
    // Attached: the next exit is the daemon's to wake too — exactly one more turn, seen live.
    r.jobs.fire("j2");
    await settle();
    expect(r.model.seen.length).toBe(3);
    expect(r.model.wokeFor("j2")).toBe(1);
    expect(b.of("turn_end").length).toBe(2);
  });

  test("W-7b attach while the wake turn's start has NOT flushed yet (project-hook trust pending): 0", async () => {
    // Mutation: `unflushedExits` returns the raw count → the attach reads 1 here
    // (the flush comes after the trust `await`), and its TUI would wake again.
    const trust: { release: () => void; asked: number } = { release: () => {}, asked: 0 };
    const hooks = {
      needsProjectTrust: () => trust.asked < 2,
      resolveProjectTrust: () => {
        trust.asked++;
        // The first turn's trust resolves at once; the wake's waits.
        return trust.asked === 1
          ? Promise.resolve()
          : new Promise<void>((res) => {
              trust.release = res;
            });
      },
      hasAny: () => false,
      notifyModelRequest: () => {},
      forgetModelRequestBaseline: () => {},
    };
    const r = rig({ hooks });
    await r.detachedAfterTurn();
    r.jobs.fire("j1");
    await settle();
    expect(trust.asked).toBe(2);
    expect(r.hosted().running).toBe(true);
    // Not flushed yet (the agent still counts 1), but the wake's start will: 0.
    expect(r.hosted().unflushedExits).toBe(0);
    const b = await r.connect();
    expect(await b.open()).not.toHaveProperty("unflushedExits");
    trust.release();
    await settle();
    expect(r.hosted().running).toBe(false);
    expect(r.model.wokeFor("j1")).toBe(1);
    // After the flush the mark is gone: a later exit (attached) is woken by the daemon, once.
    r.jobs.fire("j2");
    await settle();
    expect(r.hosted().unflushedExits).toBe(0);
    expect(r.model.seen.length).toBe(3);
    expect(r.model.wokeFor("j2")).toBe(1);
  });

  test("W-8 a wake turn needing a permission holds the slot until an attaching client answers", async () => {
    // Mutation: auto-deny in the nobody-attached branch of `awaitDecision` → it never waits.
    // Mutation: the reaper does not skip a busy session → the sweep closes it.
    const clock = { t: 1_000 };
    const r = rig({ now: () => clock.t });
    await r.detachedAfterTurn();
    r.model.steps.push([shell("c1", "make test"), done], [text("tests pass"), done]);
    r.jobs.fire("j1");
    await settle();
    expect(r.hosted().running).toBe(true);
    expect(r.hosted().liveness().busy).toBe(true);
    // Far past the idle TTL, nobody attached: a busy (held) wake is never reaped.
    clock.t += 10 * 60 * 60 * 1000;
    expect(r.host.reapExpired({ idleTtlMs: 60_000 })).toEqual([]);
    expect(r.host.get("S")?.running).toBe(true);
    // An attach replays the held ask; answering finishes the wake turn.
    const b = await r.connect();
    await b.open();
    await flush();
    const asks = b.of("permission_request");
    expect(asks.length).toBe(1);
    const ask = asks[0];
    if (!ask) throw new Error("no ask");
    await b.resolve(ask.requestId, "allow_once");
    await settle();
    expect(r.hosted().running).toBe(false);
    expect(r.model.seen.length).toBe(3);
  });

  test("W-9 the wake turn is persisted like any turn (serve's persister)", async () => {
    // The two files in memory, decoded by the real decoders (like bytes on a disk).
    const store = new SpyDaemonStore();
    const saved = store.durable;
    const persister = new SessionPersister({
      store,
      cwd: "/tmp/serve-autowake",
      model: "m",
      onError: () => {},
    });
    const r = rig({ persister });
    await r.detachedAfterTurn();
    r.jobs.fire("j1");
    await settle();
    await persister.stop();
    const record = saved.get("S");
    if (!record) throw new Error("not saved");
    const wake = record.turns.find((t) => t.turnId.startsWith("wake-"));
    expect(wake?.end?.stopReason).toBe("end_turn");
    const contents = record.messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(contents.some((c) => c.startsWith("[background] job j1 "))).toBe(true);
    expect(record.messages.at(-1)?.role).toBe("assistant");
    expect(record.turn).toBeUndefined();
  });

  test("W-10 the slot race: a client prompt first → the wake waits; its turn flushed the exit", async () => {
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    await a.detach();
    r.jobs.fire("j1");
    // Before the wake's macrotask, a prompt takes the slot (the wake's check then sees it busy).
    r.hosted().prompt("user", [{ type: "text", text: "hello" }]);
    await settle();
    // Only the user's turn ran (its start flushed the exit): no wake after it.
    expect(r.model.seen.length).toBe(1);
    expect(r.hosted().unflushedExits).toBe(0);
    // And while a wake turn holds the slot, a client prompt gets `TurnInProgress`.
    const { step, release } = gated();
    r.model.steps.push(step);
    r.jobs.fire("j2");
    await settle();
    expect(r.hosted().running).toBe(true);
    let code: number | undefined;
    try {
      r.hosted().prompt("user-2", [{ type: "text", text: "hi" }]);
    } catch (error) {
      code = error instanceof RpcError ? error.code : undefined;
    }
    expect(code).toBe(DomainErrorCode.TurnInProgress);
    release();
    await settle();
  });

  test("W-11 a close with a wake check pending starts nothing", async () => {
    // Mutation: don't clear `wakeKick` in `close` (and drop the `closed` gate) → a turn after close.
    const r = rig();
    await r.detachedAfterTurn();
    const s = r.hosted();
    r.jobs.fire("j1");
    s.close();
    await settle();
    expect(r.model.seen.length).toBe(1);
    expect(s.running).toBe(false);
  });

  test("W-13 an exit during a compaction wakes at the compaction's end", async () => {
    // Mutation: drop the `kickWake()` at the end of `compact` → no wake.
    const r = rig();
    await r.detachedAfterTurn();
    const { step, release } = gated([text("summary"), done]);
    r.model.steps.push(step);
    const compaction = r.hosted().compact();
    await flush();
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.hosted().unflushedExits).toBe(1);
    release();
    await compaction;
    await settle();
    expect(r.model.seen.length).toBe(3);
    expect(r.model.wokeFor("j1")).toBe(1);
  });

  test("W-12 after a settings sync (the new agent listens AFTER the session) an exit still wakes", async () => {
    // Mutation: check the wake synchronously in the exit callback → the swapped
    // agent has not counted the exit yet → no wake.
    const r = rig();
    await r.detachedAfterTurn();
    const s = r.hosted();
    expect(r.host.updateSettings(s, "u1", { maxIterations: 5 })).toMatchObject({ applied: true });
    r.jobs.fire("j1");
    await settle();
    expect(r.model.seen.length).toBe(2);
    expect(r.model.wokeFor("j1")).toBe(1);
  });

  /** A started background child on the session's own runtime (a notify needs a running id). */
  const startChild = (r: ReturnType<typeof rig>) => {
    const gate = Promise.withResolvers<{
      report: string;
      toolUses: number;
      stopReason: string;
    }>();
    const started = r.agentJobs.start(
      { callId: "c1", agentType: "general", description: "map repo" },
      () => gate.promise,
    );
    if (!started.ok) {
      throw new Error("the child did not start");
    }
    return started.agentId;
  };
  /** Every `subagent_notify` a connected client got. */
  const notified = (updates: readonly KnownSessionUpdateParams[]) =>
    updates
      .map((u) => u.update)
      .filter(
        (u): u is Extract<SessionUpdate, { type: "subagent_notify" }> =>
          u.type === "subagent_notify",
      );

  test("N-1 a WAKING notify with nobody attached starts ONE wake turn whose request has the note", async () => {
    // Mutation: drop the `kickWake()` in the notify listener → no second model call.
    const r = rig();
    await r.detachedAfterTurn();
    expect(r.model.seen.length).toBe(1);
    expect(r.agentJobs.notify(startChild(r), "found X")).toEqual({ ok: true, wakes: true });
    await settle();
    expect(r.model.seen.length).toBe(2);
    const request = r.model.seen[1];
    expect(request?.messages.map((m) => String(m.content)).join("\n")).toContain(
      "[sub-agent sa-1 → you] found X",
    );
    expect(r.hosted().unflushedExits).toBe(0);
  });

  test("N-2 a NON-waking notify starts no turn, and is delivered at the next turn's start", async () => {
    const r = rig();
    await r.detachedAfterTurn();
    const child = startChild(r);
    // Spend the wake budget (3) so the 4th is quiet.
    for (let i = 0; i < 3; i++) {
      r.agentJobs.notify(child, `wake ${i}`);
    }
    await settle();
    const before = r.model.seen.length;
    expect(r.agentJobs.notify(child, "quiet")).toEqual({ ok: true, wakes: false });
    await settle();
    // No wake: the counted queue is 0 (only the three waking ones asked).
    expect(r.model.seen.length).toBe(before);
    // The note is still there for the next turn the client starts.
    const b = await r.connect();
    await b.open();
    await b.prompt("t2");
    await settle();
    const last =
      r.model.seen
        .at(-1)
        ?.messages.map((m) => String(m.content))
        .join("\n") ?? "";
    expect(last).toContain("[sub-agent sa-1 → you] quiet");
  });

  test("N-3 a notify during a compaction is held, and woken for after it", async () => {
    const r = rig();
    await r.detachedAfterTurn();
    const child = startChild(r);
    const { step, release } = gated([text("summary"), done]);
    r.model.steps.push(step);
    const compaction = r.hosted().compact();
    await flush();
    expect(r.agentJobs.notify(child, "during compaction")).toEqual({ ok: true, wakes: true });
    await settle();
    // Held: no new turn while the slot is taken.
    expect(r.model.seen.length).toBe(2);
    release();
    await compaction;
    await settle();
    expect(r.model.seen.length).toBe(3);
    const last =
      r.model.seen
        .at(-1)
        ?.messages.map((m) => String(m.content))
        .join("\n") ?? "";
    expect(last).toContain("[sub-agent sa-1 → you] during compaction");
  });

  test("N-4 an attached client gets the notice, with the id and the text, live", async () => {
    // Mutation: emit without `kickWake`/without the emit → the client sees nothing.
    const r = rig();
    const a = await r.connect();
    await a.open({ create: true });
    await a.prompt("t1");
    await settle();
    const child = startChild(r);
    r.agentJobs.notify(child, "live one");
    await settle();
    const seen = notified(a.updates);
    expect(seen.at(-1)).toMatchObject({ agentId: "sa-1", text: "live one", wake: true });
  });
});
