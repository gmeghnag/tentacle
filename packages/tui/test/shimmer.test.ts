import { describe, expect, test } from "bun:test";
import { cellWidth } from "../src/cells.ts";
import {
  SHIMMER_PAUSE_TICKS,
  SHIMMER_TICK_MS,
  SHIMMER_WINDOW,
  shimmerPeriod,
  shimmerSpans,
} from "../src/shimmer.ts";

/**
 * The sweep is pure state (docs/feat/tui-thinking-shimmer.md, AGENTS §7): label +
 * tick in, coloured spans out. The property every test here protects is that the
 * spans CONCATENATE TO THE LABEL — a shimmer that changes the text would move the
 * TUI's rows, which is far worse than no shimmer. Colour is the only thing a tick
 * may change.
 */
const text = (spans: readonly { text: string }[]): string => spans.map((s) => s.text).join("");
const tones = (spans: readonly { text: string; tone: string }[]): string[] =>
  spans.map((s) => s.tone);

describe("shimmerSpans never changes the text", () => {
  test("every tick of a full period concatenates back to the label", () => {
    for (const label of ["Thinking…", "Working…", "", "x", "思考…", "ab 👩‍👩‍👧 cd"]) {
      const period = shimmerPeriod(label);
      for (let tick = 0; tick < period; tick++) {
        expect(text(shimmerSpans(label, tick))).toBe(label);
      }
    }
  });

  // Mutation: drop the last grapheme of a span (e.g. slice by cells) → this line.
  test("no span is empty, so no adjacent-text merge hides a boundary bug", () => {
    for (let tick = 0; tick < shimmerPeriod("Working…"); tick++) {
      for (const span of shimmerSpans("Working…", tick)) {
        expect(span.text.length).toBeGreaterThan(0);
      }
    }
  });

  test("adjacent spans never carry the same tone (they would be one span)", () => {
    for (let tick = 0; tick < shimmerPeriod("Working…"); tick++) {
      const list = tones(shimmerSpans("Working…", tick));
      for (let i = 1; i < list.length; i++) {
        expect(list[i]).not.toBe(list[i - 1] ?? "");
      }
    }
  });
});

describe("the window sweeps left to right, once per sweep", () => {
  test("the peak visits every cell of the label exactly once, in order", () => {
    const label = "Working…";
    const total = cellWidth(label);
    const peaked: number[] = [];
    // Phases 1..total put the peak on cell 0..total-1.
    for (let tick = 1; tick <= total; tick++) {
      const spans = shimmerSpans(label, tick);
      const peak = spans.find((s) => s.tone === "peak");
      expect(peak).toBeDefined();
      // Which cell does the peak start at, in the concatenated text?
      const at = spans.findIndex((s) => s.tone === "peak");
      peaked.push(
        cellWidth(
          spans
            .slice(0, at)
            .map((s) => s.text)
            .join(""),
        ),
      );
    }
    expect(peaked).toEqual([...Array(total).keys()]);
  });

  test("phase 0 reveals the window at the left edge: mid, peak is not on the label yet", () => {
    const spans = shimmerSpans("Working…", 0);
    // peakCell = -1: the window's right half (cell 0) is mid.
    expect(tones(spans)).toEqual(["mid", "base"]);
    expect(spans[0]?.text).toBe("W");
  });

  test("the window is 3 cells: the peak is flanked by mid on both sides", () => {
    const spans = shimmerSpans("Working…", 4); // peak on cell 3 ("k")
    expect(tones(spans)).toEqual(["base", "mid", "peak", "mid", "base"]);
    expect(spans.map((s) => s.text).join("")).toBe("Working…");
    expect(shimmerSpans("Working…", 4)[2]?.text).toBe("k");
  });

  test("SHIMMER_WINDOW is the 3-cell window the tones above assume", () => {
    expect(SHIMMER_WINDOW).toBe(3);
  });
});

describe("the pause", () => {
  test("after the sweep the whole label is base for SHIMMER_PAUSE_TICKS ticks", () => {
    const label = "Working…";
    const total = cellWidth(label);
    const sweep = total + SHIMMER_WINDOW - 1;
    for (let tick = sweep; tick < sweep + SHIMMER_PAUSE_TICKS; tick++) {
      expect(tones(shimmerSpans(label, tick))).toEqual(["base"]);
    }
  });

  test("the period is the sweep plus the pause, and it wraps exactly", () => {
    const label = "Working…";
    const total = cellWidth(label);
    expect(shimmerPeriod(label)).toBe(total + SHIMMER_WINDOW - 1 + SHIMMER_PAUSE_TICKS);
    for (let tick = 0; tick < 5; tick++) {
      expect(shimmerSpans(label, tick + shimmerPeriod(label))).toEqual(shimmerSpans(label, tick));
    }
  });

  // Mutation: `tick % period` with pauseTicks: 0 → a non-positive modulus (NaN).
  test("pauseTicks: 0 is legal and loops the sweep with no all-base frame", () => {
    const period = shimmerPeriod("Working…", { pauseTicks: 0 });
    expect(period).toBe(cellWidth("Working…") + SHIMMER_WINDOW - 1);
    const seen = new Set<string>();
    for (let tick = 0; tick < period; tick++) {
      seen.add(tones(shimmerSpans("Working…", tick, { pauseTicks: 0 })).join(","));
    }
    expect(seen.has("base")).toBe(false);
  });
});

