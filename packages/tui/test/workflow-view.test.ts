/**
 * docs/feat/workflows-ui.md slice 2 (D3) — the PURE half: how a run reads as a
 * rail, how the `/workflow` panel projects, its keys, and the command's words.
 *
 * The property every assertion serves: state is glyph + WORD (never colour),
 * an unknown state is painted as its own word, free text is flattened, and a
 * long graph windows around the active step rather than being cut.
 */
import { describe, expect, test } from "bun:test";
import type { WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import { type OpenPanel, workflowPanel } from "../src/panel.ts";
import { withWorkflowDetail, withWorkflowsData } from "../src/panels/workflow.ts";
import {
  WORKFLOW_APPROVE_HINT,
  WORKFLOW_DETAIL_GONE,
  WORKFLOW_DETAIL_UNSUPPORTED,
  WORKFLOW_RAIL_MAX_STEPS,
  WORKFLOW_USAGE,
  currentRun,
  doneCount,
  parseWorkflowCommand,
  railLines,
  railWindow,
  selectedStep,
  stateLook,
  workflowKey,
  workflowMove,
  workflowPanelView,
  workflowRailLines,
  workflowReplyNotice,
  workflowTarget,
} from "../src/workflow-view.ts";

const step = (over: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id: "plan",
  kind: "agent",
  where: "local",
  state: "ok",
  attempt: 0,
  round: 0,
  ...over,
});

const run = (over: Partial<WorkflowRow> = {}): WorkflowRow => ({
  runId: "wf-1",
  name: "task",
  version: 3,
  hash: "a".repeat(64),
  state: "running",
  tokens: 1_200_000,
  budget: 3_000_000,
  startedAt: 1_000,
  steps: [],
  ...over,
});

describe("stateLook: glyph + WORD, never colour alone", () => {
  test("every known state carries its own glyph and word", () => {
    expect(stateLook("ok")).toMatchObject({ glyph: "✓", word: "ok" });
    expect(stateLook("error")).toMatchObject({ glyph: "✗", word: "error" });
    expect(stateLook("running")).toMatchObject({ glyph: "▸", word: "running" });
    expect(stateLook("waiting")).toMatchObject({ glyph: "⧗", word: "waiting" });
    expect(stateLook("needs-approval")).toMatchObject({ glyph: "?", word: "needs approval" });
    expect(stateLook("stopped")).toMatchObject({ glyph: "‖", word: "stopped" });
    expect(stateLook("pending")).toMatchObject({ glyph: "○", word: "pending" });
  });

  test("an UNKNOWN state (a newer daemon's) is its own word, never coerced", () => {
    // Mutation: defaulting to `pending` → the word would read "pending".
    expect(stateLook("escalated")).toMatchObject({ glyph: "·", word: "escalated" });
    // A multi-line / escape-laden state is flattened before it paints.
    expect(stateLook("weird\nstate").word).toBe("weird state");
    expect(stateLook("").word).toBe("unknown");
  });
});

