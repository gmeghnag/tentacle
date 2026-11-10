import { describe, expect, test } from "bun:test";
import { Agent, Session, createSubagentRunner } from "@tentacle/agent";
import {
  AgentJobs,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import type { KnownLogEntry, KnownSessionUpdateParams, LogCursor } from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { z } from "zod";
import { HostedSession, type SessionPersistence } from "../src/hosted-session.ts";
import type { SessionPersister } from "../src/session-persister.ts";

// docs/feat/subagent-detach.md T15-T26, the daemon half: `HostedSession.enqueue`
// and `send_now` — the USER's steering paths, never `Session.enqueue` — move a
// running FOREGROUND child to the background, synchronously, before the abort of
// a send-now and before the persist of a steer.

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await macro();
}
const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const call = (id: string, name: string, args: unknown = {}): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});
const fgTask = (id: string, description: string): StreamEvent =>
  call(id, "agent_task", { description, prompt: "go" });

type Step = readonly StreamEvent[] | { gate: Promise<void>; events: readonly StreamEvent[] };
class Model implements ModelProvider {
  readonly id = "m";
  readonly steps: Step[] = [];
  readonly seen: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(req);
    const s = this.steps.shift() ?? [text("ok"), done];
    if ("gate" in s) {
      await s.gate;
      for (const e of s.events) yield e;
      return;
    }
    for (const e of s) yield e;
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
const empty = z.object({});
const ran: string[] = [];
const free: Tool = {
  name: "free_read",
  description: "d",
  inputSchema: empty,
  permission: "none",
  execute: async () => ({ content: "read" }),
};
const needs: Tool = {
  name: "needs_ok",
  description: "d",
  inputSchema: empty,
  permission: "ask",
  execute: async () => {
    ran.push("needs_ok");
    return { content: "ran" };
  },
};

/**
 * A `serve`-style persister whose disk this test can HOLD (T27, Review M1):
 * `flush` — the wait the gate does before a tool runs — resolves with
 * `current`, which a test can swap for a held promise. `schedule` counts the
 * writes the session asked for (a fake: a real disk is not this test's subject).
 */
function heldDisk() {
  const disk = {
    current: Promise.resolve() as Promise<void>,
    schedules: 0,
    persister: undefined as unknown as SessionPersister,
  };
  disk.persister = {
    schedule: () => {
      disk.schedules++;
    },
    flush: () => disk.current,
    writable: () => false,
    write: async () => false,
  } as unknown as SessionPersister;
  return disk;
}
type HeldDisk = ReturnType<typeof heldDisk>;

function rig(
  opts: {
    cap?: number;
    execution?: "sequential" | "parallel";
    attach?: boolean;
    wake?: boolean;
    /** `serve`-style persistence with a disk the test holds (T27). */
    disk?: boolean;
  } = {},
) {
  ran.length = 0;
  const parent = new Model();
  const child = new Model();
  const permissions = new PermissionBroker();
  const requestPermission = permissions.request.bind(permissions);
  const agentJobs = new AgentJobs(opts.cap ?? 2);
  const childTools = new ToolRegistry().register(free).register(needs);
  const { run, types } = createSubagentRunner({
    model: child,
    env,
    tools: childTools,
    requestPermission,
  });
  const parentTools = new ToolRegistry()
    .register(free)
    .register(needs)
    .register(createTaskTool(run, types, { background: agentJobs }));
  const agent = new Agent({
    model: parent,
    tools: parentTools,
    env,
    agentJobs,
    systemPrompt: "s",
    maxIterations: 8,
    requestPermission,
    ...(opts.execution
      ? {
          subagentExecution: {
            mode: opts.execution,
            maxParallel: opts.execution === "parallel" ? 4 : 1,
          },
        }
      : {}),
  });
  const session = new Session(agent, "s1", {});
  const disk = opts.disk ? heldDisk() : undefined;
  const persistence: SessionPersistence | undefined = disk
    ? { persister: disk.persister }
    : undefined;
  const hosted = new HostedSession(
    "s1",
    session,
    permissions,
    undefined,
    {},
    undefined,
    Date.now,
    persistence,
    {},
    {},
    {},
    agentJobs,
  );
  const frames: KnownSessionUpdateParams[] = [];
  if (opts.attach !== false) {
    hosted.attach({ send: (p) => frames.push(p) });
  }
  return { parent, child, permissions, hosted, frames, agentJobs, session, agent, disk };
}
type Rig = ReturnType<typeof rig>;

const typesOf = (f: readonly KnownSessionUpdateParams[]) => f.map((p) => p.update.type);
const asks = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "permission_request" ? [p.update] : []));
const resolved = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "permission_resolved" ? [p.update] : []));
const turnStarts = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "turn_start" ? [p.update.turnId] : []));
const progress = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "tool_progress" ? [p.update] : []));
const prompt = (r: Rig, id: string, t = "go") => r.hosted.prompt(id, [{ type: "text", text: t }]);
const toolTexts = (r: Rig) =>
  r.parent.seen.map((req) =>
    req.messages.filter((m) => m.role === "tool").map((m) => String(m.content)),
  );
