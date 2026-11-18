/**
 * `feat/mobile-chart-labels` D3 — A's tap-to-highlight: one pure function that
 * returns the layout with every other series muted and the hero moved onto the
 * tapped one, so `ChartView` keeps drawing whatever it is handed.
 */
import { describe, expect, test } from "bun:test";
import { highlightLayout, toggleHighlight } from "../src/chart-interact.ts";
import { type ChartLayout, chartLayout } from "../src/chart-layout.ts";
import { LATENCY, TRAFFIC, spec } from "./chart-fixtures.ts";

const W = 361;

let RAW = LATENCY;
function layoutOf(raw: typeof LATENCY): ChartLayout {
  RAW = raw;
  const l = chartLayout(raw, { width: W, locale: "en", labels: "legend" });
  if (!l) throw new Error("expected a layout");
  return l;
}

describe("toggleHighlight — the tap", () => {
  test("a tap selects, a second tap on the same series returns to rest", () => {
    expect(toggleHighlight(null, 2)).toBe(2);
    expect(toggleHighlight(2, 2)).toBeNull();
    expect(toggleHighlight(2, 1)).toBe(1);
  });
});

describe("highlightLayout", () => {
  test("every other line and fill is muted; the tapped series keeps its paint", () => {
    const l = layoutOf(LATENCY);
    const hi = highlightLayout(l, RAW, 2, "en");
    const lines = hi.paths.filter((p) => p.role === "line");
    for (const p of lines) {
      if (p.series === 2) expect(p.paint).toEqual({ series: 2 });
      else expect(p.paint).toEqual({ token: "mutedLine" });
    }
    expect(lines.filter((p) => p.series !== 2).every((p) => p.opacity < 1)).toBe(true);
  });

  test("fills are muted and dimmed harder than the strokes", () => {
    const l = layoutOf(TRAFFIC);
    const hi = highlightLayout(l, RAW, 1, "en");
    const fills = hi.paths.filter((p) => p.role === "fill");
    expect(fills.length).toBeGreaterThan(1);
    for (const f of fills) {
      expect(f.paint).toEqual(f.series === 1 ? { series: 1 } : { token: "mutedLine" });
    }
  });

  test("the hero moves onto the tapped series (itself vs its own previous point)", () => {
    const l = layoutOf(LATENCY);
    const hi = highlightLayout(l, RAW, 2, "en");
    expect(`${hi.hero.num} ${hi.hero.unit}`).toBe("49 ms");
    expect(hi.hero.context).toBe("Nov 16 api · vs Nov 15");
    // At rest the layout still compares series 0 (D6's 3+ series rule).
    expect(l.hero.context).toBe("Nov 16 storage · vs Nov 15");
  });

  test("the scrub still wins: scrubAt's hero is the tapped series' at that x", () => {
    const l = layoutOf(LATENCY);
    const hi = highlightLayout(l, RAW, 2, "en");
    expect(hi.scrubAt(4)?.hero.context).toBe("Nov 14 api · vs Nov 13");
  });

  test("a scrub hero of another series is not left behind by the highlight", () => {
    const l = layoutOf(LATENCY);
    const hi = highlightLayout(l, RAW, 0, "en");
    expect(hi.scrubAt(4)?.hero.num).toBe("140");
  });

  test("nothing else is touched: the same texts, guides, plot and summary", () => {
    const l = layoutOf(LATENCY);
    const hi = highlightLayout(l, RAW, 1, "en");
    expect(hi.texts).toEqual(l.texts);
    expect(hi.guides).toEqual(l.guides);
    expect(hi.plot).toEqual(l.plot);
    expect(hi.summary).toBe(l.summary);
    expect(hi.legend).toEqual(l.legend);
  });

  test("a series that is not in this chart is ignored (the layout comes back as it was)", () => {
    const l = layoutOf(LATENCY);
    const hi = highlightLayout(l, RAW, 7, "en");
    expect(hi.paths).toEqual(l.paths);
  });
});
