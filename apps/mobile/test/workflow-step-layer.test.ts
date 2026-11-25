/**
 * The step detail's view-model (docs/feat/workflows-ui.md D5, slice 4):
 * `workflow-step-detail.ts` — the flight's two boxes (the tapped node, in SCREEN
 * points, and the hero it lands on), the hero's own text, and the body's blocks
 * for each state of the read.
 *
 * The property that matters here is the one the screen must not get wrong: the
 * pill takes off from where the finger was. A node's box lives in the graph's
 * LOGICAL space (318 pt), the detail's in screen points, so the mapping is a
 * function with a test, never an arithmetic detail buried in a component.
 */
import { describe, expect, test } from "bun:test";
import { runProjection } from "@tentacle/client";
import type { WorkflowRow, WorkflowStepRow } from "@tentacle/protocol";
import { HERO_METRICS } from "../src/workflow-morph.ts";
import { RUN_WIDTH } from "../src/workflow-run-layout.ts";
import {
  DETAIL_TEXT,
  STEP_NAV,
  bodyPending,
  canvasMap,
  detailLog,
  flight,
  heroBox,
  heroText,
  heroTop,
  navBox,
  navText,
  nodeBoxOnScreen,
  stepBlocks,
} from "../src/workflow-step-detail.ts";

const step = (id: string, over: Partial<WorkflowStepRow> = {}): WorkflowStepRow => ({
  id,
  kind: "agent",
  where: "local",
  state: "ok",
  attempt: 0,
  round: 0,
  next: null,
  onFail: null,
  retry: 0,
  ...over,
});

const STEPS = [
  step("build", { state: "ok", next: "review" }),
  step("review", { state: "error", next: "merge" }),
  step("merge", { state: "pending" }),
];

/** The run's own row, then the shared projection (S6b: the flight starts from a pill the layout placed). */
const RUN: WorkflowRow = {
  runId: "wf-1",
  name: "demo-note",
  version: 1,
  hash: "a".repeat(64),
  state: "running",
  tokens: 0,
  startedAt: 1_000,
  history: [],
  historyDropped: 0,
  steps: STEPS,
};
const PROJECTION = runProjection(RUN);

const detail = (over: Record<string, unknown> = {}) => ({
  attempt: 0,
  round: 0,
  live: false,
  prompt: "the resolved prompt",
  report: "9 files changed\nscript gate green",
  ...over,
});