const roles = (req: ChatRequest) => req.messages.map((m) => `${m.role}:${String(m.content)}`);

function readAll(r: Rig): KnownLogEntry[] {
  const all: KnownLogEntry[] = [];
  let after: LogCursor | undefined;
  for (;;) {
    const page = r.hosted.logRead(after);
    all.push(...(page.entries as KnownLogEntry[]));
    const last = page.entries.at(-1);
    if (!page.more || !last) return all;
    after = { seq: last.seq, id: last.id };
  }
}
const logTypes = (r: Rig) => readAll(r).map((e) => e.type);

/** A foreground `agent_task` whose child is held by `gate`. */
function heldForeground(r: Rig, callId = "c1", description = "map repo") {
  const gate = Promise.withResolvers<void>();
  r.parent.steps.push([fgTask(callId, description), done], [text("carried on"), done]);
  r.child.steps.push({ gate: gate.promise, events: [text("THE REPORT"), done] });
  return gate;
}

const priv = (r: Rig) =>
  r.hosted as unknown as {
    historyReplaced(reason: "compact" | "context_reset"): void;
  };

describe("T15: the load-bearing assumption", () => {
  test("enqueue detaches synchronously; the next model request is on microtasks alone", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    expect(r.parent.seen).toHaveLength(1);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual([]);
    // The steer: the whole trigger. Nothing is awaited between here and the answer.
    r.hosted.enqueue("e1", "T1", "steer text");
    // Microtasks ONLY from now on: no macrotask, no timer.
    let hops = 0;
    while (r.parent.seen.length < 2 && hops < 2000) {
      await Promise.resolve();
      hops++;
    }
    expect(r.parent.seen).toHaveLength(2);
    // The moved result, then the steer: the child's call was answered in the same round.
    const tail = roles(r.parent.seen[1] as ChatRequest).slice(-2);
    expect(tail).toEqual([
      "tool:moved to background as sa-1: map repo. Its report will arrive later as a [background] note; you can keep working or end your turn.",
      "user:steer text",
    ]);
    // The marker precedes the tool message: durable before the call committed.
    const log = logTypes(r);
    expect(log.indexOf("subagent_background")).toBeGreaterThan(-1);
    gate.resolve();
    await settle(10);
  });

  test("the `subagent_background` marker precedes the tool result in the log", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle();
    const entries = readAll(r);
    const marker = entries.findIndex((e) => e.type === "subagent_background");
    const base = entries.map((e) => e.type).lastIndexOf("base");
    expect(marker).toBeGreaterThan(base);
    // The move is the row's birth: it is announced before the turn's next round.
    expect(marker).toBeLessThan(entries.length);
    gate.resolve();
    await settle(10);
  });
});

describe("T16: M1 — only the USER's paths detach", () => {
  test("`Session.enqueue` directly does not detach", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.session.enqueue("a steer the daemon never saw");
    await settle(2);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    expect(logTypes(r)).not.toContain("subagent_background");
    gate.resolve();
    await settle(10);
  });

  test("a retried enqueue id does not detach twice", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(2);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    const launches = logTypes(r).filter((t) => t === "subagent_background").length;
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(2);
    expect(logTypes(r).filter((t) => t === "subagent_background")).toHaveLength(launches);
    gate.resolve();
    await settle(10);
  });

  test("a `NoTurnRunning` enqueue never detaches", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    expect(() => r.hosted.enqueue("e1", "other-turn", "steer text")).toThrow();
    await settle(2);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    gate.resolve();
    await settle(10);
  });
});

