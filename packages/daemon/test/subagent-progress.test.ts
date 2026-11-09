/**
 * 6a-2 daemon half (docs/feat/subagent-background-ui.md Design 3): the live
 * list of a session's background sub-agents. T42 is the load-bearing
 * assumption — a child's activity reaches an idle client through its own
 * display update plus the snapshot at the cut, never through a turn's stream.
 */
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
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { z } from "zod";
import { HostedSession, SUBAGENTS_COALESCE_MS } from "../src/hosted-session.ts";
import { sameRows, subagentRows } from "../src/subagents-view.ts";

const macro = () => new Promise((r) => setTimeout(r, 2));
/** Two coalescing windows plus slack: any due frame has landed. */
const COALESCE_DOUBLE = 2 * 250 + 80;
/** Wait for a state (a frame is asynchronous: its own windows and turns). */
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await macro();
  }
}
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
const free: Tool = {
  name: "free_read",
  description: "d",
  inputSchema: empty,
  permission: "none",
  execute: async () => ({ content: "read" }),
};

function rig(opts: { cap?: number; ringBytes?: number; now?: () => number } = {}) {
  const parent = new Model();
  const child = new Model();
  const permissions = new PermissionBroker();
  const requestPermission = permissions.request.bind(permissions);
  const agentJobs = new AgentJobs(opts.cap ?? 2);
  const { run, types } = createSubagentRunner({
    model: child,
    env,
    tools: new ToolRegistry().register(free),
    requestPermission,
  });
  const parentTools = new ToolRegistry()
    .register(free)
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
    // No autonomous wake: a wake turn would inject the exit's note and make the
    // "no tool_progress in any turn" assertion vacuous.
    undefined,
    {},
    agentJobs,
  );
  const frames: KnownSessionUpdateParams[] = [];
  const attach = (sink = frames) => hosted.attach({ send: (p) => sink.push(p) });
  attach();
  return { parent, child, hosted, frames, agentJobs, attach, permissions, session };
}
type Rig = ReturnType<typeof rig>;

const typesOf = (f: readonly KnownSessionUpdateParams[]) => f.map((p) => p.update.type);
const subagentFrames = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "subagents" ? [p.update.agents] : []));
const prompt = (r: Rig, id: string, t = "go") => r.hosted.prompt(id, [{ type: "text", text: t }]);
const priv = (r: Rig) =>
  r.hosted as unknown as {
    ring: { bytes: number };
  };

/** A child held at the start of its run, so the turn ends before it does anything. */
function idleChild(r: Rig) {
  const start = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  r.parent.steps.push([launch("c1", "map repo"), done], [text("started it"), done]);
  r.child.steps.push(
    { gate: start.promise, events: [call("k1", "free_read"), done] },
    // Holds AFTER its tool ran: the child is live with one tool use and no turn.
    { gate: finish.promise, events: [text("THE REPORT"), done] },
  );
  return { start, finish };
}

