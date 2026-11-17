/**
 * T1.10–T1.15 — the shared pure math (docs/feat/model-charts.md C1, D4):
 * dates across DST, LTTB downsampling, `formatNumber`, `niceTicks`, and the
 * palette's own validation re-run as a test, so the slots never drift
 * unvalidated.
 *
 * RED before the code: `packages/core/src/chart/` did not exist.
 */
import { describe, expect, test } from "bun:test";
import {
  CHART_PALETTE,
  PALETTE_SURFACE,
  autoFormat,
  bucketMeans,
  contrastRatio,
  datePositions,
  dateTicks,
  downsampleLttb,
  formatDate,
  formatNumber,
  formatPercent,
  mixedDateKinds,
  niceTicks,
  oklch,
  parseIsoDate,
  parseIsoDates,
  thinLabels,
  validatePalette,
} from "../src/index.ts";

describe("T1.10 dates", () => {
  test("the three kinds are told apart, with the granularity written", () => {
    expect(parseIsoDate("2026-03")?.kind).toBe("calendar");
    expect(parseIsoDate("2026-03")?.granularity).toBe("month");
    expect(parseIsoDate("2026-03-01")?.granularity).toBe("day");
    expect(parseIsoDate("2026-03-01T14:00:00Z")?.kind).toBe("instant");
    expect(parseIsoDate("2026-03-01T14:00+01:00")?.kind).toBe("instant");
    expect(parseIsoDate("2026-03-01T14:00")?.kind).toBe("floating");
    expect(parseIsoDate("03/01/2026")).toBeNull();
    expect(parseIsoDate("2026-02-31")).toBeNull();
    expect(parseIsoDate("2026-13")).toBeNull();
  });

  test("a calendar date is never shifted by a zone", () => {
    const parsed = parseIsoDate("2026-03-01");
    expect(parsed).not.toBeNull();
    expect(parsed?.ms).toBe(Date.UTC(2026, 2, 1));
  });

  test("mixed kinds are reported (validation refuses them)", () => {
    const dates = parseIsoDates(["2026-03-01", "2026-03-02", "2026-03-02T10:00:00Z"]);
    expect(dates).not.toBeNull();
    expect(mixedDateKinds(dates ?? [])).toEqual({ first: "calendar", other: "instant" });
    expect(mixedDateKinds(parseIsoDates(["2026-03-01", "2026-03-02"]) ?? [])).toBeNull();
  });

  test("instants across a DST change stay monotone and on elapsed time", () => {
    // Europe/Rome springs forward on 2026-03-29 at 02:00 CET → 03:00 CEST, so the
    // day beginning 2026-03-29T00:00+01:00 is 23 real hours long: the three clock
    // midnights are 24 h, then 23 h apart. Positions follow elapsed time, so the
    // middle one sits at 24/47 ≈ 0.511 and NOT at 0.5 (which is what counting
    // labels would give — the bug this pins).
    const labels = [
      "2026-03-28T00:00:00+01:00",
      "2026-03-29T00:00:00+01:00",
      "2026-03-30T00:00:00+02:00",
    ];
    const dates = parseIsoDates(labels) ?? [];
    const positions = datePositions(dates);
    expect(positions).toHaveLength(3);
    expect(positions[0]).toBe(0);
    expect(positions[2]).toBe(1);
    const middle = positions[1] ?? 0;
    expect(middle).toBeCloseTo(24 / 47, 6);
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i] as number).toBeGreaterThan(positions[i - 1] as number);
    }
  });

  test("date ticks land on round local hours across the same change", () => {
    const from = Date.parse("2026-03-28T00:00:00+01:00");
    const to = Date.parse("2026-03-30T00:00:00+02:00");
    const ticks = dateTicks(from, to, 8);
    expect(ticks.length).toBeGreaterThan(2);
    for (const tick of ticks) {
      expect(tick).toBeGreaterThanOrEqual(from);
      expect(tick).toBeLessThanOrEqual(to);
      expect(tick % 3_600_000).toBe(0);
    }
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i] as number).toBeGreaterThan(ticks[i - 1] as number);
    }
  });

  test("all labels equal: one position, no division by zero", () => {
    const dates = parseIsoDates(["2026-03-01", "2026-03-01"]) ?? [];
    expect(datePositions(dates)).toEqual([0.5, 0.5]);
  });
});

