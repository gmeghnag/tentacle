/**
 * T5.10 / T5.15 — `heroOf`: the hero number, its delta pill and context line
 * (docs/feat/model-charts.md *iPhone visual language (rev 2)* item 3).
 */
import { describe, expect, test } from "bun:test";
import { type Hero, heroOf } from "../src/chart-hero.ts";
import { REVENUE, spec } from "./chart-fixtures.ts";

const TOKENS = spec({
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

/** y = 10 + 0.09·x exactly on 8 points up to x = 800 (step 100 → +9,0 s per 100 rows). */
const ROWS = spec({
  type: "scatter",
  title: "Tempo per righe",
  x: { unit: "righe" },
  y: { unit: "s" },
  datasets: [
    {
      label: "job",
      data: [100, 200, 300, 400, 500, 600, 700, 800].map((x) => ({ x, y: 10 + 0.09 * x })),
    },
  ],
});

const pill = (hero: Hero): string | undefined => hero.delta?.text;

describe("T5.10 heroOf", () => {
  test("two-series line at rest: the last value vs the other series at the same x", () => {
    const hero = heroOf(REVENUE, undefined, "it");
    expect(`${hero.num} ${hero.unit}`).toBe("20.800 €");
    expect(hero.unitBefore).toBe(false);
    expect(pill(hero)).toBe("▲ 26,8%");
    expect(hero.context).toBe("ottobre 2026 · vs ottobre 2025");
  });

  test("en: separators and the currency side follow the locale", () => {
    const hero = heroOf(REVENUE, undefined, "en");
    expect(hero.num).toBe("20,800");
    expect(hero.unitBefore).toBe(true);
    expect(pill(hero)).toBe("▲ 26.8%");
  });

  test("a scrub index re-reads the hero at that x (agosto: 18.100 vs 14.300)", () => {
    const hero = heroOf(REVENUE, 7, "it");
    expect(hero.num).toBe("18.100");
    expect(pill(hero)).toBe("▲ 26,6%");
    expect(hero.context).toBe("agosto 2026 · vs agosto 2025");
  });

  test("single-series area: delta against its own first value", () => {
    const area = spec({
      type: "area",
      title: "Utenti",
      labels: ["gen", "feb", "mar"],
      datasets: [{ label: "utenti", data: [200, 150, 260] }],
    });
    const hero = heroOf(area, undefined, "it");
    expect(hero.num).toBe("260");
    expect(pill(hero)).toBe("▲ 30,0%");
    expect(hero.context).toBe("mar · da gen");
    expect(pill(heroOf(area, 1, "it"))).toBe("▼ 25,0%");
  });

  test("ref = 0 gives no pill; one point gives no pill", () => {
    const zero = spec({
      type: "line",
      title: "x",
      labels: ["a", "b"],
      datasets: [{ label: "s", data: [0, 5] }],
    });
    expect(heroOf(zero, undefined, "it").delta).toBeUndefined();
    const one = spec({
      type: "line",
      title: "x",
      labels: ["a"],
      datasets: [{ label: "s", data: [5] }],
    });
    expect(heroOf(one, undefined, "it").delta).toBeUndefined();
  });

  test("stacked: the latest column total vs the previous column", () => {
    const hero = heroOf(TOKENS, undefined, "it");
    expect(`${hero.num} ${hero.unit}`).toBe("348.000 token");
    expect(pill(hero)).toBe("▼ 15,1%");
    expect(hero.context).toBe("mar · vs lun");
  });

  test("bars: the max with its rank line, never a delta", () => {
    const bars = spec({
      type: "bar",
      title: "Build",
      labels: ["core", "tui", "cli"],
      y: { unit: "s", decimals: 1 },
      datasets: [{ label: "s", data: [12.5, 48.2, 30] }],
    });
    const hero = heroOf(bars, undefined, "it");
    expect(`${hero.num} ${hero.unit}`).toBe("48,2 s");
    expect(hero.delta).toBeUndefined();
    expect(hero.context).toBe("tui · il più alto di 3");
    expect(heroOf(bars, undefined, "en").context).toBe("tui · highest of 3");
  });

  test("donut: the total", () => {
    const pie = spec({
      type: "doughnut",
      title: "Costi",
      labels: ["a", "b"],
      y: { unit: "€", decimals: 2 },
      datasets: [{ label: "€", data: [10.5, 4.25] }],
    });
    const hero = heroOf(pie, undefined, "it");
    expect(`${hero.num} ${hero.unit}`).toBe("14,75 €");
    expect(hero.context).toBe("totale");
    expect(hero.delta).toBeUndefined();
  });

  test("scatter: the slope per a round x step, with an r² chip", () => {
    const hero = heroOf(ROWS, undefined, "it");
    expect(`${hero.num} ${hero.unit}`).toBe("+9,0 s ogni 100 righe");
    expect(hero.chip).toBe("r² 1,00");
    expect(hero.context).toBe("tendenza · 8 punti");
  });

  test("scatter gate: < 8 points or r² < 0,5 → the point count, no slope", () => {
    const few = spec({
      ...ROWS,
      datasets: [{ label: "job", data: ROWS.datasets[0]?.data.slice(0, 7) ?? [] }],
    });
    const h1 = heroOf(few, undefined, "it");
    expect(`${h1.num} ${h1.unit}`).toBe("7 punti");
    expect(h1.chip).toBeUndefined();
    const noisy = spec({
      ...ROWS,
      datasets: [
        {
          label: "job",
          data: [1, 2, 3, 4, 5, 6, 7, 8].map((x) => ({ x, y: x % 2 === 0 ? 10 : 0 })),
        },
      ],
    });
    const h2 = heroOf(noisy, undefined, "it");
    expect(h2.unit).toBe("punti");
    expect(h2.chip).toBeUndefined();
  });
});

describe("T5.15 no emoji in the hero", () => {
  test("no non-ASCII hero/pill/chip glyph has the Emoji property", () => {
    const heroes = [
      heroOf(REVENUE, undefined, "it"),
      heroOf(REVENUE, 2, "en"),
      heroOf(TOKENS, undefined, "it"),
      heroOf(ROWS, undefined, "it"),
    ];
    const negative = spec({
      type: "line",
      title: "x",
      labels: ["a", "b"],
      datasets: [{ label: "s", data: [10, 5] }],
    });
    heroes.push(heroOf(negative, undefined, "it"));
    const text = heroes
      .map((h) => `${h.num}${h.unit}${h.delta?.text ?? ""}${h.chip ?? ""}${h.context}`)
      .join("");
    expect(text).toContain("▲");
    expect(text).toContain("▼");
    const bad = [...text].filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7f && /\p{Emoji}/u.test(ch));
    expect(bad).toEqual([]);
  });
});
