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
import { initialStream, reduceStream } from "../../client/src/session-reducer.ts";
import { HostedSession } from "../src/hosted-session.ts";

// docs/feat/subagent-background.md, 6a-1 — the daemon half: a child outlives
// its turn, its exit streams + logs + wakes, its ask is held apart from any turn.

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
const launch = (id: string, description: string): StreamEvent =>
  call(id, "agent_task", { description, prompt: "go", background: true });

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
const ASK = { tool: "needs_ok", level: "ask" as const, title: "t", input: {} };

function rig(
  opts: {
    cap?: number;
    attach?: boolean;
    now?: () => number;
    ringBytes?: number;
    updates?: readonly string[];
    /** Default true: the daemon wakes on an exit. false: a pod daemon (no autonomous wake). */
    wake?: boolean;
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
  });
  const session = new Session(agent, "s1", {});
  const hosted = new HostedSession(
    "s1",
    session,
    permissions,
    undefined,
    {},
    opts.ringBytes,
    opts.now ?? Date.now,
    undefined,
    {},
    opts.wake === false ? undefined : {},
    {},
    agentJobs,
  );
  const frames: KnownSessionUpdateParams[] = [];
  if (opts.attach !== false) {
    hosted.attach({
      send: (p) => frames.push(p),
      ...(opts.updates ? { updates: opts.updates } : {}),
    });
  }
  return { parent, child, permissions, hosted, frames, agentJobs, session, agent };
}
type Rig = ReturnType<typeof rig>;

const typesOf = (f: readonly KnownSessionUpdateParams[]) => f.map((p) => p.update.type);
const asks = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "permission_request" ? [p.update] : []));
const turnStarts = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "turn_start" ? [p.update.turnId] : []));
const prompt = (r: Rig, id: string, t = "go") => r.hosted.prompt(id, [{ type: "text", text: t }]);
const priv = (r: Rig) =>
  r.hosted as unknown as {
    recordCut(t: string | null): void;
    historyReplaced(reason: "compact" | "context_reset"): void;
    pendingList(): unknown[];
    carried: unknown[];
    agentJobs: { segmentFacts(): unknown[] };
  };

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

describe("T19: a child outlives its turn; its exit streams, logs, wakes once", () => {
  test("turn_end first, then background_exit{agent}, the `end` marker, ONE wake turn that reads the report", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    r.parent.steps.push(
      [launch("c1", "map repo"), done],
      [text("started it"), done],
      [text("read it"), done],
    );
    r.child.steps.push({ gate: gate.promise, events: [text("THE REPORT"), done] });
    prompt(r, "T1");
    await settle();
    expect(typesOf(r.frames).at(-1)).toBe("turn_end");
    expect(r.hosted.agentJobsRunning().map((j) => j.agentId)).toEqual(["sa-1"]);
    expect(turnStarts(r.frames)).toEqual(["T1"]);

    gate.resolve();
    await settle(14);
    const ids = turnStarts(r.frames);
    expect(ids).toHaveLength(2);
    expect(ids[1]?.startsWith("wake-")).toBe(true);
    const exit = r.frames.map((p) => p.update).find((u) => u.type === "background_exit");
    expect(exit).toMatchObject({
      jobId: "sa-1",
      command: "map repo",
      status: "exited",
      exitCode: null,
      agent: { stopReason: "end_turn" },
    });
    expect(typesOf(r.frames).indexOf("background_exit")).toBeGreaterThan(
      typesOf(r.frames).indexOf("turn_end"),
    );
    const last = r.parent.seen.at(-1)?.messages.at(-1);
    expect(last?.content).toBe(
      "[background] sub-agent sa-1 (map repo) finished (end_turn):\nTHE REPORT",
    );
    expect(last?.note).toEqual({ kind: "subagent_report", id: "sa-1" });
    expect(r.hosted.unflushedExits).toBe(0);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    const log = readAll(r).map((e) => e.type);
    expect(log).toContain("subagent_background");
    expect(log).toContain("subagent_end");
  });

  test("T20: no wake after a bad end; the next prompt delivers the report", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    r.parent.steps.push([launch("c1", "map repo"), done], {
      gate: hold.promise,
      events: [text("x"), done],
    });
    r.child.steps.push({ gate: gate.promise, events: [text("REPORT-2"), done] });
    prompt(r, "T1");
    await settle();
    // T1 is held in its second round; Esc cancels it (a bad end).
    r.hosted.cancel();
    hold.resolve();
    await settle(6);
    expect(r.hosted.running).toBe(false);
    gate.resolve();
    await settle(10);
    expect(turnStarts(r.frames)).toEqual(["T1"]);
    expect(r.hosted.unflushedExits).toBe(1);
    prompt(r, "T2", "next");
    await settle(10);
    expect(turnStarts(r.frames)).toEqual(["T1", "T2"]);
    const last = r.parent.seen
      .at(-1)
      ?.messages.map((m) => m.content)
      .join("\n");
    expect(last).toContain("REPORT-2");
    expect(r.hosted.unflushedExits).toBe(0);
  });
});