describe("the period fits the plan's budget at the spinner's 80 ms tick", () => {
  test("one full sweep of Thinking… / Working… takes about 2 s (owner 2026-11-17: 1.8–2.2 s)", () => {
    expect(SHIMMER_TICK_MS).toBe(80);
    for (const label of ["Thinking…", "Working…"]) {
      const ms = shimmerPeriod(label) * SHIMMER_TICK_MS;
      expect(ms).toBeGreaterThanOrEqual(1800);
      expect(ms).toBeLessThanOrEqual(2200);
    }
  });

  // Mutation: pause 20 → 2.48 s; pause 5 → 1.28 s. Both outside the owner's band.
  test("the pause is what puts it in the band (pinned, not accidental)", () => {
    expect(SHIMMER_PAUSE_TICKS).toBe(14);
  });
});

describe("cells, not code points", () => {
  test("a trailing … is one cell and is swept like any other", () => {
    const label = "Working…";
    const spans = shimmerSpans(label, cellWidth(label));
    expect(spans.at(-1)?.tone).toBe("peak");
    expect(spans.at(-1)?.text).toBe("…");
    expect(text(spans)).toBe(label);
  });

  // Mutation: measure with `text.length` → the wide chars are double-counted and
  // the peak lands past the last cell (no peak span at the end of the sweep).
  test("a 2-cell grapheme is never torn across two spans", () => {
    const label = "思考…";
    const total = cellWidth(label);
    expect(total).toBe(5); // 2 + 2 + 1
    for (let tick = 0; tick < shimmerPeriod(label); tick++) {
      const spans = shimmerSpans(label, tick);
      expect(text(spans)).toBe(label);
      // Each grapheme sits in exactly ONE run: a split would show as a torn glyph.
      for (const g of ["思", "考", "…"]) {
        expect(spans.filter((s) => s.text.includes(g)).length).toBe(1);
      }
    }
    const last = shimmerSpans(label, total);
    expect(last.at(-1)).toEqual({ text: "…", tone: "peak" });
    expect(text(last)).toBe(label);
  });

  test("a wide grapheme the window only clips is mid, never half-painted", () => {
    // 思 = cells 0-1, 考 = cells 2-3, … = cell 4. Peak on cell 2 (考's first cell)
    // leaves 思 inside the window but off its centre: mid, and still one span.
    const spans = shimmerSpans("思考…", 3);
    expect(text(spans)).toBe("思考…");
    expect(spans[0]).toEqual({ text: "思", tone: "mid" });
    expect(spans[1]).toEqual({ text: "考", tone: "peak" });
  });

  test("an emoji ZWJ cluster stays one span", () => {
    const label = "ab 👩‍👩‍👧 cd";
    const total = cellWidth(label);
    for (let tick = 0; tick <= total; tick++) {
      const spans = shimmerSpans(label, tick);
      expect(text(spans)).toBe(label);
      const family = spans.filter((s) => s.text.includes("👩"));
      expect(family.length).toBe(1);
    }
  });
});

describe("degradation and degenerate input", () => {
  test("color: false paints no sweep: one base span, the label untouched", () => {
    for (let tick = 0; tick < 12; tick++) {
      expect(shimmerSpans("Working…", tick, { color: false })).toEqual([
        { text: "Working…", tone: "base" },
      ]);
    }
  });

  test("an empty label is one empty base span, and its period is the pause alone", () => {
    expect(shimmerSpans("", 3)).toEqual([{ text: "", tone: "base" }]);
    expect(shimmerPeriod("")).toBe(SHIMMER_WINDOW - 1 + SHIMMER_PAUSE_TICKS);
  });

  test("a one-cell label still gets the full left/right window travel", () => {
    expect(shimmerSpans("x", 0)).toEqual([{ text: "x", tone: "mid" }]);
    expect(shimmerSpans("x", 1)).toEqual([{ text: "x", tone: "peak" }]);
    expect(shimmerSpans("x", 2)).toEqual([{ text: "x", tone: "mid" }]);
    expect(shimmerSpans("x", 3)).toEqual([{ text: "x", tone: "base" }]);
  });

  // Mutation: `tick % period` without the `+ period) % period` guard → a negative
  // tick yields a negative phase (a different frame than its modulo, no sweep).
  test("a negative or huge tick is normalised to its modulo, never a raw one", () => {
    const label = "Working…";
    const period = shimmerPeriod(label);
    for (const k of [-1, -7, -period - 3]) {
      const normalised = ((k % period) + period) % period;
      expect(shimmerSpans(label, k)).toEqual(shimmerSpans(label, normalised));
    }
    expect(shimmerSpans(label, 10 ** 9)).toEqual(shimmerSpans(label, 10 ** 9 % period));
  });
});