describe("canvasMap: the graph's logical space → the screen", () => {
  test("a phone wider than the graph draws it at 1:1, CENTRED (never magnified)", () => {
    // The drawing is the mockup's 402 pt; a 430 pt phone (16 Pro Max) is wider.
    const map = canvasMap(430, RUN_WIDTH);
    expect(map.scale).toBe(1);
    expect(map.offsetX).toBe((430 - RUN_WIDTH) / 2);
    expect(map.offsetX).toBeGreaterThan(0);
    expect(map.offsetY).toBe(0);
  });

  test("a narrower phone scales the graph DOWN so every node stays reachable", () => {
    const map = canvasMap(300, RUN_WIDTH);
    expect(map.scale).toBeCloseTo(300 / RUN_WIDTH, 6);
    expect(map.scale).toBeLessThan(1);
    expect(map.offsetX).toBe(0);
  });

  test("a zero/garbage width never yields a NaN scale (a NaN box draws nothing)", () => {
    for (const width of [0, -40, Number.NaN]) {
      const map = canvasMap(Number.isFinite(width) ? width : 0, RUN_WIDTH);
      expect(Number.isFinite(map.scale)).toBe(true);
      expect(Number.isFinite(map.offsetX)).toBe(true);
      expect(map.scale).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("nodeBoxOnScreen: the pill takes off from where the finger was", () => {
  test("the mapped box is the node's own box, scaled and offset (NOT the hero's)", () => {
    const canvas = canvasMap(390, RUN_WIDTH);
    const box = nodeBoxOnScreen(PROJECTION, "review", canvas);
    expect(box).not.toBeNull();
    const hero = heroBox(heroTop(59), 16, 390);
    // It is a DIFFERENT box: a flight from the hero to the hero goes nowhere.
    expect(box).not.toEqual(hero);
    expect(box?.width ?? 0).toBeLessThan(hero.width);
    expect(box?.height ?? 0).toBeLessThan(hero.height);
  });

  test("an id the geometry does not hold is null, never a box flown in from nowhere", () => {
    expect(nodeBoxOnScreen(PROJECTION, "nope", canvasMap(390))).toBeNull();
  });

  test("the node sits at the geometry's own y, and the LAST node is further down", () => {
    const canvas = canvasMap(RUN_WIDTH, RUN_WIDTH);
    const first = nodeBoxOnScreen(PROJECTION, "build", canvas);
    const last = nodeBoxOnScreen(PROJECTION, "merge", canvas);
    expect(first?.y).toBeLessThan(last?.y ?? 0);
    expect(first?.height).toBe(44);
  });
});

describe("heroBox / heroText: where it lands, and what it says", () => {
  test("the hero is the detail's header, inset on both sides, at the HERO's own height", () => {
    const box = heroBox(heroTop(59), 16, 375);
    expect(box).toEqual({
      x: 16,
      y: heroTop(59),
      width: 375 - 32,
      height: HERO_METRICS.height,
    });
  });

  test("a narrow detail never gets a negative width", () => {
    expect(heroBox(heroTop(59), 16, 20).width).toBe(0);
  });

  test("the hero's text is the pill's: its id, then `state word · where`", () => {
    expect(heroText(step("review", { where: "docker:box" }), "error")).toEqual({
      id: "review",
      subtitle: "error · docker:box",
    });
  });

  test("an absent `where` reads `local`, and a pod's text is flattened to one line (§7)", () => {
    expect(heroText(step("a", { where: "" }), "done").subtitle).toBe("done · local");
    expect(heroText(step("a\nb"), "done").id).toBe("a b");
  });
});

describe("stepBlocks: the kv list is final BEFORE the read lands", () => {
  const kindWord = (k: string) => (k === "agent" ? "agent" : k);
  const stateWord = (s: string) => (s === "error" ? "error" : "done");

  test("the kv rows are identical with no read, a loading read and a loaded read", () => {
    // This is the property the whole skeleton rests on: the boxes ABOVE the log
    // block cannot move when the data arrives, because they never depended on it.
    const none = stepBlocks(step("review"), undefined, kindWord, stateWord, 2).kv;
    const loading = stepBlocks(step("review"), { kind: "loading" }, kindWord, stateWord, 2).kv;
    const loaded = stepBlocks(
      step("review"),
      { kind: "loaded", detail: detail() },
      kindWord,
      stateWord,
      2,
    ).kv;
    expect(loading).toEqual(none);
    expect(loaded).toEqual(none);
    expect(none.length).toBeGreaterThan(1);
  });

  test("the log block is empty until a read gives something", () => {
    expect(stepBlocks(step("review"), undefined, kindWord, stateWord, 0).log).toEqual([]);
  });

  test("a loaded detail reads `prompt:` / `report:`, in that order (asked, then answered)", () => {
    const log = stepBlocks(
      step("review"),
      { kind: "loaded", detail: detail() },
      kindWord,
      stateWord,
      0,
    ).log;
    expect(log).toEqual([
      "prompt:",
      "the resolved prompt",
      "report:",
      "9 files changed",
      "script gate green",
    ]);
    expect(log.indexOf("prompt:")).toBeLessThan(log.indexOf("report:"));
  });

  test("a LIVE read says `running now:` instead of `report:` (it has not finished)", () => {
    const log = detailLog({ kind: "loaded", detail: detail({ live: true, report: "▸ editing" }) });
    expect(log).toEqual(["prompt:", "the resolved prompt", "running now:", "▸ editing"]);
  });

  test("every non-loaded state SAYS so in words, in the same block (never a silent collapse)", () => {
    expect(detailLog({ kind: "loading" })).toEqual([DETAIL_TEXT.loading]);
    expect(detailLog({ kind: "missing" })).toEqual([DETAIL_TEXT.missing]);
    expect(detailLog({ kind: "unsupported" })).toEqual([DETAIL_TEXT.unsupported]);
    expect(detailLog({ kind: "failed", reason: "link down" })).toEqual(["link down"]);
    // A loaded detail with neither prompt nor report is `missing`, not a blank box.
    expect(detailLog({ kind: "loaded", detail: detail({ prompt: "", report: "" }) })).toEqual([
      DETAIL_TEXT.missing,
    ]);
  });

  test("a pod's multi-line report is kept as LINES (the block wraps), never one long line", () => {
    expect(detailLog({ kind: "loaded", detail: detail({ report: "a\nb" }) })).toContain("a");
    expect(detailLog({ kind: "loaded", detail: detail({ report: "a\nb" }) })).toContain("b");
  });

  test("`bodyPending` covers exactly the states that shimmer (never a failed one)", () => {
    expect(bodyPending(undefined)).toBe(true);
    expect(bodyPending({ kind: "loading" })).toBe(true);
    for (const done of [
      { kind: "loaded", detail: detail() },
      { kind: "missing" },
      { kind: "unsupported" },
      { kind: "failed", reason: "x" },
    ] as const) {
      expect(bodyPending(done)).toBe(false);
    }
  });
});

describe("flight: the two ends of the morph, or nothing", () => {
  test("it is the node's screen box and the hero's — the pair the animation interpolates", () => {
    const canvas = canvasMap(375, RUN_WIDTH);
    const pair = flight(PROJECTION, "review", canvas, heroTop(59), 16, 375);
    expect(pair?.to).toEqual(heroBox(heroTop(59), 16, 375));
    const node = nodeBoxOnScreen(PROJECTION, "review", canvas);
    if (node === null) {
      throw new Error("the fixture's step is in the graph");
    }
    expect(pair?.from).toEqual(node);
  });

  test("a step the graph does not hold has no flight (the layer does not open)", () => {
    expect(flight(PROJECTION, "gone", canvasMap(375), heroTop(59), 16, 375)).toBeNull();
  });
});

/**
 * docs/fix/workflows-ux.md S3 (defect 3, screenshots 162fac2b / d1b5faaa): the
 * detail's header overlapped the status bar and the back chevron, because the hero
 * started at the sheet's own 16 pt inset and the back row was in flow at y = 0.
 * The property: on any phone, the hero starts BELOW the status bar AND below the
 * nav bar, and the nav bar is the thing that owns the safe area.
 */
describe("S3 · the detail's nav bar under the safe area, the hero below it", () => {
  // The real insets: an iPhone 15/16's status bar, an iPad's 24, a notchless SE's 20.
  const INSETS = [59, 62, 47, 24, 20, 0] as const;

  test("the hero starts at or below insets.top + the nav bar's height — never at the inset", () => {
    for (const inset of INSETS) {
      const box = heroBox(heroTop(inset), 16, 390);
      expect({ inset, ok: box.y >= inset + STEP_NAV.height }).toEqual({ inset, ok: true });
    }
  });

  test("the flight LANDS there too (the morph cannot land under the clock)", () => {
    const pair = flight(PROJECTION, "review", canvasMap(390), heroTop(59), 16, 390);
    expect(pair?.to.y).toBe(heroTop(59));
    expect(pair?.to.y).toBeGreaterThanOrEqual(59 + STEP_NAV.height);
  });

  test("the nav bar clears the status bar and sits above the hero (no overlap either way)", () => {
    for (const inset of INSETS) {
      const nav = navBox(inset, 390);
      const hero = heroBox(heroTop(inset), 16, 390);
      // The bar's CONTENT row is the full header height UNDER the inset — not the
      // inset alone (a bar that only clears the clock has nowhere to draw `‹`).
      expect({ inset, row: nav.height - inset }).toEqual({ inset, row: STEP_NAV.height });
      // And the hero starts exactly one gap below the bar's bottom: the two boxes
      // meet, so neither the clock nor the back chevron can be over the pill.
      expect({ inset, apart: hero.y - (nav.y + nav.height) }).toEqual({
        inset,
        apart: STEP_NAV.gap,
      });
      expect({ inset, apart: nav.y + nav.height <= hero.y }).toEqual({ inset, apart: true });
    }
  });

  test("a garbage inset (a rotating iPad's NaN, a negative) is 0, never a NaN box", () => {
    for (const inset of [Number.NaN, -40, Number.POSITIVE_INFINITY]) {
      expect(Number.isFinite(heroTop(inset))).toBe(true);
      expect(Number.isFinite(navBox(inset, 390).height)).toBe(true);
      expect(heroTop(inset)).toBeGreaterThan(0);
    }
  });

  test("the nav bar's text: the run's name, and the step's place in FILE order", () => {
    expect(navText(STEPS, "review", "demo-note")).toEqual({
      back: "demo-note",
      position: "step 2 of 3",
    });
    expect(navText(STEPS, "merge", "demo-note").position).toBe("step 3 of 3");
  });

  test("a step this run does not hold gets no position (never a made-up one)", () => {
    expect(navText(STEPS, "gone", "demo-note").position).toBeNull();
  });

  test("an empty run name still reads as a button, and a multi-line name is flattened", () => {
    expect(navText(STEPS, "review", "").back).toBe("Run");
    expect(navText(STEPS, "review", "a\nb").back).toBe("a b");
  });
});