describe("railLines: the mockup's TUI 1", () => {
  const ROWS: WorkflowStepRow[] = [
    step({ id: "plan", state: "ok", model: "opus", durationMs: 124_000 }),
    step({
      id: "exec",
      state: "ok",
      model: "deepseek",
      durationMs: 850_000,
      round: 1,
      maxRound: 1,
    }),
    step({ id: "review", kind: "agent", state: "error", model: "opus", reason: "REQUEST-CHANGES" }),
    step({ id: "fix", state: "running", model: "deepseek", live: "edit packages/x.ts" }),
    step({ id: "gate", kind: "run", state: "waiting", where: "docker:phi" }),
    step({ id: "merge", kind: "approve", state: "needs-approval" }),
  ];

  test("the header, then one row per step: glyph, id, WORD", () => {
    const lines = railLines(run({ steps: ROWS }), 120, 0);
    expect(lines[0]?.text).toBe("workflow task · 2/6 · 1.2M/3M tok");
    expect(lines.some((l) => /✓\s+plan\s+ok/.test(l.text))).toBe(true);
    expect(lines.some((l) => /✗\s+review\s+error/.test(l.text))).toBe(true);
    expect(lines.some((l) => /▸\s+fix\s+running/.test(l.text))).toBe(true);
    expect(lines.some((l) => /⧗\s+gate\s+waiting/.test(l.text))).toBe(true);
    expect(lines.some((l) => /\?\s+merge\s+needs approval/.test(l.text))).toBe(true);
  });

  test("a goto round reads `↻ 1/1`; the running step's live tail is ONE row under it", () => {
    const lines = railLines(run({ steps: ROWS }), 120, 0);
    expect(lines.some((l) => l.text.includes("↻ 1/1"))).toBe(true);
    const at = lines.findIndex((l) => /▸\s+fix/.test(l.text));
    expect(lines[at + 1]?.text).toBe("    ↳ edit packages/x.ts");
    // Exactly one live row, whatever else the run carries.
    expect(lines.filter((l) => l.text.includes("↳")).length).toBe(1);
  });

  test("width tiers: `[where]` leaves first, then the model — the WORD never leaves", () => {
    const wide = railLines(run({ steps: ROWS }), 120, 0);
    const mid = railLines(run({ steps: ROWS }), 80, 0);
    const narrow = railLines(run({ steps: ROWS }), 60, 0);
    const at = (lines: ReturnType<typeof railLines>): string =>
      lines.find((l) => /⧗\s+gate/.test(l.text))?.text ?? "";
    expect(at(wide)).toContain("[docker]");
    // Columns are the window's: `gate` has no model, yet its `[where]` lines up
    // under `plan`'s `[local]` (a per-row column would slide it left).
    const planRow = wide.find((l) => /✓\s+plan/.test(l.text))?.text ?? "";
    expect(at(wide).indexOf("[docker]")).toBe(planRow.indexOf("[local]"));
    expect(at(mid)).not.toContain("[docker]");
    expect(at(mid)).toContain("waiting");
    expect(at(narrow)).not.toContain("[docker]");
    // The word survives every tier; that is the colour-blind rule.
    for (const lines of [wide, mid, narrow]) {
      expect(at(lines)).toContain("waiting");
    }
    // …and the model leaves at the narrow tier only.
    const modelAt = (lines: ReturnType<typeof railLines>): string =>
      lines.find((l) => /✓\s+plan/.test(l.text))?.text ?? "";
    expect(modelAt(mid)).toContain("opus");
    expect(modelAt(narrow)).not.toContain("opus");
  });

  test("a 64-step graph windows to 7 rows around the active step, with `… +k`", () => {
    const many: WorkflowStepRow[] = Array.from({ length: 64 }, (_, i) =>
      step({ id: `s${i}`, state: i < 40 ? "ok" : i === 40 ? "running" : "pending" }),
    );
    const lines = railLines(run({ steps: many }), 120, 0);
    const stepRows = lines.filter((l) => /[✓▸○]/.test(l.text));
    // At most the window, and the running step is inside it.
    expect(stepRows.length).toBeLessThanOrEqual(WORKFLOW_RAIL_MAX_STEPS);
    expect(stepRows.some((l) => /▸\s+s40\s+running/.test(l.text))).toBe(true);
    // Both elisions are exact counts of the rows actually cut, not guesses:
    // the window is [37, 44) for active 40, so 37 before and 20 after.
    expect(lines.some((l) => l.text === "  … +37 earlier")).toBe(true);
    expect(lines.some((l) => l.text === "  … +20 more")).toBe(true);
    // The window is CENTRED on the active step (railWindow's own rule).
    const win = railWindow(64, 40);
    expect(win.end - win.start).toBe(WORKFLOW_RAIL_MAX_STEPS);
    expect(win.start).toBe(37);
    expect(win.end).toBe(44);
  });

  test("railWindow shifts (never shrinks) at both ends", () => {
    expect(railWindow(64, 0)).toEqual({ start: 0, end: WORKFLOW_RAIL_MAX_STEPS });
    expect(railWindow(64, 63)).toEqual({ start: 57, end: 64 });
    expect(railWindow(3, 1)).toEqual({ start: 0, end: 3 });
  });

  test("a long reason is flattened to ONE line, cut in cells (never wrapped)", () => {
    const lines = railLines(
      run({
        steps: [step({ id: "gate", kind: "run", state: "error", reason: "line one\nline two\tX" })],
      }),
      120,
      0,
    );
    const row = lines.find((l) => /✗\s+gate/.test(l.text));
    expect(row?.text).toContain("line one line two X");
    expect(lines.length).toBe(2);
  });

  test("workflowRailLines: nothing for an ENDED run, a taken slot, or no room", () => {
    const grant = { slotTaken: false, termRows: 40, runningRows: 0, inputBoxRows: 3 };
    const live = run({ steps: ROWS });
    expect(workflowRailLines(live, 120, 0, grant)?.length).toBe(railLines(live, 120, 0).length);
    // Its end is already a transcript note. Mutation: drop the `endedAt` check → red.
    expect(workflowRailLines(run({ steps: ROWS, endedAt: 9 }), 120, 0, grant)).toBeNull();
    expect(workflowRailLines(live, 120, 0, { ...grant, slotTaken: true })).toBeNull();
    // A terminal too short to keep the transcript's floor beside it: the rail yields.
    expect(workflowRailLines(live, 120, 0, { ...grant, termRows: 10 })).toBeNull();
    expect(workflowRailLines(undefined, 120, 0, grant)).toBeNull();
  });

  test("no budget: the header says the tokens alone; no steps: the header alone", () => {
    const lines = railLines(run({ steps: [], budget: undefined, tokens: 500 }), 120, 0);
    expect(lines.map((l) => l.text)).toEqual(["workflow task · 0/0 · 500 tok"]);
  });
});

