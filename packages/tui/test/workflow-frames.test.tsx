/**
 * docs/feat/workflows-ui.md slice 2 (D3) — the FRAMES of the real `App` with a
 * workflow run in the session: the rail in the live area (mockup TUI 1), the
 * `/workflow` panel with its two columns (TUI 2), and the session with no run
 * feed at all. Rendered at a real terminal size (`renderAt`, `real-term.tsx`),
 * so Ink itself wraps at the width the assertion is made at.
 *
 * The pure decisions are `workflow-view.test.ts`'s; here the property is that
 * the App PAINTS them — and, above all, that the rail CANNOT move the input:
 * its rows are inside the live area's own budget, so the row the person types
 * on sits on the same terminal line with the rail as without it. "The frame's
 * height is constant" is a weaker claim and would not catch a rail painted
 * below the input.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import type { WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import { App, type SessionController } from "../src/App.tsx";
import { railLines } from "../src/workflow-view.ts";
import { renderAt } from "./real-term.tsx";
import { inertSession } from "./session-stub.ts";

const DOWN = "\u001B[B";
const ESC = "\u001B";
const ENTER = "\r";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A step of the fixture run (the shape the wire's `WorkflowStepRow` has). */
const step = (over: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id: "plan",
  kind: "agent",
  where: "local",
  state: "ok",
  attempt: 0,
  round: 0,
  ...over,
});

/**
 * The mockup's run (`docs/feat/agent-workflows/view.html` STEPS), on this
 * test's own numbers: two steps done, one failed, one running, a waiting gate
 * and the merge asking for approval.
 */
const STEPS: readonly WorkflowStepRow[] = [
  step({ id: "plan", model: "opus", durationMs: 124_000 }),
  step({ id: "exec", model: "deepseek", round: 1, maxRound: 1, durationMs: 850_000 }),
  step({ id: "review", state: "error", model: "opus", reason: "REQUEST-CHANGES" }),
  step({ id: "fix", state: "running", model: "deepseek", live: "edit packages/x.ts" }),
  step({ id: "gate", kind: "run", state: "waiting", where: "docker:phi" }),
  step({ id: "merge", kind: "approve", where: "", state: "needs-approval" }),
];

const RUN: WorkflowRow = {
  runId: "wf-1",
  name: "task",
  version: 3,
  hash: "a".repeat(64),
  state: "running",
  tokens: 1_200_000,
  budget: 3_000_000,
  startedAt: 1_000,
  steps: [...STEPS],
};

/** The same run, ended: the rail must be gone (its end is a transcript note). */
const ENDED: WorkflowRow = {
  ...RUN,
  state: "ok",
  endedAt: 2_000,
  steps: RUN.steps.map((s) => (s.state === "running" ? { ...s, state: "ok" } : s)),
};

const DETAIL = {
  attempt: 0,
  round: 0,
  live: false,
  prompt: "review the diff of the branch",
  report: "REQUEST-CHANGES: task.ts:380 misses an abort",
};

interface WorkflowApi {
  readonly session: SessionController;
  /** Every `session/workflow` the TUI sent, in order. */
  readonly actions: readonly unknown[];
  /** Every `session/workflow_step` the TUI asked for, as `runId/stepId`. */
  readonly reads: readonly string[];
  /** Push a new run list, as the daemon's `workflows` frame would. */
  readonly report: (rows: readonly WorkflowRow[]) => void;
}

/**
 * A session whose run list this test drives: `onWorkflows` delivers the first
 * report at once (as the client's does), then whatever `report` sends.
 */
function fake(rows: readonly WorkflowRow[], opts: { readonly noFeed?: boolean } = {}): WorkflowApi {
  const actions: unknown[] = [];
  const reads: string[] = [];
  let listener: ((rows: readonly WorkflowRow[]) => void) | null = null;
  const session = {
    ...inertSession(),
    async *send() {
      // A turn that never yields: the App stays idle and no reply is painted.
      yield* [] as never[];
    },
    watch: () => () => {},
    onWorkflows: (l: (rows: readonly WorkflowRow[]) => void) => {
      listener = l;
      l(rows);
      return () => {
        listener = null;
      };
    },
    workflowStep: (runId: string, stepId: string) => {
      reads.push(`${runId}/${stepId}`);
      return Promise.resolve({ detail: DETAIL });
    },
    workflow: (params: unknown) => {
      actions.push(params);
      return Promise.resolve({ ok: true, runId: "wf-1" });
    },
    ownsTurn: () => true,
    close() {},
    ...(opts.noFeed === true
      ? {
          // An older daemon (or a pod): the session has no run feed at all.
          onWorkflows: undefined,
          workflow: undefined,
          workflowStep: undefined,
        }
      : {}),
  } as unknown as SessionController;
  return {
    session,
    actions,
    reads,
    report: (next) => listener?.(next),
  };
}