describe("T1.11 downsampling keeps the spikes", () => {
  test("a 1-in-1000 spike survives 1000 → 200", () => {
    const values = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 40) * 10);
    values[613] = 900;
    const { values: out, indices } = downsampleLttb(values, 200);
    expect(out.length).toBe(200);
    expect(out).toContain(900);
    expect(indices).toContain(613);
  });

  test("a dip survives too, and the ends are kept", () => {
    const values = Array.from({ length: 500 }, () => 5);
    values[0] = 1;
    values[250] = -40;
    values[499] = 2;
    const { values: out, indices } = downsampleLttb(values, 50);
    expect(out).toContain(-40);
    expect(indices[0]).toBe(0);
    expect(indices[indices.length - 1]).toBe(499);
    expect(out[0]).toBe(1);
  });

  test("under the target: unchanged", () => {
    expect(downsampleLttb([1, 2, 3], 200).values).toEqual([1, 2, 3]);
  });

  test("nulls stay breaks", () => {
    const values = Array.from({ length: 400 }, (_, i) => (i === 200 ? null : i));
    const { values: out } = downsampleLttb(values, 40);
    expect(out).toContain(null);
  });

  test("bucket means for a sparkline are exactly one per cell", () => {
    const values = [0, 10, 20, 30, 40, 50];
    expect(bucketMeans(values, 3)).toEqual([5, 25, 45]);
    expect(bucketMeans([1, null, null, 4], 2)).toEqual([1, 4]);
    expect(bucketMeans([1, null], 2)).toEqual([1, null]);
  });
});

describe("T1.13 formatNumber", () => {
  test("the table the plan names", () => {
    expect(formatNumber(12500, { unit: "€", locale: "it" })).toBe("12,5k €");
    expect(formatNumber(12500, { unit: "€", locale: "en" })).toBe("€12.5k");
    expect(formatNumber(999, { locale: "it" })).toBe("999");
    expect(formatNumber(0.0042, { decimals: 4, locale: "it" })).toBe("0,0042");
    expect(formatNumber(-1250000, { locale: "it" })).toBe("−1,3M");
    expect(formatNumber(-1250000, { locale: "en" })).toBe("−1.3M");
  });

  test("never rounds a real value to 0k (full below 1 000)", () => {
    expect(formatNumber(999, { format: "compact", locale: "it" })).toBe("999");
    expect(formatNumber(0.5, { format: "compact", locale: "it" })).toBe("0,5");
  });

  test("the unit placement: % glued, others spaced, currency per locale", () => {
    expect(formatNumber(12500, { unit: "%", locale: "it" })).toBe("12,5k%");
    expect(formatNumber(42, { unit: "ms", locale: "it" })).toBe("42 ms");
    expect(formatNumber(2400000, { unit: "€", locale: "it" })).toBe("2,4M €");
    expect(formatNumber(2400000, { unit: "$", locale: "en" })).toBe("$2.4M");
  });

  test("explicit full format keeps the digits", () => {
    expect(formatNumber(12500, { format: "full", locale: "it" })).toBe("12.500");
    expect(formatNumber(12500, { format: "full", locale: "en" })).toBe("12,500");
  });

  test("auto: compact above 10 000, full below", () => {
    expect(autoFormat(9999)).toBe("full");
    expect(autoFormat(10000)).toBe("compact");
    expect(formatNumber(9999, { locale: "it" })).toBe("9.999");
  });

  test("a negative zero is a zero", () => {
    expect(formatNumber(-0, { locale: "it" })).toBe("0");
  });

  test("percent and dates", () => {
    expect(formatPercent(0.375, "it")).toBe("37,5%");
    expect(formatPercent(0.25, "it")).toBe("25%");
    expect(formatDate(Date.UTC(2026, 2, 1), "month", { locale: "en", zone: "UTC" })).toContain(
      "2026",
    );
    expect(formatDate(Date.UTC(2026, 2, 1), "day", { locale: "it", zone: "UTC" })).toContain("mar");
  });
});