describe("the /workflow panel", () => {
  const STEPS: WorkflowStepRow[] = [
    step({ id: "plan", state: "ok", model: "opus" }),
    step({ id: "review", state: "error", model: "opus", reason: "REQUEST-CHANGES" }),
    step({ id: "merge", kind: "approve", state: "needs-approval" }),
  ];

  test("two columns: the steps, and the selected step's detail", () => {
    const view = workflowPanelView([run({ steps: STEPS })], "wf-1", { cursor: 1 }, null, 120, 20);
    expect(view.title).toBe("Workflow task · 1/3");
    const all = view.rows.map((r) => r.text).join("\n");
    expect(all).toContain("›✗ error");
    expect(all).toContain("REQUEST-CHANGES");
    // `o` was never pressed: the panel ASKS for it rather than inventing a report.
    expect(all).toContain("[o] prompt and report");
    // No answer path of its own (D3): an approve step points at the prompt.
    expect(all).not.toContain(WORKFLOW_APPROVE_HINT);
    const merge = workflowPanelView([run({ steps: STEPS })], "wf-1", { cursor: 2 }, null, 120, 20);
    expect(merge.rows.map((r) => r.text).join("\n")).toContain(WORKFLOW_APPROVE_HINT);
  });

  test("the fetched detail paints prompt and report; `absent` says not available", () => {
    const withDetail = workflowPanelView(
      [run({ steps: STEPS })],
      "wf-1",
      { cursor: 1 },
      {
        runId: "wf-1",
        stepId: "review",
        phase: "done",
        detail: { attempt: 0, round: 0, live: false, prompt: "review the diff", report: "LGTM" },
      },
      120,
      20,
    );
    const all = withDetail.rows.map((r) => r.text).join("\n");
    expect(all).toContain("review the diff");
    expect(all).toContain("LGTM");

    const gone = workflowPanelView(
      [run({ steps: STEPS })],
      "wf-1",
      { cursor: 1 },
      { runId: "wf-1", stepId: "review", phase: "done" },
      120,
      20,
    );
    expect(gone.rows.map((r) => r.text).join("\n")).toContain(WORKFLOW_DETAIL_GONE);

    const old = workflowPanelView(
      [run({ steps: STEPS })],
      "wf-1",
      { cursor: 1 },
      { runId: "wf-1", stepId: "review", phase: "unsupported" },
      120,
      20,
    );
    expect(old.rows.map((r) => r.text).join("\n")).toContain(WORKFLOW_DETAIL_UNSUPPORTED);
  });

  test("`undefined` (no report: a pod, an older daemon) and an empty list are DIFFERENT", () => {
    const none = workflowPanelView(undefined, undefined, { cursor: 0 }, null, 80, 10);
    expect(none.rows[0]?.text).toContain("not supported");
    const empty = workflowPanelView([], undefined, { cursor: 0 }, null, 80, 10);
    expect(empty.rows[0]?.text).toContain("No workflow run in this session");
  });

  test("no runId given: the run in flight (or the newest) is the one shown", () => {
    const older = run({ runId: "wf-1", name: "old", endedAt: 5_000, state: "ok", steps: STEPS });
    const live = run({ runId: "wf-2", name: "now", steps: STEPS });
    expect(currentRun([older, live])?.runId).toBe("wf-2");
    const view = workflowPanelView([older, live], undefined, { cursor: 0 }, null, 100, 10);
    expect(view.title).toContain("now");
  });

  test("the cursor walks the run's steps and wraps", () => {
    expect(workflowMove({ cursor: 0 }, "up", 3)).toEqual({ cursor: 2 });
    expect(workflowMove({ cursor: 2 }, "down", 3)).toEqual({ cursor: 0 });
    expect(workflowMove({ cursor: 9 }, "down", 3)).toEqual({ cursor: 0 });
    expect(workflowMove({ cursor: 0 }, "down", 0)).toEqual({ cursor: 0 });
    expect(selectedStep(run({ steps: STEPS }), { cursor: 2 })?.id).toBe("merge");
    expect(selectedStep(undefined, { cursor: 0 })).toBeUndefined();
  });
});