describe("T17: two siblings of one round both move", () => {
  test("parallel: both become sa-1 and sa-2, in one commit", async () => {
    const r = rig({ execution: "parallel", cap: 2 });
    const gateA = Promise.withResolvers<void>();
    const gateB = Promise.withResolvers<void>();
    r.parent.steps.push([fgTask("c1", "first"), fgTask("c2", "second"), done]);
    r.child.steps.push(
      { gate: gateA.promise, events: [text("A REPORT"), done] },
      { gate: gateB.promise, events: [text("B REPORT"), done] },
    );
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    const running = r.hosted.agentJobsRunning().map((j) => j.agentId);
    expect(running).toEqual(["sa-1", "sa-2"]);
    await settle(4);
    const tail = roles(r.parent.seen.at(-1) as ChatRequest).slice(-3);
    expect(tail[0]).toContain("moved to background as sa-1: first");
    expect(tail[1]).toContain("moved to background as sa-2: second");
    expect(tail[2]).toBe("user:steer text");
    gateA.resolve();
    gateB.resolve();
    await settle(12);
  });
});

describe("T18: a full cap never refuses a detach (F8)", () => {
  test("cap 1 with its only slot held: the detach still succeeds, and the row exists", async () => {
    const r = rig({ cap: 1 });
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    // The foreground child holds the ONE slot; the runtime is full.
    expect(r.agentJobs.acquire("probe").ok).toBe(false);
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(2);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    // One slot out, one entry in: still exactly full.
    expect(r.agentJobs.acquire("probe").ok).toBe(false);
    gate.resolve();
    await settle(12);
  });
});

describe("T19: send-now (Q13)", () => {
  test("the child survives, the old turn ends `cancelled`, the moved result is in history", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.hosted.sendNow("T2", { kind: "turn", turnId: "T1" }, [{ id: "m1", text: "do this instead" }]);
    await settle(6);
    // The child lives on, unlinked from the turn that was just aborted.
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    // The old turn ended cancelled; the successor started.
    expect(turnStarts(r.frames)).toContain("T2");
    const ends = r.frames.flatMap((p) => (p.update.type === "turn_end" ? [p.update] : []));
    expect(ends[0]?.stopReason).toBe("cancelled");
    // The successor's prompt reached the model, after the moved tool result.
    const nextReq = r.parent.seen.at(-1) as ChatRequest;
    const tail = roles(nextReq).slice(-2);
    expect(tail[0]).toContain("moved to background as sa-1");
    expect(tail[1]).toBe("user:do this instead");
    gate.resolve();
    await settle(14);
    // The report arrives later, as the ordinary background note.
    expect(roles(r.parent.seen.at(-1) as ChatRequest).at(-1)).toContain("THE REPORT");
  });
});

describe("T20: a steer with the child's ask open (Q-C)", () => {
  test("the ask is withdrawn + re-asked as sa-N; the pending list is empty; the answer runs the tool", async () => {
    const r = rig();
    const childGate = Promise.withResolvers<void>();
    r.parent.steps.push([fgTask("c1", "map repo"), done], [text("carried on"), done]);
    r.child.steps.push({ gate: childGate.promise, events: [call("k1", "needs_ok"), done] }, [
      text("CHILD DONE"),
      done,
    ]);
    prompt(r, "T1");
    await settle(4);
    childGate.resolve();
    await settle(6);
    // The child asks: a foreground ask, on the turn.
    const first = asks(r.frames);
    expect(first).toHaveLength(1);
    expect(first[0]?.agent?.id).toBeUndefined();
    expect(first[0]?.toolCallId).toBe("c1");
    const firstId = first[0]?.requestId as string;
    const priv = r.hosted as unknown as { pendingList(): unknown[] };
    expect(priv.pendingList()).toHaveLength(1);

    // The person writes: the child moves, and its ask is withdrawn + re-asked.
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(6);
    expect(resolved(r.frames).map((x) => `${x.requestId}:${x.outcome.outcome}`)).toContain(
      `${firstId}:cancelled`,
    );
    const second = asks(r.frames).at(-1);
    expect(second?.requestId).not.toBe(firstId);
    expect(second?.agent?.id).toBe("sa-1");
    // The spawning turn, as 6a's background ask carries it.
    expect(second?.turnId).toBe("T1");
    // Not a turn pending entry: the child's ask is held apart from every turn.
    expect(priv.pendingList()).toEqual([]);
    expect(ran).toEqual([]);
    // Answering the re-asked prompt runs the tool for the child.
    r.hosted.resolvePermission(second?.requestId as string, "allow_once");
    await settle(8);
    expect(ran).toEqual(["needs_ok"]);
  });
});