describe("T42 (load-bearing): an idle child's activity reaches an idle client", () => {
  test("subagents frames appear BETWEEN turns, with the child's rows; the turn's stream carries no tool_progress", async () => {
    const r = rig();
    const gate = idleChild(r);
    prompt(r, "T1");
    await settle();
    // The turn is over and the child is still running: nothing is turn-scoped.
    expect(r.hosted.running).toBe(false);
    expect(r.agentJobs.rows().map((x) => x.id)).toEqual(["sa-1"]);
    const afterTurn = typesOf(r.frames).length;
    expect(typesOf(r.frames).at(-1)).toBe("turn_end");

    gate.start.resolve();
    // A progress change coalesces within one window: bounded latency, no burst.
    await Bun.sleep(SUBAGENTS_COALESCE_MS + 60);
    const late = typesOf(r.frames).slice(afterTurn);
    // The whole story of the child reached the client with no turn at all.
    expect(late).toContain("subagents");
    expect(late).not.toContain("turn_start");
    // Its activity is in the row: the tool it ran, and the description it was launched with.
    const rows = subagentFrames(r.frames).at(-1);
    expect(rows?.[0]).toMatchObject({
      id: "sa-1",
      callId: "c1",
      agentType: "general",
      description: "map repo",
      state: "running",
      toolUses: 1,
      tail: ["free_read"],
    });
    // H1: a child's progress never rides the turn's stream (6a-1's finding).
    expect(typesOf(r.frames)).not.toContain("tool_progress");
    gate.finish.resolve();
    await settle(16);
    // The end empties the list.
    expect(subagentFrames(r.frames).at(-1)).toEqual([]);
  });

  test("the list is a full state each time: a second child shows both, then one", async () => {
    const r = rig();
    const gate = idleChild(r);
    prompt(r, "T1");
    await settle();
    const secondStop = () => {
      for (const row of r.agentJobs.rows()) r.agentJobs.kill(row.id);
    };
    const second = r.agentJobs.start(
      { callId: "c2", agentType: "general", description: "other" },
      async (c) =>
        new Promise((resolve) => {
          c.signal.addEventListener("abort", () =>
            resolve({ report: "", toolUses: 0, stopReason: "cancelled" }),
          );
        }),
    );
    expect(second.ok).toBe(true);
    gate.start.resolve();
    await Bun.sleep(COALESCE_DOUBLE);
    expect(
      subagentFrames(r.frames)
        .at(-1)
        ?.map((x) => x.id),
    ).toEqual(["sa-1", "sa-2"]);
    gate.finish.resolve();
    // A death is published at once, never on a window.
    await until(() => r.agentJobs.rows().length === 1);
    expect(
      subagentFrames(r.frames)
        .at(-1)
        ?.map((x) => x.id),
    ).toEqual(["sa-2"]);
    secondStop();
  });
});

describe("T43: bursts coalesce; a start and an end publish at once", () => {
  test("100 progress events make at most one frame per window; a start and an end are never delayed", async () => {
    const r = rig();
    const gate = idleChild(r);
    prompt(r, "T1");
    await settle();
    // The start published at once: the client saw the row before the turn ended.
    expect(subagentFrames(r.frames).at(-1)?.length).toBe(1);
    const before = subagentFrames(r.frames).length;
    gate.start.resolve();
    // 100 raw progress events, all inside one window.
    for (let i = 0; i < 100; i++) {
      r.agentJobs.progress("sa-1", { kind: "subagent_tool", label: `t${i}` });
    }
    await Bun.sleep(SUBAGENTS_COALESCE_MS + 60);
    const burst = subagentFrames(r.frames).length - before;
    // One frame per window, never 100; and the row folded all of them (plus the
    // one tool the child itself ran before these).
    expect(burst).toBe(1);
    const folded = subagentFrames(r.frames).at(-1)?.[0];
    expect(folded?.toolUses).toBe(101);
    // The last 8 only: a long turn cannot grow a row without bound.
    expect(folded?.tail).toHaveLength(8);
    expect(folded?.tail.at(-1)).toBe("free_read");
    // The end publishes immediately: no window of latency on a death.
    const ended = Date.now();
    gate.finish.resolve();
    await until(() => subagentFrames(r.frames).at(-1)?.length === 0);
    expect(Date.now() - ended).toBeLessThan(SUBAGENTS_COALESCE_MS);
  });
});