describe("keys and the typed command", () => {
  test("↑↓ move, r reruns, o fetches, esc closes; every other key is none", () => {
    expect(workflowKey("", { upArrow: true })).toBe("up");
    expect(workflowKey("", { downArrow: true })).toBe("down");
    expect(workflowKey("r", {})).toBe("rerun");
    expect(workflowKey("o", {})).toBe("detail");
    expect(workflowKey("", { escape: true })).toBe("close");
    expect(workflowKey("q", {})).toBe("close");
    expect(workflowKey("x", {})).toBe("none");
  });

  test("parseWorkflowCommand: open / run with inputs / stop / resume / refused", () => {
    expect(parseWorkflowCommand("")).toEqual({ kind: "open" });
    expect(parseWorkflowCommand("   ")).toEqual({ kind: "open" });
    expect(parseWorkflowCommand("stop")).toEqual({ kind: "stop" });
    expect(parseWorkflowCommand("resume")).toEqual({ kind: "resume" });
    expect(parseWorkflowCommand("run task")).toEqual({ kind: "run", name: "task", inputs: [] });
    expect(parseWorkflowCommand("run task branch=main n=2")).toEqual({
      kind: "run",
      name: "task",
      inputs: [
        { name: "branch", value: "main" },
        { name: "n", value: "2" },
      ],
    });
    // A silent no-op would read as "my run started": every wrong shape is refused.
    expect(parseWorkflowCommand("nonsense")).toEqual({ kind: "refused", text: WORKFLOW_USAGE });
    expect(parseWorkflowCommand("run")).toEqual({ kind: "refused", text: WORKFLOW_USAGE });
    expect(parseWorkflowCommand("stop now")).toEqual({ kind: "refused", text: WORKFLOW_USAGE });
    expect(parseWorkflowCommand("run task bare").kind).toBe("refused");
    expect(parseWorkflowCommand("run task =x").kind).toBe("refused");
  });

  test("workflowTarget names what to act on, or says honestly that there is none", () => {
    const live = run({ runId: "wf-2" });
    const stopped = run({ runId: "wf-1", state: "stopped", endedAt: 9 });
    expect(workflowTarget([stopped, live], "stop")).toEqual({ runId: "wf-2" });
    expect(workflowTarget([stopped, live], "resume")).toEqual({ runId: "wf-1" });
    expect(workflowTarget([], "stop")).toEqual({
      refused: "No workflow run is going in this session.",
    });
    expect(workflowTarget(undefined, "resume")).toEqual({
      refused: "No stopped workflow run to resume.",
    });
    expect(workflowTarget([live], "resume")).toEqual({
      refused: "No stopped workflow run to resume.",
    });
  });

  test("a reply is a notice: the daemon's reason on refusal, else what was done", () => {
    expect(workflowReplyNotice("Started wf-1.", { ok: true })).toBe("_Started wf-1._");
    expect(workflowReplyNotice("x", { ok: false, reason: "one run is already going" })).toBe(
      "_one run is already going_",
    );
    expect(workflowReplyNotice("x", { ok: false })).toBe("_the daemon refused it_");
  });

  test("doneCount counts the steps that finished", () => {
    expect(
      doneCount(
        run({
          steps: [step(), step({ id: "b", state: "error" }), step({ id: "c", state: "ok" })],
        }),
      ),
    ).toBe(2);
  });
});

