/**
 * S8 of docs/feat/agent-workflows.md — the morph and the skeleton, as the plan's
 * "Tests" section states them:
 *
 *   "morph frames are monotone and every inner part interpolates (no property
 *    jumps between two consecutive frames); skeleton bar boxes equal the loaded
 *    layout boxes; reduce-motion picks crossfade"
 *
 * The mockup is the spec (`docs/feat/agent-workflows/transition.html` variant A,
 * the owner's choice). What it cannot state, because it animates one hand-made
 * pill, is the property the whole transition rests on: EVERY inner part grows with
 * the pill. A ghost that only animated its outer box would land as a different
 * object — the badge, the glyph and both texts would snap to their detail sizes on
 * the last frame. So the tests below walk the whole 0→1 range and check each part.
 */
import { describe, expect, test } from "bun:test";
import { typography } from "../src/theme.ts";
import {
  CROSSFADE_MS,
  HERO_METRICS,
  MORPH_CLOSE_MS,
  MORPH_FLIGHT_MS,
  type MorphFrame,
  NODE_METRICS,
  bezier,
  graphLayerOpacity,
  graphLayerScale,
  morphFrame,
  morphLook,
  rowOpacityAt,
  rowStartMs,
  rowsSettledMs,
} from "../src/workflow-morph.ts";
import {
  DETAIL,
  detailBlocks,
  detailHeight,
  detailLayout,
  logLines,
  raggedFraction,
  skeletonBars,
  skeletonMotion,
} from "../src/workflow-skeleton.ts";

/** The node's box in the graph, and the hero's in the detail — the two ends of the flight. */
const FROM = { x: 64, y: 150, width: 190, height: 44 };
const TO = { x: 16, y: 0, width: 343, height: 68 };

/** A walk over the whole transition, fine enough that a snap cannot hide between samples. */
const STEPS = 200;

function frames(n = STEPS): MorphFrame[] {
  return Array.from({ length: n + 1 }, (_v, i) => morphFrame(i / n, FROM, TO));
}

/** Every numeric property of a frame, so a test can speak about all of them at once. */
function parts(frame: MorphFrame): Record<string, number> {
  return {
    x: frame.box.x,
    y: frame.box.y,
    width: frame.box.width,
    height: frame.box.height,
    radius: frame.radius,
    padLeft: frame.padLeft,
    padRight: frame.padRight,
    gap: frame.gap,
    badge: frame.badge,
    glyphSize: frame.glyphSize,
    titleSize: frame.titleSize,
    subtitleSize: frame.subtitleSize,
  };
}