describe("T44: the ring stays under budget while idle", () => {
  test("a burst of large frames on an idle session leaves the replay ring bounded", async () => {
    // The cut is what pins the ring: `emit` pushes with the cut's seq and
    // eviction never removes an entry past it. Mid-turn that pin is right (the
    // turn's changes are all in the log at its commit); IDLE, it must move, or
    // every frame since the last commit is retained however big the burst. The
    // snapshot carries the list, so the frames need not be replayable.
    const r = rig({ ringBytes: 2048, cap: 40 });
    const gate = idleChild(r);
    prompt(r, "T1");
    await settle();
    gate.finish.resolve();
    // 30 children, each row carrying the longest description and tail the view
    // passes through: one frame is far larger than the whole ring budget.
    const long = "d".repeat(300);
    for (let i = 0; i < 30; i++) {
      r.agentJobs.start({ callId: `c${i}`, agentType: "general", description: long }, async (c) => {
        for (let j = 0; j < 8; j++) {
          r.agentJobs.progress(`sa-${i + 1}`, { kind: "subagent_tool", label: long });
        }
        return new Promise((resolve) =>
          c.signal.addEventListener("abort", () =>
            resolve({ report: "", toolUses: 0, stopReason: "cancelled" }),
          ),
        );
      });
    }
    await settle(20);
    // Bounded by the budget, not by what the burst produced.
    expect(priv(r).ring.bytes).toBeLessThanOrEqual(2048);
    // And the state is still reachable: the snapshot has the live list.
    const rowCount = r.hosted.snapshotPage().subagents?.length ?? 0;
    expect(rowCount).toBeGreaterThan(0);
    for (const row of r.agentJobs.rows()) {
      r.agentJobs.kill(row.id);
    }
    await settle(10);
  });
});

describe("T45: a fresh attach gets the list from the snapshot", () => {
  test("the first page carries the rows at the cut, and the frame after it is live", async () => {
    const r = rig();
    const gate = idleChild(r);
    prompt(r, "T1");
    await settle();
    // A client that was never attached reads the state from the snapshot.
    expect(r.hosted.snapshotPage().subagents?.map((x) => x.id)).toEqual(["sa-1"]);
    gate.start.resolve();
    const late: KnownSessionUpdateParams[] = [];
    r.attach(late);
    // Nothing was replayed for the row (the cut is at or after its frame) but
    // the snapshot already had it.
    expect(late.some((p) => p.update.type === "subagents")).toBe(false);
    gate.finish.resolve();
    await until(() => late.some((p) => p.update.type === "subagents"));
    // From then on the new client sees the live list converge to empty.
    expect(
      late.flatMap((p) => (p.update.type === "subagents" ? [p.update.agents] : [])).at(-1),
    ).toEqual([]);
  });

  test("a second page carries none (first page only, like `queued`)", async () => {
    const r = rig();
    const gate = idleChild(r);
    prompt(r, "T1");
    await settle();
    gate.start.resolve();
    await Bun.sleep(SUBAGENTS_COALESCE_MS + 60);
    const first = r.hosted.snapshotPage(undefined, 1);
    expect(first.subagents?.length).toBe(1);
    if (first.cursor !== undefined) {
      expect(r.hosted.snapshotPage(first.cursor).subagents).toBeUndefined();
    }
    gate.finish.resolve();
    await settle(10);
  });
});

describe("the view: untrusted labels are sanitized, and rows compare cheaply", () => {
  test("a label is one line, cut to 200 cells; a long description too", () => {
    const rows = subagentRows([
      {
        id: "sa-1",
        callId: "c1",
        agentType: "general",
        description: `a\nb\tc${"d".repeat(400)}`,
        state: "running",
        toolUses: 2,
        tokens: 5,
        startedAt: 1,
        tail: ["x\u0000y\nz"],
      },
    ]);
    expect(rows[0]?.description.includes("\n")).toBe(false);
    expect(rows[0]?.description.length).toBeLessThanOrEqual(200);
    expect(rows[0]?.tail).toEqual(["x y z"]);
    expect(rows[0]?.toolUses).toBe(2);
  });

  test("sameRows is true for equal rows and false for any difference", () => {
    const row = {
      id: "sa-1",
      callId: "c1",
      agentType: "general",
      description: "d",
      state: "running",
      toolUses: 1,
      tokens: 2,
      startedAt: 3,
      tail: ["a"],
    };
    expect(sameRows([row], [{ ...row }])).toBe(true);
    expect(sameRows([row], [{ ...row, toolUses: 2 }])).toBe(false);
    expect(sameRows([row], [{ ...row, tail: ["b"] }])).toBe(false);
    expect(sameRows([row], [])).toBe(false);
    expect(sameRows([], [])).toBe(true);
  });
});