describe("T21: H2 liveness", () => {
  test("busy and jobs count a running child; lastActiveAt moves when it ends", async () => {
    let t = 1000;
    // No wake: the only thing that can move the stamp after the child's end is the end itself.
    const r = rig({ now: () => t, wake: false });
    const gate = Promise.withResolvers<void>();
    r.parent.steps.push([launch("c1", "map repo"), done], [text("started"), done]);
    r.child.steps.push({ gate: gate.promise, events: [text("R"), done] });
    prompt(r, "T1");
    await settle();
    expect(r.hosted.running).toBe(false);
    expect(r.hosted.liveness().busy).toBe(true);
    expect(r.hosted.summary("/w").jobs).toBe(1);
    t = 5000;
    const before = r.hosted.liveness().lastActiveAt;
    gate.resolve();
    await settle(10);
    expect(r.hosted.liveness().busy).toBe(false);
    expect(r.hosted.summary("/w").jobs).toBe(0);
    expect(r.hosted.liveness().lastActiveAt).toBe(5000);
    expect(before).toBeLessThan(5000);
  });
});

/** A child that asks for needs_ok, held by `gate` until the ask is wanted. */
function askingChild(r: Rig, gate: Promise<void>): void {
  r.parent.steps.push([launch("c1", "map repo"), done], [text("started"), done]);
  r.child.steps.push({ gate, events: [call("k1", "needs_ok"), done] }, [text("CHILD DONE"), done]);
}

describe("H3: a background child's ask", () => {
  test("T22: shown with agent.id and the spawning turnId, with no turn running; the answer runs the tool", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    expect(r.hosted.running).toBe(false);
    gate.resolve();
    await settle();
    const shown = asks(r.frames);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.agent).toMatchObject({ type: "general", description: "map repo", id: "sa-1" });
    expect(shown[0]?.turnId).toBe("T1");
    expect(shown[0]?.toolCallId).toBe("c1");
    const requestId = shown[0]?.requestId ?? "";
    r.hosted.resolvePermission(requestId, "allow_once");
    await settle(10);
    expect(ran).toEqual(["needs_ok"]);
  });

  test("T23: Esc on a later turn leaves the ask pending (raised DURING that turn)", async () => {
    const r = rig({ wake: false });
    const gate = Promise.withResolvers<void>();
    const hold = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    // T2 is running (held in its model call) when the child asks.
    r.parent.steps.push({ gate: hold.promise, events: [text("x"), done] });
    prompt(r, "T2", "other");
    await settle(2);
    expect(r.hosted.running).toBe(true);
    gate.resolve();
    await settle(3);
    expect(asks(r.frames)).toHaveLength(1);
    r.hosted.cancel();
    hold.resolve();
    await settle(4);
    expect(typesOf(r.frames)).not.toContain("permission_resolved");
    const requestId = asks(r.frames)[0]?.requestId ?? "";
    r.hosted.resolvePermission(requestId, "allow_once");
    await settle(10);
    expect(ran).toEqual(["needs_ok"]);
  });

  test("T24: a fresh attach after the cut moved is shown the pending ask", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle();
    priv(r).recordCut("T1");
    const fresh: KnownSessionUpdateParams[] = [];
    r.hosted.attach({ send: (p) => fresh.push(p) });
    const got = asks(fresh);
    expect(got).toHaveLength(1);
    expect(got[0]?.requestId).toBe(asks(r.frames)[0]?.requestId ?? "?");
  });

  test("T25: a compaction re-offers the ask after history_replaced, and the client's keepRequests keeps it", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle();
    const before = r.frames.length;
    priv(r).historyReplaced("compact");
    const after = r.frames.slice(before).map((p) => p.update);
    const at = after.findIndex((u) => u.type === "history_replaced");
    expect(at).toBeGreaterThanOrEqual(0);
    const again = after.slice(at + 1).filter((u) => u.type === "permission_request");
    expect(again).toHaveLength(1);
    expect(again[0]).toMatchObject({ requestId: asks(r.frames)[0]?.requestId });

    // The client's reducer keeps the request through the barrier's snapshot.
    let st = reduceStream(initialStream, { kind: "open_sent" }).state;
    st = reduceStream(st, {
      kind: "open_result",
      created: true,
      resync: false,
      epoch: "e1",
      now: 1,
    }).state;
    for (const p of r.frames.slice(before)) {
      st = reduceStream(st, { kind: "update", params: p, now: 2 } as never).state;
    }
    const snap = reduceStream(st, {
      kind: "snapshot",
      messages: [],
      since: { epoch: "e2", seq: 0 },
      turn: null,
      now: 3,
    });
    const reset = snap.out.find((o) => o.kind === "reset");
    const keep = reset && "keepRequests" in reset ? reset.keepRequests : [];
    expect(keep).toContain(asks(r.frames)[0]?.requestId ?? "?");
  });

  test("T26: never persisted: not in pendingList, and settling it does not clear `carried`", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle();
    expect(priv(r).pendingList()).toEqual([]);
    const sentinel = { toolCallId: "z", tool: "t", resumable: true, requestedAt: 1 };
    priv(r).carried = [sentinel];
    r.hosted.resolvePermission(asks(r.frames)[0]?.requestId ?? "", "allow_once");
    // Right after the settle (the child's end later wakes a turn, whose end clears `carried` by its own rule).
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(priv(r).carried).toEqual([sentinel]);
    await settle(10);
  });

  test("T27: no client attached: held, shown at attach, answered", async () => {
    const r = rig({ attach: false });
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle(6);
    expect(ran).toEqual([]);
    const late: KnownSessionUpdateParams[] = [];
    r.hosted.attach({ send: (p) => late.push(p) });
    // The original frame (it sat in the ring past the cut) and the re-offer: one
    // request id, which the router dedupes.
    const got = asks(late);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(new Set(got.map((a) => a.requestId)).size).toBe(1);
    r.hosted.resolvePermission(got[0]?.requestId ?? "", "allow_once");
    await settle(10);
    expect(ran).toEqual(["needs_ok"]);
  });

  test("T28: a client that did not declare permission_request denies with the reason", async () => {
    const r = rig({
      updates: ["agent_message_chunk", "turn_start", "turn_end", "background_exit"],
    });
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle(10);
    expect(asks(r.frames)).toEqual([]);
    expect(ran).toEqual([]);
    // The child was told why and finished with a report.
    const note =
      r.parent.seen
        .at(-1)
        ?.messages.map((m) => m.content)
        .join("\n") ?? "";
    expect(note).toContain("CHILD DONE");
    const childSaw = r.child.seen
      .flatMap((q) => q.messages)
      .map((m) => m.content)
      .join("\n");
    expect(childSaw).toContain("does not support permission_request");
  });

  test("T29: the ask reaches the requester HostedSession installed on the shared broker", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    const spy = new PermissionBroker();
    let spyCalls = 0;
    spy.setRequester(async () => {
      spyCalls++;
      return { allowed: true };
    });
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle();
    expect(asks(r.frames)).toHaveLength(1);
    expect(spyCalls).toBe(0);
  });

  test("T30: close aborts the child, settles its ask, and emits no exit after session_closed", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    askingChild(r, gate.promise);
    prompt(r, "T1");
    await settle();
    gate.resolve();
    await settle();
    expect(asks(r.frames)).toHaveLength(1);
    r.hosted.close("closed");
    await settle(10);
    const kinds = typesOf(r.frames);
    expect(kinds).toContain("session_closed");
    expect(kinds.slice(kinds.indexOf("session_closed") + 1)).not.toContain("background_exit");
    expect(ran).toEqual([]);
    expect(r.agentJobs.list()).toEqual([]);
  });
});