describe("T1.14 niceTicks", () => {
  test("a plain range snaps to round numbers", () => {
    const ticks = niceTicks(0, 100, 6);
    expect(ticks.lo).toBe(0);
    expect(ticks.hi).toBe(100);
    expect(ticks.ticks).toEqual([0, 20, 40, 60, 80, 100]);
  });

  test("bars include 0 even with all-positive data", () => {
    expect(niceTicks(40, 90, 4, true).lo).toBe(0);
  });

  test("a range crossing 0 keeps the sign on both sides", () => {
    const ticks = niceTicks(-30, 70, 5, true);
    expect(ticks.lo).toBeLessThanOrEqual(-30);
    expect(ticks.hi).toBeGreaterThanOrEqual(70);
    expect(ticks.ticks).toContain(0);
    for (let i = 1; i < ticks.ticks.length; i++) {
      expect(ticks.ticks[i] as number).toBeGreaterThan(ticks.ticks[i - 1] as number);
    }
  });

  test("min === max gets a range around it", () => {
    const at5 = niceTicks(5, 5, 5);
    expect(at5.lo).toBeLessThan(5);
    expect(at5.hi).toBeGreaterThan(5);
    expect(niceTicks(0, 0, 5).ticks.length).toBeGreaterThan(1);
  });

  test("fractional steps stay exact (no 0.30000000000000004)", () => {
    const ticks = niceTicks(0, 1, 6);
    expect(ticks.ticks).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  test("the tick count respects maxTicks", () => {
    for (const maxTicks of [3, 4, 5, 8]) {
      const ticks = niceTicks(0, 987, maxTicks);
      expect(ticks.ticks.length).toBeLessThanOrEqual(maxTicks + 1);
    }
  });

  test("thinLabels never overlaps and keeps the ends", () => {
    const positions = Array.from({ length: 12 }, (_, i) => i / 11);
    const widths = positions.map(() => 3);
    const kept = thinLabels(positions, widths, 30);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(11);
    let lastEnd = Number.NEGATIVE_INFINITY;
    for (const i of kept) {
      const centre = (positions[i] as number) * 30;
      const start = centre - (widths[i] as number) / 2;
      const end = centre + (widths[i] as number) / 2;
      expect(start).toBeGreaterThanOrEqual(lastEnd);
      lastEnd = end;
    }
  });

  test("thinLabels on 1 and 2 labels", () => {
    expect(thinLabels([0], [3], 20)).toEqual([0]);
    expect(thinLabels([0, 1], [3, 3], 20)).toEqual([0, 1]);
  });
});

describe("T1.15 the palette validates", () => {
  test("light: 8 adjacent pairs pass, first-3 all-pairs pass", () => {
    const adjacent = validatePalette(CHART_PALETTE.light, { mode: "light" });
    expect(adjacent.ok).toBe(true);
    expect(adjacent.checks.find((c) => c.check === "CVD separation")?.state).toBe("pass");
    const first3 = validatePalette(CHART_PALETTE.light.slice(0, 3), {
      mode: "light",
      pairs: "all",
    });
    expect(first3.ok).toBe(true);
  });

  test("dark: 8 adjacent pass, first-3 all-pairs still clears the CVD floor", () => {
    const adjacent = validatePalette(CHART_PALETTE.dark, { mode: "dark" });
    expect(adjacent.ok).toBe(true);
    expect(adjacent.checks.find((c) => c.check === "CVD separation")?.state).toBe("pass");
    const first3 = validatePalette(CHART_PALETTE.dark.slice(0, 3), { mode: "dark", pairs: "all" });
    expect(first3.ok).toBe(true);
    const cvd = first3.checks.find((c) => c.check === "CVD separation");
    expect(cvd?.state).toBe("warn");
    expect(cvd?.detail).toContain("6.6");
  });

  test("light's known relief: yellow and magenta are below 3:1 on white", () => {
    const light = validatePalette(CHART_PALETTE.light, { mode: "light" });
    expect(light.checks.find((c) => c.check === "Contrast vs surface")?.state).toBe("relief");
    expect(contrastRatio("#eda100", PALETTE_SURFACE.light)).toBeLessThan(3);
    const dark = validatePalette(CHART_PALETTE.dark, { mode: "dark" });
    expect(dark.checks.find((c) => c.check === "Contrast vs surface")?.state).toBe("pass");
  });
  test("the app's own accent fails the chroma floor — why slot 1 is not the accent", () => {
    expect(oklch("#0E7490").c).toBeLessThan(0.1);
    expect(validatePalette(["#0E7490"], { mode: "light" }).ok).toBe(false);
  });

  test("the validator catches a bad palette (non-vacuity)", () => {
    const gray = validatePalette(["#888888", "#8a8a8a", "#8c8c8c"], { mode: "light" });
    expect(gray.ok).toBe(false);
    expect(gray.checks.find((c) => c.check === "Chroma floor")?.state).toBe("fail");
    const faint = validatePalette(["#cfd8ff", "#d2dbff", "#d5deff"], { mode: "light" });
    expect(faint.ok).toBe(false);
  });

  test("both schemes carry all 8 slots, and no slot repeats", () => {
    expect(CHART_PALETTE.light).toHaveLength(8);
    expect(CHART_PALETTE.dark).toHaveLength(8);
    expect(new Set(CHART_PALETTE.light).size).toBe(8);
    expect(new Set(CHART_PALETTE.dark).size).toBe(8);
    for (const hex of [...CHART_PALETTE.light, ...CHART_PALETTE.dark]) {
      expect(hex).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