describe("the morph interpolates EVERY inner part (the load-bearing property)", () => {
  test("no part jumps between two consecutive frames", () => {
    // "No property jumps" made exact: the biggest step any part takes between two
    // neighbouring frames is a small fraction of that part's own travel. A part
    // that is not interpolated at all steps its whole travel at some frame (badge
    // 26 → 38 in one go = 1.0 of its travel), which this catches.
    const all = frames();
    for (const name of Object.keys(parts(all[0] ?? morphFrame(0, FROM, TO)))) {
      const values = all.map((f) => parts(f)[name] ?? 0);
      const travel = Math.abs((values[values.length - 1] ?? 0) - (values[0] ?? 0));
      if (travel === 0) {
        continue;
      }
      let biggest = 0;
      for (let i = 1; i < values.length; i += 1) {
        biggest = Math.max(biggest, Math.abs((values[i] ?? 0) - (values[i - 1] ?? 0)));
      }
      expect({ part: name, biggest: biggest / travel <= 0.2 }).toEqual({
        part: name,
        biggest: true,
      });
    }
  });

  test("every part is monotone (it never backs up on the way)", () => {
    const dirs: Record<string, number> = {};
    const all = frames();
    for (const name of Object.keys(parts(all[0] ?? morphFrame(0, FROM, TO)))) {
      const values = all.map((f) => parts(f)[name] ?? 0);
      const travel = (values[values.length - 1] ?? 0) - (values[0] ?? 0);
      if (travel === 0) {
        continue;
      }
      dirs[name] = Math.sign(travel);
      for (let i = 1; i < values.length; i += 1) {
        const delta = (values[i] ?? 0) - (values[i - 1] ?? 0);
        // Never against the travel (a tolerance for float noise at the 1e-12 level).
        expect({ part: name, ok: delta * dirs[name] >= -1e-9 }).toEqual({ part: name, ok: true });
      }
    }
  });

  test("each part arrives only at the END: nothing is already final while the box still flies", () => {
    // This is what a snap IS: a part that reads its detail size at t < 1.
    const early = morphFrame(0.5, FROM, TO);
    const p = parts(early);
    expect(p.badge).toBeGreaterThan(NODE_METRICS.badge);
    expect(p.badge).toBeLessThan(HERO_METRICS.badge);
    expect(p.glyphSize).toBeLessThan(HERO_METRICS.glyphSize);
    expect(p.titleSize).toBeLessThan(HERO_METRICS.titleSize);
    expect(p.subtitleSize).toBeLessThan(HERO_METRICS.subtitleSize);
    expect(early.box.height).toBeLessThan(TO.height);
  });

  test("at 0 it is exactly the node; at 1 exactly the hero", () => {
    const start = morphFrame(0, FROM, TO);
    const end = morphFrame(1, FROM, TO);
    expect(start.box).toEqual(FROM);
    expect(end.box).toEqual(TO);
    expect(start.badge).toBe(NODE_METRICS.badge);
    expect(start.titleSize).toBe(NODE_METRICS.titleSize);
    expect(end.badge).toBe(HERO_METRICS.badge);
    expect(end.titleSize).toBe(HERO_METRICS.titleSize);
    expect(end.radius).toBe(HERO_METRICS.radius);
    // The pill starts fully rounded and lands on the hero's own radius.
    expect(start.radius).toBe(NODE_METRICS.radius);
  });

  test("progress outside 0..1 is clamped, never extrapolated off the screen", () => {
    expect(morphFrame(-3, FROM, TO).box).toEqual(FROM);
    expect(morphFrame(9, FROM, TO).box).toEqual(TO);
    expect(morphFrame(Number.NaN, FROM, TO).box.height).toBe(NODE_METRICS.height);
  });

  test("the rows are not part of the pill's frame: they outlast the flight", () => {
    // A stagger that had to finish inside a 380 ms flight would be 3 ms apart for a
    // detail of ten rows — one flash, not a stagger. The mockup fades them from
    // 120 ms for 260 ms, so the block settles AFTER the pill has landed.
    expect(rowsSettledMs(4)).toBeGreaterThan(MORPH_FLIGHT_MS);
    expect(rowStartMs(0)).toBeGreaterThan(0);
    expect(rowOpacityAt(0, 0)).toBe(0);
    expect(rowOpacityAt(rowStartMs(0), 0)).toBe(0);
    expect(rowOpacityAt(rowsSettledMs(4), 3)).toBe(1);
  });
});