describe("the flush closes the note (task 5 review L3)", () => {
  test("T31: a reset in the same uncommitted window re-emits no sub-agent marker", async () => {
    const r = rig({ wake: false });
    const hold = Promise.withResolvers<void>();
    r.agentJobs.start(
      { callId: "c0", agentType: "general", description: "map repo" },
      async () => ({
        report: "R",
        toolUses: 0,
        stopReason: "end_turn",
      }),
    );
    await settle(3);
    // Exit pending, idle. T2's first model request is held: the note is pushed
    // and its event seen by `drive`, but nothing has committed yet.
    r.parent.steps.push({ gate: hold.promise, events: [text("x"), done] });
    prompt(r, "T2", "next");
    await settle(4);
    expect(priv(r).agentJobs.segmentFacts()).toEqual([]);
    priv(r).historyReplaced("context_reset");
    const entries = readAll(r);
    let base = -1;
    entries.forEach((e, i) => {
      if (e.type === "base") base = i;
    });
    expect(
      entries
        .slice(base + 1)
        .some((e) => e.type === "subagent_background" || e.type === "subagent_end"),
    ).toBe(false);
    hold.resolve();
    await settle(4);
  });
});

describe("a settings sync keeps the runtime (T32)", () => {
  test("reusable() carries the AgentJobs, and an exit after the swap reaches the new agent", async () => {
    const r = rig();
    expect(r.hosted.reusable().agentJobs).toBe(r.agentJobs);
    const next = new Agent({
      model: new Model(),
      tools: new ToolRegistry(),
      env,
      agentJobs: r.agentJobs,
      systemPrompt: "s2",
    });
    r.hosted.swapAgent(next, {
      settingsReport: { applied: [], ignored: [] } as never,
      id: "s1",
    });
    r.agentJobs.start(
      { callId: "c0", agentType: "general", description: "after swap" },
      async () => ({
        report: "R",
        toolUses: 0,
        stopReason: "end_turn",
      }),
    );
    for (let i = 0; i < 10; i++) await Promise.resolve(); // microtasks only: the wake is a macrotask
    // Exactly ONE agent collects it: the new one (the old one was retired). The
    // wake may already be flushing it, so look before the macrotask: pending 1.
    expect(r.agent.pendingExitCount).toBe(0);
    expect(next.pendingExitCount).toBe(1);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
  });
});