describe("T27: an ALLOWED ask waits for its clear even when a steer withdraws (M1)", () => {
  // The child's ask is ALLOWED; the write that clears `turn.pending` is held;
  // a steer lands in that window. The withdrawal only ends the wait of an
  // UNANSWERED ask — an answered one still runs its tool, so it must wait for
  // the write: otherwise the entry is on disk while the tool runs, and a crash
  // reloads "pending" and runs the call twice (AGENTS.md §7).
  async function allowedWithHeldDisk() {
    const r = rig({ disk: true });
    const disk = r.disk as HeldDisk;
    r.parent.steps.push([fgTask("c1", "map repo"), done], [text("carried on"), done]);
    r.child.steps.push([call("k1", "needs_ok"), done], [text("CHILD DONE"), done]);
    prompt(r, "T1");
    await settle(10);
    const ask = asks(r.frames).at(-1);
    expect(ask).toBeDefined();
    expect(ask?.agent?.id).toBeUndefined(); // foreground: the turn's ask, withdrawable
    // From here the disk hangs; the person allows.
    const held = Promise.withResolvers<void>();
    disk.current = held.promise;
    r.hosted.resolvePermission(ask?.requestId as string, "allow_once");
    await settle(6);
    return { r, disk, held };
  }

  test("control: allowed, disk held, NO steer → the tool waits for the write", async () => {
    const { r, held } = await allowedWithHeldDisk();
    expect(ran).toEqual([]);
    held.resolve();
    await settle(10);
    expect(ran).toEqual(["needs_ok"]);
  });

  test("a steer while the clear is on its way to disk does not let the tool run early", async () => {
    const { r, held } = await allowedWithHeldDisk();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(10);
    // THE property: the steer withdrew a settled ask, and the tool still has
    // not run — only the held write may release it.
    expect(ran).toEqual([]);
    // Not vacuous: the steer really landed and the withdrawal path really ran
    // (the child moved; the answered ask was not asked again).
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(asks(r.frames)).toHaveLength(1);
    held.resolve();
    await settle(10);
    // Exactly once: the write landed, then the tool ran.
    expect(ran).toEqual(["needs_ok"]);
  });
});

describe("T21: a refusal settled just before the move is not re-asked", () => {
  test("the tool does not run, and there is no second ask", async () => {
    const r = rig();
    const childGate = Promise.withResolvers<void>();
    // The child's SECOND step is held: it is still RUNNING when the steer lands,
    // with its ask already answered (a human's refusal is never withdrawn).
    const childHold = Promise.withResolvers<void>();
    r.parent.steps.push([fgTask("c1", "map repo"), done], [text("carried on"), done]);
    r.child.steps.push(
      { gate: childGate.promise, events: [call("k1", "needs_ok"), done] },
      { gate: childHold.promise, events: [text("CHILD DONE"), done] },
    );
    prompt(r, "T1");
    await settle(4);
    childGate.resolve();
    await settle(6);
    const first = asks(r.frames).at(-1);
    expect(first).toBeDefined();
    r.hosted.resolvePermission(first?.requestId as string, "reject_once");
    await settle(4);
    expect(ran).toEqual([]);
    // Still foreground: the steer has not landed yet.
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(6);
    // It moved…
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    // …and the settled ask was NOT asked again.
    expect(asks(r.frames)).toHaveLength(1);
    expect(ran).toEqual([]);
    childHold.resolve();
    await settle(10);
  });
});

describe("T22: Esc on a later turn leaves the moved child running", () => {
  test("only `agent_kill` ends it, as `cancelled`", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(4);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    // The steer carried the turn on; a second turn's Esc must not touch the child.
    prompt(r, "T2", "go on");
    await settle(4);
    r.hosted.cancel();
    await settle(4);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    // ONLY `agent_kill` ends it — and its exit reports `cancelled`, whatever its
    // run says (`kill` is a decision, not a report).
    expect(r.agentJobs.kill("sa-1")).toBe(true);
    gate.resolve();
    await settle(12);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    const exit = r.frames
      .flatMap((p) => (p.update.type === "background_exit" ? [p.update] : []))
      .at(-1);
    expect(exit?.agent?.stopReason).toBe("cancelled");
    expect(logTypes(r)).toContain("subagent_end");
  });
});

describe("T26: a steer between rounds", () => {
  test("no marker, no id consumed", async () => {
    const r = rig();
    // The turn is held INSIDE its model request: no child holds a slot then.
    const hold = Promise.withResolvers<void>();
    r.parent.steps.push({ gate: hold.promise, events: [text("first"), done] });
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(2);
    expect(logTypes(r)).not.toContain("subagent_background");
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    hold.resolve();
    await settle(6);
    // The id counter is untouched: the next child is sa-1.
    const started = r.agentJobs.start(
      { callId: "c0", agentType: "general", description: "later" },
      async () => ({ report: "R", toolUses: 0, stopReason: "end_turn" }),
    );
    expect(started).toEqual({ ok: true, agentId: "sa-1" });
    await settle(4);
  });
});