describe("the easing (the mockup's cubic-bezier(.2,.8,.2,1))", () => {
  test("it is a timing curve: 0 at 0, 1 at 1, and never outside the unit interval", () => {
    expect(bezier(0)).toBeCloseTo(0, 6);
    expect(bezier(1)).toBeCloseTo(1, 6);
    for (let i = 0; i <= 100; i += 1) {
      const v = bezier(i / 100);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  test("it is monotone, so the flight never reverses", () => {
    let previous = bezier(0);
    for (let i = 1; i <= 100; i += 1) {
      const v = bezier(i / 100);
      expect(v).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = v;
    }
  });

  test("it is ease-OUT: it spends the first half of time getting most of the way", () => {
    // A linear curve would give exactly 0.5 here; "out fast, in soft" gives more.
    expect(bezier(0.5)).toBeGreaterThan(0.6);
  });
});

describe("Reduce Motion picks a crossfade, never a slower flight", () => {
  test("on: the crossfade, with no flight to interpolate", () => {
    const look = morphLook(true);
    expect(look.kind).toBe("crossfade");
    expect(look).toEqual({ kind: "crossfade", ms: CROSSFADE_MS });
    // There is no `flightMs` on this branch: a reduce-motion transition cannot
    // accidentally read a flight duration that does not exist.
    expect("flightMs" in look).toBe(false);
  });

  test("off: the morph, with the mockup's outward and return timings", () => {
    expect(morphLook(false)).toEqual({
      kind: "morph",
      flightMs: MORPH_FLIGHT_MS,
      closeMs: MORPH_CLOSE_MS,
    });
  });

  test("the skeleton is stilled by Reduce Motion, never removed — the layout must still hold", () => {
    const view = detailBlocks(
      { id: "fix", kind: "agent", state: "running", where: "local", attempt: 0, round: 0 },
      (k) => k,
      (s) => s,
      2,
    );
    const moving = skeletonBars(view, 375, false);
    const still = skeletonBars(view, 375, true);
    // Same boxes, same count: only the motion differs.
    expect(still.map((b) => [b.x, b.y, b.width, b.height])).toEqual(
      moving.map((b) => [b.x, b.y, b.width, b.height]),
    );
    expect(still.every((b) => b.motion === "still")).toBe(true);
    expect(moving.some((b) => b.motion === "pulse")).toBe(true);
    expect(skeletonMotion(true)).toBe("still");
  });
});

describe("the skeleton holds the LOADED layout (`no reflow`)", () => {
  const view = detailBlocks(
    {
      id: "review",
      kind: "agent",
      state: "error",
      model: "opus",
      where: "local",
      attempt: 1,
      round: 1,
      maxRound: 3,
      reason: "REQUEST-CHANGES\n1. task.ts:380 missing abort\n2. vacuous test",
      durationMs: 180_000,
    },
    (k) => k,
    (s) => s,
    2,
  );
  const width = 375;

  test("every bar sits inside a loaded box, and there is one bar per piece of text", () => {
    const boxes = detailLayout(view, width);
    const bars = skeletonBars(view, width, false);
    expect(bars).toHaveLength(boxes.length);
    for (const [i, box] of boxes.entries()) {
      const bar = bars[i];
      expect(bar).toBeDefined();
      if (bar === undefined) {
        continue;
      }
      // Horizontally exact: a bar never leaves its column, so nothing shifts when
      // the real text arrives.
      expect(bar.x).toBe(box.x);
      expect(bar.width).toBe(box.width);
      // Vertically inside the box (the trim only ever shrinks it), never outside.
      expect(bar.y).toBeGreaterThanOrEqual(box.y);
      expect(bar.y + bar.height).toBeLessThanOrEqual(box.y + box.height + 1e-9);
      expect(bar.key).toBe(`bar-${box.key}`);
    }
  });

  test("the kv list is the SAME list on both sides — the skeleton cannot list other rows", () => {
    // The one place the rows are decided: `detailBlocks`. A skeleton that guessed
    // its own count would show five bars for a six-row detail and reflow on load.
    expect(view.kv.map(([k]) => k)).toEqual([
      "State",
      "Kind",
      "Model",
      "Where",
      "Attempts",
      "Round",
      "Duration",
      // docs/fix/workflow-no-verdict (b): the step's WHY, from the row itself.
      "Reason",
    ]);
    // English, like the rest of the app (owner, docs/feat/workflows-ui.md Q3).
    expect(view.kv.find(([k]) => k === "Round")?.[1]).toMatch(/^\d+ of \d+$/);
    expect(
      skeletonBars(view, width, false).filter((b) => b.key.startsWith("bar-kv-")),
    ).toHaveLength(8);
  });

  test("an absent field is ABSENT, not an empty row", () => {
    const bare = detailBlocks(
      { id: "a", kind: "run", state: "pending", where: "local", attempt: 0, round: 0 },
      (k) => k,
      (s) => s,
      0,
    );
    // No model, no round, no duration, no attempt, no reason, no actions — but
    // WHERE it runs is always known and always worth a row.
    expect(bare.kv.map(([k]) => k)).toEqual(["State", "Kind", "Where"]);
    expect(bare.log).toHaveLength(0);
    expect(bare.actions).toBe(0);
    // And no action row is drawn for it.
    expect(detailLayout(bare, width).some((b) => b.section === "actions")).toBe(false);
  });

  test("the reserved height is the loaded height: a late load cannot reflow the screen", () => {
    // The screen reserves this before any data lands, so the scroll position and the
    // header above it are already final.
    const h = detailHeight(view, width);
    const boxes = detailLayout(view, width);
    const last = boxes[boxes.length - 1];
    if (last === undefined) {
      throw new Error("the fixture has rows");
    }
    expect(h).toBe(last.y + last.height + DETAIL.inset);
    // A taller detail really is taller (the height follows the content).
    expect(detailHeight(bare(), width)).toBeLessThan(h);
  });

  test("the log area is drawn in the mono token's own line height", () => {
    // `detailBlocks` gives the kv rows; the log block is the READ's (`detailLog`),
    // so the fixture supplies one — three lines, whatever their words.
    const withLog = {
      ...view,
      log: logLines("prompt:\nreview the diff\nreport:\ntask.ts:380 misses an abort"),
    };
    const logBoxes = detailLayout(withLog, width).filter((b) => b.section === "log");
    expect(logBoxes).toHaveLength(4);
    for (const box of logBoxes) {
      expect(box.height).toBe(typography.mono.lineHeight);
    }
  });

  test("the hero is one box, at the top, full content width", () => {
    const hero = detailLayout(view, width)[0];
    expect(hero?.section).toBe("hero");
    expect(hero?.y).toBe(DETAIL.inset);
    expect(hero?.height).toBe(DETAIL.heroHeight);
    expect(hero?.width).toBe(width - DETAIL.inset * 2);
  });

  test("bars never overlap, so a shimmer cannot show two bars as one", () => {
    const bars = skeletonBars(view, width, false);
    for (let i = 1; i < bars.length; i += 1) {
      const prev = bars[i - 1];
      const cur = bars[i];
      if (prev === undefined || cur === undefined) {
        continue;
      }
      expect(cur.y).toBeGreaterThanOrEqual(prev.y + prev.height - 1e-9);
    }
  });

  test("the last log line's fraction is deterministic (a re-render never re-shimmers)", () => {
    const a = skeletonBars(view, width, false).map((b) => b.widthFraction);
    const b = skeletonBars(view, width, false).map((x) => x.widthFraction);
    expect(a).toEqual(b);
    // ...and it is the ragged tail, not a random wobble.
    expect(a.every((f) => f > 0 && f <= 1)).toBe(true);
    expect(raggedFraction(1)).toBeLessThan(raggedFraction(9));
  });

  test("untrusted log text is flattened to plain lines (a pod's bytes, §7)", () => {
    // `oneLine` turns every control byte into ONE space, newlines included — so the
    // split has to happen first, on the original text, which is what `logLines` does.
    expect(logLines("a\u0007b\nc\rd")).toEqual(["a b", "c d"]);
    // A blank line keeps the rhythm rather than collapsing the block.
    expect(logLines("a\n\nb")).toEqual(["a", " ", "b"]);
    expect(logLines(undefined)).toHaveLength(0);
  });
});

/** A minimal detail with no optional field, for the height comparison. */
function bare() {
  return detailBlocks(
    { id: "a", kind: "agent", state: "ok", where: "local", attempt: 0, round: 0 },
    (k) => k,
    (s) => s,
    0,
  );
}

describe("the graph's own layer during the flight", () => {
  test("it steps back and fades out, so the pill is never drawn twice", () => {
    // The mockup fades the graph over the first ~260 ms of a 380 ms flight, then holds.
    expect(graphLayerOpacity(0)).toBe(1);
    expect(graphLayerOpacity(1)).toBe(0);
    expect(graphLayerOpacity(0.75)).toBe(0);
    expect(graphLayerScale(0)).toBe(1);
    expect(graphLayerScale(1)).toBe(0.97);
    // The 3 % "step back" never grows past 1 (a layer that swelled would read as a zoom).
    for (let i = 0; i <= 100; i += 1) {
      expect(graphLayerScale(i / 100)).toBeLessThanOrEqual(1);
      expect(graphLayerOpacity(i / 100)).toBeGreaterThanOrEqual(0);
    }
  });

  test("the rows stagger from the front, and the buttons arrive last", () => {
    // Later rows start later than earlier ones, and the first starts with a delay.
    expect(rowStartMs(0)).toBeGreaterThan(0);
    expect(rowStartMs(1)).toBeGreaterThan(rowStartMs(0));
    expect(rowStartMs(3)).toBeGreaterThan(rowStartMs(2));
    // Nothing at the beginning, everything once the block has settled — for ANY count.
    for (const count of [1, 2, 3, 8, 12, 20]) {
      expect(rowOpacityAt(0, 0)).toBe(0);
      expect(rowOpacityAt(rowsSettledMs(count), count - 1)).toBe(1);
    }
    // A later row is dimmer than an earlier one at the same instant.
    expect(rowOpacityAt(rowStartMs(2) + 30, 3)).toBeLessThan(rowOpacityAt(rowStartMs(2) + 30, 0));
  });
});