async function mount(api: WorkflowApi, columns = 120) {
  const term = renderAt(
    <App
      createSession={() => api.session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
    />,
    { columns, rows: 40 },
  );
  await delay(60);
  const line = async (text: string, settle = 100) => {
    term.stdin.write(text);
    await delay(20);
    term.stdin.write(ENTER);
    await delay(settle);
  };
  return { term, line, frame: () => term.frame() };
}

/** The frame as rows (SGR already stripped by `renderAt`). */
const rowsOf = (frame: string): string[] => frame.split("\n").map((row) => row.trimEnd());

/** The terminal row (0-based) of the FIRST row containing `needle`. */
const rowOf = (frame: string, needle: string): number =>
  rowsOf(frame).findIndex((row) => row.includes(needle));

describe("slice 2 TUI 1: the rail, in the live area", () => {
  test("the App paints the run exactly as `railLines` projects it", async () => {
    const api = fake([RUN]);
    const t = await mount(api);
    const frame = t.frame();
    const lines = railLines(RUN, 120, Date.now());
    // Non-vacuity: the projection really has the mockup's rows.
    expect(lines.map((l) => l.text)).toContain("workflow task · 2/6 · 1.2M/3M tok");
    expect(lines.some((l) => /✓\s+plan\s+ok/.test(l.text))).toBe(true);
    // Every projected row is on screen, in order, and nothing the projection did
    // not produce: the component re-derives no cell (AGENTS §7).
    const rows = rowsOf(frame);
    const first = rows.indexOf(lines[0]?.text ?? "MISSING");
    expect(first).toBeGreaterThanOrEqual(0);
    for (const [i, line] of lines.entries()) {
      expect(rows[first + i]).toBe(line.text);
    }
    // The mockup's own words, so a reader can compare frame and mockup by eye.
    expect(frame).toContain("▸   fix    running        deepseek   [local]   …");
    expect(frame).toContain("    ↳ edit packages/x.ts");
    expect(frame).toContain("?   merge  needs approval");
    t.term.unmount();
  });

  test("the input sits on the SAME row with and without the rail (the exact property)", async () => {
    const withRail = await mount(fake([RUN]));
    const frameA = withRail.frame();
    const inputA = rowOf(frameA, "Type a task or /command");
    expect(frameA).toContain("workflow task · 2/6");
    expect(inputA).toBeGreaterThan(0);
    withRail.term.unmount();

    // The same session while its run has ENDED: no rail at all (its end is an
    // ordinary transcript note), the long transcript keeps its rows.
    const noRail = await mount(fake([ENDED]));
    const frameB = noRail.frame();
    const inputB = rowOf(frameB, "Type a task or /command");
    expect(frameB).not.toContain("workflow task");
    expect(inputB).toBeGreaterThan(0);
    // The property: the rail costs the TRANSCRIPT rows, never the input's place.
    expect(inputB).toBe(inputA);
    // …and the status bar (the frame's last row) is unmoved too.
    expect(rowsOf(frameB).length).toBe(rowsOf(frameA).length);
    noRail.term.unmount();
  });

  test("a run that ends while the TUI follows it: the rail leaves, the input stays", async () => {
    const api = fake([RUN]);
    const t = await mount(api);
    const before = rowOf(t.frame(), "Type a task or /command");
    expect(t.frame()).toContain("workflow task");
    api.report([ENDED]);
    await delay(120);
    const frame = t.frame();
    expect(frame).not.toContain("workflow task");
    expect(rowOf(frame, "Type a task or /command")).toBe(before);
    t.term.unmount();
  });

  test("the rail keeps its width tiers: the WORD survives a narrow terminal", async () => {
    const api = fake([RUN]);
    const t = await mount(api, 60);
    const frame = t.frame();
    // 60 columns: `[where]` and `model` are gone, the word is not.
    expect(frame).toContain("waiting");
    expect(frame).toContain("needs approval");
    expect(frame).not.toContain("[docker]");
    expect(frame).not.toContain("deepseek");
    t.term.unmount();
  });
});

describe("slice 2 TUI 2: the /workflow panel", () => {
  test("/workflow opens the two-column panel on the run in flight", async () => {
    const api = fake([RUN]);
    const t = await mount(api);
    await t.line("/workflow");
    const frame = t.frame();
    expect(frame).toContain("Workflow task · 2/6");
    expect(frame).toContain("↑↓ step · r rerun · o prompt/report · esc close");
    // The left column starts on the first step; the right one offers `o`.
    expect(frame).toContain("›✓ ok");
    expect(frame).toContain("[o] prompt and report");
    // The rail is gone while the panel owns that slot (the panel IS the graph).
    expect(frame).not.toContain("workflow task · 2/6 · 1.2M/3M tok");
    t.term.unmount();
  });

  test("↓ moves the cursor; `o` paints the fetched report; `r` sends rerun_step", async () => {
    const api = fake([RUN]);
    const t = await mount(api);
    await t.line("/workflow");
    t.term.stdin.write(DOWN);
    await delay(60);
    // The cursor is on `exec` now: its own detail is the right column's, and the
    // fetch has not been asked for yet (only `o` reads a step's log entry).
    const moved = t.frame();
    expect(moved).toMatch(/›✓ ok\s+exec\s+│/);
    expect(api.reads).toEqual([]);
    t.term.stdin.write("o");
    await delay(120);
    const fetched = t.frame();
    expect(api.reads).toEqual(["wf-1/exec"]);
    expect(fetched).toContain("prompt:");
    expect(fetched).toContain("review the diff");
    expect(fetched).toContain("task.ts:380 misses an abort");
    t.term.stdin.write("r");
    await delay(120);
    expect(api.actions).toEqual([{ action: "rerun_step", runId: "wf-1", stepId: "exec" }]);
    // The reply is a notice (`workflowReplyNotice`), never a silent success.
    expect(t.frame()).toContain("Re-running exec.");
    // Esc closes it and the rail comes back (the run is still live).
    t.term.stdin.write(ESC);
    await delay(120);
    const closed = t.frame();
    expect(closed).not.toContain("↑↓ step");
    expect(closed).toContain("workflow task · 2/6 · 1.2M/3M tok");
    t.term.unmount();
  });

  test("/workflow run|stop|resume send the action; a refusal and a bad line are notices", async () => {
    const api = fake([RUN]);
    const t = await mount(api);
    await t.line("/workflow run task branch=main");
    expect(api.actions).toEqual([
      { action: "start", name: "task", inputs: [{ name: "branch", value: "main" }] },
    ]);
    expect(t.frame()).toContain("Started workflow task.");
    await t.line("/workflow stop");
    expect(api.actions[1]).toEqual({ action: "stop", runId: "wf-1" });
    // Nothing stopped to resume: refused locally, NOTHING sent.
    await t.line("/workflow resume");
    expect(api.actions.length).toBe(2);
    expect(t.frame()).toContain("No stopped workflow run to resume.");
    await t.line("/workflow bogus");
    expect(api.actions.length).toBe(2);
    expect(t.frame()).toContain("Usage: /workflow");
    t.term.unmount();
  });

  test("the daemon's refusal is shown as its own reason", async () => {
    const api = fake([RUN]);
    const refusing = {
      ...api,
      session: {
        ...api.session,
        workflow: () => Promise.resolve({ ok: false, reason: "a run is already going" }),
      } as unknown as SessionController,
    };
    const t = await mount(refusing);
    await t.line("/workflow run task");
    expect(t.frame()).toContain("a run is already going");
    expect(t.frame()).not.toContain("Started workflow task.");
    t.term.unmount();
  });

  test("a session with no run feed says so, and never paints an empty panel", async () => {
    const api = fake([], { noFeed: true });
    const t = await mount(api);
    await t.line("/workflow");
    const frame = t.frame();
    expect(frame).toContain("Workflows are not supported by this session.");
    expect(frame).not.toContain("Workflow task");
    t.term.unmount();
  });
});