describe("T23: /clear right after a move", () => {
  test("the marker is re-emitted in the new segment, the row stays, the end lands there", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(4);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    // The turn carried on, then ended on its own: /clear needs an idle session.
    await settle(8);
    expect(r.hosted.running).toBe(false);
    r.hosted.clear();
    await settle(2);
    // The new segment re-emits the live marker (the ledger's segment facts).
    const entries = readAll(r);
    const base = entries.map((e) => e.type).lastIndexOf("base");
    expect(entries.slice(base + 1).some((e) => e.type === "subagent_background")).toBe(true);
    // The row is still there: /clear keeps the work.
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    gate.resolve();
    await settle(14);
    // …and its end lands in the new segment too, with the report as a note.
    const after = readAll(r);
    const baseAfter = after.map((e) => e.type).lastIndexOf("base");
    expect(after.slice(baseAfter + 1).some((e) => e.type === "subagent_end")).toBe(true);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
  });
});

describe("T24: close right after a move", () => {
  test("the child aborts, and no exit frame follows session_closed", async () => {
    const r = rig();
    const gate = heldForeground(r);
    prompt(r, "T1");
    await settle();
    r.hosted.enqueue("e1", "T1", "steer text");
    await settle(4);
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    r.hosted.close("closed");
    await settle(10);
    const kinds = typesOf(r.frames);
    expect(kinds).toContain("session_closed");
    expect(kinds.slice(kinds.indexOf("session_closed") + 1)).not.toContain("background_exit");
    // The RUNTIME aborted it. The ledger keeps its `bg` with no `end` on purpose
    // (6a: a reopen turns that into the lost note), so it is not the witness here.
    expect(r.agentJobs.list()).toEqual([]);
    expect(logTypes(r)).not.toContain("subagent_end");
    gate.resolve();
    await settle(6);
  });
});

describe("T25: a restart after a move", () => {
  test("marker with no end gives ONE lost note (6a's #5), through the real store", async () => {
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { SessionPersister } = await import("../src/session-persister.ts");
    const { LogSessionStore } = await import("../src/session-log-store.ts");
    const { SessionHost } = await import("../src/session-host.ts");
    const dir = await mkdtemp(join(tmpdir(), "subagent-detach-restart-"));
    try {
      const parent = new Model();
      const child = new Model();
      const permissions = new PermissionBroker();
      const requestPermission = permissions.request.bind(permissions);
      const build = (store: InstanceType<typeof LogSessionStore>) => {
        const persister = new SessionPersister({ store, cwd: "/w", model: "m", onError: () => {} });
        const runtimes: AgentJobs[] = [];
        const host = new SessionHost({
          defaultCwd: "/w",
          persister,
          createAgent: () => {
            const agentJobs = new AgentJobs(2);
            runtimes.push(agentJobs);
            const { run, types } = createSubagentRunner({
              model: child,
              env,
              tools: new ToolRegistry(),
              requestPermission,
            });
            const tools = new ToolRegistry().register(
              createTaskTool(run, types, { background: agentJobs }),
            );
            const agent = new Agent({
              model: parent,
              tools,
              env,
              agentJobs,
              systemPrompt: "s",
              maxIterations: 8,
              requestPermission,
            });
            return { agent, permissions, agentJobs };
          },
        });
        return { host, persister, runtimes };
      };
      const store = new LogSessionStore(dir);
      const first = build(store);
      const { hosted } = first.host.open({ create: true }, { send: () => {} });
      const gate = Promise.withResolvers<void>();
      parent.steps.push([fgTask("c1", "map repo"), done], [text("carried on"), done]);
      child.steps.push({ gate: gate.promise, events: [text("THE REPORT"), done] });
      hosted.prompt("T1", [{ type: "text", text: "go" }]);
      await settle();
      hosted.enqueue("e1", "T1", "steer text");
      await settle(6);
      expect(hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
      await hosted.persisted();
      await first.persister.stop(); // the "crash": the child dies with the process
      const id = hosted.id;

      // The reload: the marker with no `end` is ONE lost note.
      const loaded = await first.persister.load(id);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.record.loadNotes.map((m) => `${m.note?.kind}:${m.note?.id}`)).toEqual([
        "subagent_lost:sa-1",
      ]);
      gate.resolve();
      await store.drain();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
