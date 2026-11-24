/**
 * Slice 4 of docs/feat/workflows-ui.md (D5): `morphTable` — the ONE table React
 * Native's `Animated` interpolates, derived from `morphFrame` so the pure module
 * stays the only source of the motion. And the layout property the detail stands
 * on: **no box above the log block moves when the detail lands**.
 *
 * Red first: the table was a stub returning empty arrays, so every value
 * assertion below failed on the ASSERTION (a wrong/empty table), never on an
 * import.
 */
import { describe, expect, test } from "bun:test";
import { typography } from "../src/theme.ts";
import { type Box, morphFrame, morphTable } from "../src/workflow-morph.ts";
import {
  DETAIL,
  type DetailBlocks,
  detailBlocks,
  detailHeight,
  detailLayout,
  logLines,
  skeletonBars,
} from "../src/workflow-skeleton.ts";

const FROM: Box = { x: 64, y: 150, width: 190, height: 44 };
const TO: Box = { x: 16, y: 0, width: 343, height: 68 };

describe("morphTable: the table `Animated` interpolates", () => {
  test("the inputRange is 0..1, strictly increasing, with the sample count asked for", () => {
    const table = morphTable(FROM, TO, 11);
    expect(table.inputRange).toHaveLength(11);
    expect(table.inputRange[0]).toBe(0);
    expect(table.inputRange[10]).toBe(1);
    for (let i = 1; i < table.inputRange.length; i += 1) {
      expect(table.inputRange[i] ?? 0).toBeGreaterThan(table.inputRange[i - 1] ?? 0);
    }
  });

  test("EVERY output equals `morphFrame` at that sample (the frame is the only source)", () => {
    const table = morphTable(FROM, TO, 11);
    // Non-vacuity: an EMPTY table would make the loop below assert nothing at all.
    expect(table.inputRange).toHaveLength(11);
    expect(table.box.height).toHaveLength(11);
    for (const [i, t] of table.inputRange.entries()) {
      const frame = morphFrame(t, FROM, TO);
      expect({
        t,
        box: [table.box.x[i], table.box.y[i], table.box.width[i], table.box.height[i]],
        rest: [
          table.radius[i],
          table.padLeft[i],
          table.padRight[i],
          table.gap[i],
          table.badge[i],
          table.glyphSize[i],
          table.titleSize[i],
          table.subtitleSize[i],
        ],
      }).toEqual({
        t,
        box: [frame.box.x, frame.box.y, frame.box.width, frame.box.height],
        rest: [
          frame.radius,
          frame.padLeft,
          frame.padRight,
          frame.gap,
          frame.badge,
          frame.glyphSize,
          frame.titleSize,
          frame.subtitleSize,
        ],
      });
    }
  });

  test("the endpoints are EXACT: a flight that starts or lands off its frame is a jump", () => {
    const table = morphTable(FROM, TO, 7);
    expect({
      x: table.box.x[0],
      y: table.box.y[0],
      width: table.box.width[0],
      height: table.box.height[0],
    }).toEqual(FROM);
    expect({
      x: table.box.x[6],
      y: table.box.y[6],
      width: table.box.width[6],
      height: table.box.height[6],
    }).toEqual(TO);
  });

  test("a sample count below two cannot build a range: it is clamped, never an empty table", () => {
    // `Animated.interpolate` throws on a range of one point; a NaN progress is
    // what an interrupted driver hands back, so the table must always be usable.
    for (const asked of [0, 1, -4]) {
      const table = morphTable(FROM, TO, asked);
      expect(table.inputRange.length).toBeGreaterThanOrEqual(2);
      expect(table.inputRange[table.inputRange.length - 1]).toBe(1);
    }
  });
});

/**
 * The detail's blocks for a step whose data has NOT landed (prompt/report still
 * absent), and the same step once it has. The kv list above the log block comes
 * from the row, so it is final before the fetch — that is the whole point.
 */
const ROW = {
  id: "review",
  kind: "agent",
  state: "error",
  model: "opus",
  where: "local",
  attempt: 1,
  round: 1,
  maxRound: 3,
  durationMs: 180_000,
} as const;

const LOADED: DetailBlocks = {
  ...detailBlocks(
    ROW,
    (k) => k,
    (s) => s,
    2,
  ),
  log: logLines("REQUEST-CHANGES\n1. task.ts:380 missing abort"),
};

const PENDING: DetailBlocks = {
  ...detailBlocks(
    ROW,
    (k) => k,
    (s) => s,
    2,
  ),
  log: [],
};

describe("the detail's layout: nothing above the log block may move when data lands", () => {
  const width = 375;

  test("every box above the log block is IDENTICAL before and after the detail lands", () => {
    // The exact property (not "height constant"): the kv rows and the hero are at
    // the same y, with the same height, whether the log block is empty or full.
    const before = detailLayout(PENDING, width);
    const after = detailLayout(LOADED, width);
    const above = (boxes: typeof before) => boxes.filter((b) => b.section !== "log");
    // The action row comes AFTER the log block, so it may move (it only grows down).
    const strip = (boxes: typeof before) =>
      above(boxes)
        .filter((b) => b.section !== "actions")
        .map((b) => [b.key, b.section, b.x, b.y, b.width, b.height]);
    expect(strip(before)).toEqual(strip(after));
  });

  test("the log block only grows DOWNWARD: below it, everything shifts, nothing above", () => {
    const before = detailLayout(PENDING, width);
    const after = detailLayout(LOADED, width);
    const heroBefore = before.find((b) => b.section === "hero");
    const heroAfter = after.find((b) => b.section === "hero");
    if (heroBefore === undefined || heroAfter === undefined) {
      throw new Error("the layout always carries a hero");
    }
    expect(heroAfter).toEqual(heroBefore);
    const log = after.filter((b) => b.section === "log");
    expect(log).toHaveLength(2);
    // The first log line starts below the last kv row, never over it.
    const lastKv = after.filter((b) => b.section === "kv").at(-1);
    expect(log[0]?.y ?? 0).toBeGreaterThanOrEqual(
      (lastKv?.y ?? 0) + (lastKv?.height ?? 0) + DETAIL.blockGap,
    );
  });

  test("the reserved height only GROWS by the log block's own lines", () => {
    // The screen reserves the pending height before the fetch. The loaded detail is
    // taller by exactly: the log's block gap plus one mono line per log line — so a
    // caller that reserved it never finds the block taller for any other reason.
    const pending = detailHeight(PENDING, width);
    const loaded = detailHeight(LOADED, width);
    expect(loaded).toBeGreaterThan(pending);
    expect(loaded - pending).toBe(DETAIL.blockGap + LOADED.log.length * typography.mono.lineHeight);
    // And the bars sit in the pending layout's own boxes (their trim only shrinks y).
    const bars = skeletonBars(PENDING, width, false);
    const boxes = detailLayout(PENDING, width);
    expect(bars).toHaveLength(boxes.length);
    for (const [i, box] of boxes.entries()) {
      const bar = bars[i];
      expect([bar?.x, bar?.width]).toEqual([box.x, box.width]);
      expect(bar?.y ?? -1).toBeGreaterThanOrEqual(box.y);
    }
  });
});
