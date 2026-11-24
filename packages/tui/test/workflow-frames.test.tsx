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
import type { WorkflowCatalogueResult, WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import { App, type SessionController } from "../src/App.tsx";
import { catalogueLine, railLines, workflowsLine } from "../src/workflow-view.ts";
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

/** The project's workflow files, as slice 5a's catalogue answers them. */
const CATALOGUE: WorkflowCatalogueResult = {
  dir: "/tmp/work/.tentacle/workflows",
  workflows: [
    {
      name: "task",
      path: ".tentacle/workflows/task.yaml",
      ok: true,
      version: 3,
      approved: true,
      hash: "a".repeat(64),
      steps: [{ id: "plan", kind: "agent", where: "local" }],
    },
    {
      name: "nightly",
      path: ".tentacle/workflows/nightly.yaml",
      ok: true,
      version: 1,
      approved: false,
      hash: "b".repeat(64),
    },
  ],
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
  /** Every `workflowCatalogue` READ this TUI made (the coalescing test counts them). */
  readonly catalogueReads: number;
  /** The next answer `workflowCatalogue` gives (a test swaps it mid-run). */
  readonly setCatalogue: (answer: WorkflowCatalogueResult | { unsupported: true }) => void;
  /** Answer the OLDEST held read (only with `holdReads`). */
  readonly settleOne: () => void;
}

/**
 * A session whose run list this test drives: `onWorkflows` delivers the first
 * report at once (as the client's does), then whatever `report` sends.
 */
function fake(
  rows: readonly WorkflowRow[],
  opts: {
    readonly noFeed?: boolean;
    /** No catalogue seam at all (a pod, an older daemon). */
    readonly noCatalogue?: boolean;
    /** `send` streams a real, settling turn (the re-read trigger's own test). */
    readonly settles?: boolean;
    /**
     * Every read STAYS in flight until the test releases it (the coalescing
     * property's own test): `settleOne` answers the oldest held read.
     */
    readonly holdReads?: boolean;
    readonly catalogue?: WorkflowCatalogueResult | { unsupported: true };
  } = {},
): WorkflowApi {
  const actions: unknown[] = [];
  const reads: string[] = [];
  const counts = { reads: 0 };
  /** One resolver per held read: the test releases them in order. */
  const pending: (() => void)[] = [];
  let listener: ((rows: readonly WorkflowRow[]) => void) | null = null;
  let answer: WorkflowCatalogueResult | { unsupported: true } = opts.catalogue ?? CATALOGUE;
  const session = {
    ...inertSession(),
    async *send() {
      // A turn that ends at once unless a test asks for a real one: the App goes
      // running and settles, which is what a catalogue re-read is triggered by.
      if (opts.settles !== true) {
        yield* [] as never[];
        return;
      }
      yield { type: "text" as const, delta: "ok" };
      yield { type: "turn_end" as const, reason: "end_turn" as const };
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
    ...(opts.noCatalogue === true
      ? { workflowCatalogue: undefined }
      : {
          workflowCatalogue: () => {
            counts.reads += 1;
            return opts.holdReads === true
              ? new Promise<WorkflowCatalogueResult | { unsupported: true }>((resolve) => {
                  pending.push(() => resolve(answer));
                })
              : Promise.resolve(answer);
          },
        }),
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
    get catalogueReads() {
      return counts.reads;
    },
    setCatalogue: (next) => {
      answer = next;
    },
    settleOne: () => {
      pending.shift()?.();
    },
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
    // The catalogue's hash rides the start (slice 2b / D8): a file edited since
    // the user saw it is refused `changed` (5a) instead of run as something else.
    expect(api.actions).toEqual([
      {
        action: "start",
        name: "task",
        hash: "a".repeat(64),
        inputs: [{ name: "branch", value: "main" }],
      },
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

describe("slice 2b (D8): the project's workflows at rest", () => {
  const line = catalogueLine(CATALOGUE, 120) ?? "MISSING";

  test("the App paints the catalogue line exactly as `workflowCatalogue` projects it", async () => {
    // Non-vacuity first: the projection really names both files, with words.
    expect(line).toBe("◇ workflows  nightly v1 ? needs approval · task v3 ✓ approved   /workflow");
    const t = await mount(fake([], { catalogue: CATALOGUE }));
    const frame = t.frame();
    expect(frame).toContain(line);
    // The at-rest line and the rail never both paint.
    expect(frame).not.toContain("workflow task · 2/6");
    t.term.unmount();
  });

  test("the input sits on the SAME row with and without the line (the exact property)", async () => {
    const withLine = await mount(fake([], { catalogue: CATALOGUE }));
    const frameA = withLine.frame();
    const inputA = rowOf(frameA, "Type a task or /command");
    expect(frameA).toContain(line);
    expect(inputA).toBeGreaterThan(0);
    withLine.term.unmount();

    // No catalogue answer at all (no seam): nothing is painted…
    const bare = await mount(fake([], { noCatalogue: true }));
    const frameB = bare.frame();
    const inputB =
      rowOf(frameB, "Type a task /command") >= 0
        ? rowOf(frameB, "Type a task /command")
        : rowOf(frameB, "Type a task");
    expect(frameB).not.toContain("◇ workflows");
    // …and the input has NOT moved: the line's row came out of the transcript's
    // viewport, not out of the input's slot (the property, not "height constant").
    expect(inputB).toBe(inputA);
    bare.term.unmount();
  });

  test("a run in flight replaces it; its end brings it back", async () => {
    const api = fake([RUN], { catalogue: CATALOGUE });
    const t = await mount(api);
    const running = t.frame();
    expect(running).toContain("workflow task · 2/6 · 1.2M/3M tok");
    expect(running).not.toContain("◇ workflows");
    const inputRunning = rowOf(running, "Type a task");

    api.report([ENDED]);
    await delay(80);
    const ended = t.frame();
    expect(ended).toContain(line);
    expect(ended).not.toContain("workflow task · 2/6");
    // The rail leaving and the line arriving is ONE swap inside the same budget:
    // the input still sits where it did (within the rail's now-free rows).
    expect(rowOf(ended, "Type a task")).toBeLessThanOrEqual(inputRunning);
    t.term.unmount();
  });

  test("a turn ENDING re-reads the catalogue exactly once (not on its start)", async () => {
    const api = fake([], { catalogue: CATALOGUE, settles: true });
    const t = await mount(api);
    // The open's own read, and nothing else yet.
    const afterOpen = api.catalogueReads;
    expect(afterOpen).toBe(1);

    await t.line("hello", 300);
    // A turn that yields no event still settles: exactly ONE more read, and the
    // turn's START asked for none (the coalescing rule, counted).
    expect(api.catalogueReads).toBe(afterOpen + 1);
    t.term.unmount();
  });

  test("a burst of triggers is ONE read plus ONE scheduled, never a queue (coalescing)", async () => {
    const api = fake([], { catalogue: CATALOGUE, settles: true, holdReads: true });
    const t = await mount(api);
    // The open's read is in flight and the fake holds it there.
    expect(api.catalogueReads).toBe(1);
    // Four more triggers land while it is in flight — through `/workflow`, which
    // is one of D8's own triggers. Each asks, none starts a second read.
    for (let i = 0; i < 4; i += 1) {
      await t.line("/workflow", 40);
      expect(t.frame()).toContain("Workflows");
    }
    expect(api.catalogueReads).toBe(1);
    // The held read lands: the scheduled one starts — exactly ONE more.
    api.settleOne();
    await delay(60);
    expect(api.catalogueReads).toBe(2);
    // It lands with nothing pending: the count stays put (no third read).
    api.settleOne();
    await delay(60);
    expect(api.catalogueReads).toBe(2);
    t.term.unmount();
  });

  test("a workflow needing input PRE-FILLS the command instead of starting half-specified", async () => {
    const needs: WorkflowCatalogueResult = {
      dir: "/tmp/work/.tentacle/workflows",
      workflows: [
        {
          name: "ship",
          path: ".tentacle/workflows/ship.yaml",
          ok: true,
          approved: true,
          hash: "c".repeat(64),
          inputs: [
            { name: "branch", required: true },
            { name: "note", required: false },
          ],
        },
      ],
    };
    const api = fake([], { catalogue: needs });
    const t = await mount(api);
    await t.line("/workflow run ship");
    // Nothing was sent: the required value was never given.
    expect(api.actions).toEqual([]);
    // The input line holds the command with the blank waiting for the value…
    expect(t.frame()).toContain("/workflow run ship branch=");
    // …and the person is told why nothing ran.
    expect(t.frame()).toContain("needs input");

    t.term.unmount();

    // Filled in from the start, the SAME command does start — pinned to the
    // catalogue's hash, so a file edited meanwhile is refused rather than run.
    const filled = fake([], { catalogue: needs });
    const u = await mount(filled);
    await u.line("/workflow run ship branch=main");
    expect(filled.actions).toEqual([
      {
        action: "start",
        name: "ship",
        hash: "c".repeat(64),
        inputs: [{ name: "branch", value: "main" }],
      },
    ]);
    u.term.unmount();
  });

  test("an invalid workflow file is refused with its first error, and nothing is sent", async () => {
    const broken: WorkflowCatalogueResult = {
      dir: "/tmp/work/.tentacle/workflows",
      workflows: [
        {
          name: "broken",
          path: ".tentacle/workflows/broken.yaml",
          ok: false,
          errors: ["steps[0].run: missing"],
        },
      ],
    };
    const api = fake([], { catalogue: broken });
    const t = await mount(api);
    await t.line("/workflow run broken");
    expect(api.actions).toEqual([]);
    expect(t.frame()).toContain("steps[0].run: missing");
    t.term.unmount();
  });

  test("an older daemon's `unsupported` paints no line at all", async () => {
    const t = await mount(fake([], { catalogue: { unsupported: true } }));
    const frame = t.frame();
    expect(frame).not.toContain("◇ workflows");
    expect(frame).not.toContain("no workflows here");
    // `/workflow` still opens, and its section says to update tentacle.
    await t.line("/workflow");
    expect(t.frame()).toContain("update tentacle");
    t.term.unmount();
  });

  test("/workflow paints the Workflows section above the run, with the folder and its errors", async () => {
    const broken: WorkflowCatalogueResult = {
      dir: "/tmp/work/.tentacle/workflows",
      gitIgnored: true,
      workflows: [
        ...CATALOGUE.workflows,
        {
          name: "broken",
          path: ".tentacle/workflows/broken.yaml",
          ok: false,
          errors: ["steps[0].run: missing"],
        },
      ],
    };
    const t = await mount(fake([RUN], { catalogue: broken }));
    await t.line("/workflow");
    const frame = t.frame();
    // The section is ABOVE the run's columns.
    expect(rowOf(frame, "nightly")).toBeLessThan(rowOf(frame, "plan"));
    expect(frame).toContain("steps[0].run: missing");
    expect(frame).toContain(".tentacle/workflows/broken.yaml");
    expect(frame).toContain("not versioned");
    expect(frame).toContain("/tmp/work/.tentacle/workflows");
    t.term.unmount();
  });

  test("the line says nothing on a terminal too short to keep the transcript's floor", async () => {
    const term = renderAt(
      <App
        createSession={() => fake([], { catalogue: CATALOGUE }).session}
        permissions={new PermissionBroker()}
        model="m"
        cwd="/tmp/work"
      />,
      { columns: 120, rows: 9 },
    );
    await delay(60);
    const frame = term.frame();
    // The layout's decision (the pure grant) is what the frame follows: on this
    // terminal the line yields to the transcript, and nothing else moves.
    expect(
      workflowsLine(CATALOGUE, 120, undefined, {
        slotTaken: false,
        runActive: false,
        termRows: 9,
        runningRows: 0,
        inputBoxRows: 3,
      }),
    ).toBeNull();
    expect(frame).not.toContain("◇ workflows");
    term.unmount();
  });
});
