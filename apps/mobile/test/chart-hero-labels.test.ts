/**
 * `feat/mobile-chart-labels` D6 — the hero rule: exactly 2 series keep today's
 * YoY comparison, 3+ series and a highlighted series compare a series with ITS
 * OWN previous defined point (the mockup's "api 49 ms vs Nov 15").
 */
import { describe, expect, test } from "bun:test";
import { heroOf } from "../src/chart-hero.ts";
import { LATENCY, REVENUE, spec } from "./chart-fixtures.ts";

const pill = (h: ReturnType<typeof heroOf>): string | undefined => h.delta?.text;

describe("D6 · hero: which series it compares", () => {
  test("exactly 2 series keep the YoY pick (unchanged)", () => {
    const hero = heroOf(REVENUE, undefined, "it");
    expect(hero.context).toBe("ottobre 2026 · vs ottobre 2025");
    expect(pill(hero)).toBe("▲ 26,8%");
  });

  test("3 series at rest: series 0 vs its own previous point", () => {
    const hero = heroOf(LATENCY, undefined, "en");
    expect(`${hero.num} ${hero.unit}`).toBe("128 ms");
    expect(pill(hero)).toBe("▼ 5.2%");
    expect(hero.context).toBe("Nov 16 storage · vs Nov 15");
  });

  test("a highlighted series: itself vs its own previous point", () => {
    const hero = heroOf(LATENCY, undefined, "en", 2);
    expect(`${hero.num} ${hero.unit}`).toBe("49 ms");
    expect(pill(hero)).toBe("▼ 45.6%");
    expect(hero.context).toBe("Nov 16 api · vs Nov 15");
  });

  test("a highlighted series with a gap skips to its last DEFINED previous point", () => {
    // auth = [85, 90, null, null, 78, 82, 90]: 90 at Nov 16 vs 82 at Nov 15.
    const hero = heroOf(LATENCY, undefined, "en", 1);
    expect(`${hero.num} ${hero.unit}`).toBe("90 ms");
    expect(hero.context).toBe("Nov 16 auth · vs Nov 15");
    // Its first point has no predecessor: no pill, and the context says no more.
    const first = heroOf(LATENCY, 0, "en", 1);
    expect(first.context).toBe("Nov 10 auth");
    expect(first.delta).toBeUndefined();
  });

  test("a highlight + a scrub index re-reads that series at that x", () => {
    const hero = heroOf(LATENCY, 4, "en", 2);
    expect(`${hero.num} ${hero.unit}`).toBe("95 ms");
    expect(hero.context).toBe("Nov 14 api · vs Nov 13");
  });

  test("stacked keeps the total vs the previous total (a highlight does not change it)", () => {
    const tokens = spec({
      type: "bar",
      title: "Token",
      stacked: true,
      labels: ["lun", "mar"],
      y: { unit: "token" },
      datasets: [
        { label: "input", data: [250000, 200000] },
        { label: "output", data: [100000, 90000] },
        { label: "cache", data: [60000, 58000] },
      ],
    });
    expect(heroOf(tokens, undefined, "it").context).toBe("mar · vs lun");
    expect(heroOf(tokens, undefined, "it", 1).context).toBe("mar · vs lun");
  });

  test("single series: unchanged (its own first value, not the previous point)", () => {
    const area = spec({
      type: "area",
      title: "Utenti",
      labels: ["gen", "feb", "mar"],
      datasets: [{ label: "utenti", data: [200, 150, 260] }],
    });
    expect(heroOf(area, undefined, "it").context).toBe("mar · da gen");
  });
});