describe("the /workflow panel's own state rules (panels/workflow.ts)", () => {
  const STEPS: WorkflowStepRow[] = [
    step({ id: "plan" }),
    step({ id: "review", state: "error" }),
    step({ id: "merge", kind: "approve", state: "needs-approval" }),
  ];
  const open = (cursor: number): OpenPanel => ({
    ...workflowPanel(0, [run({ steps: STEPS })]),
    state: { cursor },
  });
  const DONE = { runId: "wf-1", stepId: "review", phase: "done" as const };

  test("a detail lands only on the step it was asked for", () => {
    const on = withWorkflowDetail(open(1), DONE);
    expect(on?.kind === "workflow" ? on.detail : null).toEqual(DONE);
    // The cursor moved to `merge` before the read landed: DROPPED, never painted
    // on the wrong step. Mutation: drop the stepId check → red.
    const moved = withWorkflowDetail(open(2), DONE);
    expect(moved?.kind === "workflow" ? moved.detail : "x").toBeNull();
    // No run in flight: the panel SHOWS the newest ended run, so its keys and
    // rules act on that same run (one source: `workflowPanelRun`).
    const ended: OpenPanel = {
      ...workflowPanel(0, [run({ steps: STEPS, endedAt: 9, state: "ok" })]),
      state: { cursor: 1 },
    };
    const onEnded = withWorkflowDetail(ended, DONE);
    expect(onEnded?.kind === "workflow" ? onEnded.detail : null).toEqual(DONE);
    // Another run's answer: dropped too.
    const other = withWorkflowDetail(open(1), { ...DONE, runId: "wf-9" });
    expect(other?.kind === "workflow" ? other.detail : "x").toBeNull();
  });

  test("a report keeps the detail while its step is still selected, else drops it", () => {
    const withDetail = withWorkflowDetail(open(1), DONE);
    const same = withWorkflowsData(withDetail, [run({ steps: STEPS })], 5);
    expect(same?.kind === "workflow" ? same.detail : null).toEqual(DONE);
    // The run shrank: the cursor is clamped onto `plan`, the review's detail goes.
    const shrunk = withWorkflowsData(withDetail, [run({ steps: [step({ id: "plan" })] })], 5);
    expect(shrunk?.kind === "workflow" ? shrunk.state.cursor : -1).toBe(0);
    expect(shrunk?.kind === "workflow" ? shrunk.detail : "x").toBeNull();
    // Another kind is never touched.
    expect(withWorkflowsData(null, [], 5)).toBeNull();
  });
});
