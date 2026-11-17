/**
 * T7, the pure half (docs/feat/model-charts.md slice C7): full screen toggles
 * and KPIs, the table's Δ column, Share's CSV, VoiceOver's actions, the appear
 * animation's descriptor (Reduce Motion → opacity only; history → still) and
 * the scrub driver with a SPY haptic port (one `tick` per category).
 */
import { describe, expect, test } from "bun:test";
import {
  type ScrubPorts,
  appearPlan,
  chartA11yActions,
  chartA11yEffect,
  chartCsv,
  chartMotion,
  claimAppear,
  createScrubDriver,
  csvCell,
  fullScreenKpis,
  fullScreenPlotSize,
  seriesChips,
  tableView,
  toggleSeries,
} from "../src/chart-interact.ts";
import type { LayoutKind } from "../src/chart-layout-kit.ts";
import { chartLayout } from "../src/chart-layout.ts";
import { HOLD_MS } from "../src/chart-scrub.ts";
import { REVENUE, spec } from "./chart-fixtures.ts";

const IT = "it-IT";

describe("toggleSeries — colours stay, the last series stays on", () => {
  test("hides and shows a series", () => {
    const off = toggleSeries(new Set(), 1, 2);
    expect([...off]).toEqual([1]);
    expect([...toggleSeries(off, 1, 2)]).toEqual([]);
  });
  test("the last visible series cannot be hidden", () => {
    const off = new Set([1]);
    expect(toggleSeries(off, 0, 2)).toBe(off);
  });
  test("an index out of range changes nothing", () => {
    const none = new Set<number>();
    expect(toggleSeries(none, 2, 2)).toBe(none);
    expect(toggleSeries(none, -1, 2)).toBe(none);
    expect(toggleSeries(none, 0.5, 2)).toBe(none);
  });
  test("hiding a series keeps the other's colour slot (the layout's index)", () => {
    const three = spec({
      type: "line",
      title: "t",
      labels: ["a", "b", "c"],
      datasets: [
        { label: "A", data: [1, 2, 3] },
        { label: "B", data: [2, 3, 4] },
        { label: "C", data: [3, 4, 5] },
      ],
    });
    const layout = chartLayout(three, { width: 360, hidden: toggleSeries(new Set(), 1, 3) });
    const lines = (layout?.paths ?? [])
      .filter((p) => p.role === "line")
      .sort((a, b) => a.series - b.series);
    expect(lines.map((p) => p.series)).toEqual([0, 2]);
    expect(lines.map((p) => p.paint)).toEqual([{ series: 0 }, { series: 2 }]);
  });
  test("chips: one per dataset with its state; none for a single series", () => {
    const chips = seriesChips(REVENUE, new Set([1]), IT);
    expect(chips.map((c) => [c.label, c.on, c.a11y])).toEqual([
      ["2026", true, "2026, visibile"],
      ["2025", false, "2025, nascosta"],
    ]);
    const one = spec({
      type: "bar",
      title: "t",
      labels: ["a"],
      datasets: [{ label: "x", data: [1] }],
    });
    expect(seriesChips(one, new Set(), IT)).toEqual([]);
  });
});

describe("fullScreenKpis — B's strip: last · mean · max of the first visible series", () => {
  test("revenue 2026: last October with the hero's delta, mean, max", () => {
    const k = fullScreenKpis(REVENUE, new Set(), IT);
    expect(k.map((x) => x.key)).toEqual(["ULTIMO · ottobre", "MEDIA 2026", "MASSIMO"]);
    expect(k[0]?.value).toBe("20.800 €");
    expect(k[0]?.delta?.text).toBe("▲ 26,8%");
    expect(k[1]?.value).toBe("16.020 €");
    expect(k[2]?.sub).toBe("ottobre");
  });
  test("series 0 hidden → the strip reads 2025, with no delta", () => {
    const k = fullScreenKpis(REVENUE, new Set([0]), IT);
    expect(k[0]?.key).toBe("ULTIMO · dicembre");
    expect(k[0]?.value).toBe("18.900 €");
    expect(k[0]?.delta).toBeUndefined();
    expect(k[1]?.key).toBe("MEDIA 2025");
  });
  test("donut and scatter have no strip", () => {
    const pie = spec({
      type: "pie",
      title: "t",
      labels: ["a", "b"],
      datasets: [{ label: "x", data: [1, 2] }],
    });
    const sc = spec({
      type: "scatter",
      title: "t",
      datasets: [{ label: "x", data: [{ x: 1, y: 2 }] }],
    });
    expect(fullScreenKpis(pie, new Set(), IT)).toEqual([]);
    expect(fullScreenKpis(sc, new Set(), IT)).toEqual([]);
  });
  test("English words", () => {
    expect(fullScreenKpis(REVENUE, new Set(), "en-US").map((x) => x.key)[2]).toBe("MAX");
  });
});

describe("tableView — table A's Δ column", () => {
  test("a two-series comparison gains Δ = series 0 vs series 1, blank where one is missing", () => {
    const layout = chartLayout(REVENUE, { width: 360, locale: IT });
    const t = layout === null ? null : tableView(REVENUE, layout.table, IT);
    expect(t?.header.at(-1)).toBe("Δ");
    expect(t?.rows[9]?.at(-1)).toBe("▲ 26,8%");
    expect(t?.rows[11]?.at(-1)).toBe("");
  });
  test("stacked, single-series and pie keep the plain table", () => {
    const stacked = spec({
      type: "bar",
      stacked: true,
      title: "t",
      labels: ["a", "b"],
      datasets: [
        { label: "A", data: [1, 2] },
        { label: "B", data: [2, 3] },
      ],
    });
    const plain = { header: ["", "A", "B"], rows: [["a", "1", "2"]] };
    expect(tableView(stacked, plain, IT)).toBe(plain);
  });
});

describe("chartCsv — Share", () => {
  test("raw numbers, empty for null, labels as written", () => {
    const csv = chartCsv(REVENUE).split("\n");
    expect(csv[0]).toBe("x,2026,2025");
    expect(csv[10]).toBe("ottobre,20800,16400");
    expect(csv[12]).toBe("dicembre,,18900");
  });
  test("cells are escaped and formula-looking text is neutralised", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-x")).toBe("'-x");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell("a\nb")).toBe('"a\nb"');
    expect(csvCell(null)).toBe("");
  });
  test("point form: one row per point, its own column", () => {
    const sc = spec({
      type: "scatter",
      title: "t",
      datasets: [
        { label: "A", data: [{ x: 1, y: 2 }] },
        {
          label: "B",
          data: [
            { x: 3, y: null },
            { x: 4, y: 5 },
          ],
        },
      ],
    });
    expect(chartCsv(sc).split("\n")).toEqual(["x,A,B", "1,2,", "3,,", "4,,5"]);
  });
});

describe("VoiceOver — one element, its actions", () => {
  test("open + show table (chart shown), open + show chart (table shown)", () => {
    expect(chartA11yActions("chart", IT)).toEqual([
      { name: "activate", label: "Apri a schermo intero" },
      { name: "showTable", label: "Mostra tabella dati" },
    ]);
    expect(chartA11yActions("table", "en").map((a) => a.name)).toEqual(["activate", "showChart"]);
  });
  test("an unknown action does nothing", () => {
    expect(chartA11yEffect("showTable")).toBe("showTable");
    expect(chartA11yEffect("magicTap")).toBeNull();
  });
});

describe("chartMotion — the appear animation's descriptor", () => {
  const KINDS: LayoutKind[] = ["line", "area", "bars", "columns", "stacked", "donut", "scatter"];
  test("Reduce Motion: opacity only, for every kind", () => {
    for (const kind of KINDS) {
      expect(chartMotion(kind, { animate: true, reduceMotion: true })).toEqual({
        kind: "fade",
        ms: 280,
      });
    }
  });
  test("a row that does not animate is still, Reduce Motion or not", () => {
    for (const kind of KINDS) {
      expect(chartMotion(kind, { animate: false, reduceMotion: false })).toEqual({ kind: "still" });
      expect(chartMotion(kind, { animate: false, reduceMotion: true })).toEqual({ kind: "still" });
    }
  });
  test("full motion per kind", () => {
    const m = (kind: LayoutKind) => chartMotion(kind, { animate: true, reduceMotion: false }).kind;
    expect(KINDS.map(m)).toEqual(["draw", "draw", "grow", "grow", "grow", "pop", "draw"]);
  });
  test("appearPlan: Reduce Motion animates opacity only (no wipe, no scale)", () => {
    for (const kind of KINDS) {
      const plan = appearPlan(chartMotion(kind, { animate: true, reduceMotion: true }));
      expect(plan).toEqual({ opacity: { ms: 280, delay: 0 }, native: true });
    }
    expect(appearPlan({ kind: "still" })).toBeNull();
  });
  test("appearPlan: full motion — lines wipe (JS), bars grow from their base, donut pops", () => {
    const plan = (kind: LayoutKind) =>
      appearPlan(chartMotion(kind, { animate: true, reduceMotion: false }));
    expect(plan("line")).toEqual({ wipe: { ms: 900 }, native: false });
    expect(plan("bars")?.scale).toEqual({ axis: "x", from: 0, origin: "left" });
    expect(plan("columns")?.scale).toEqual({ axis: "y", from: 0, origin: "bottom" });
    expect(plan("donut")?.scale?.from).toBe(0.82);
  });
  test("fullScreenPlotSize: the window minus insets, header and strip; never under 120 tall", () => {
    const insets = { top: 0, bottom: 21, left: 59, right: 59 };
    expect(fullScreenPlotSize({ width: 844, height: 390 }, insets, true)).toEqual({
      width: 694,
      height: 237,
    });
    expect(fullScreenPlotSize({ width: 300, height: 100 }, insets, false).height).toBe(120);
  });
  test("claimAppear: once per id, only when first seen live", () => {
    const seen = new Set<string>();
    expect(claimAppear(seen, "a", "running")).toBe(true);
    expect(claimAppear(seen, "a", "running")).toBe(false); // scrolled back into view
    expect(claimAppear(seen, "h", "ok")).toBe(false); // rebuilt from history
    expect(claimAppear(seen, "h", "running")).toBe(false);
  });
});

describe("createScrubDriver — the haptic port gets one tick per category", () => {
  const harness = (hit: (x: number) => number | null) => {
    const ticks: string[] = [];
    const indices: (number | null)[] = [];
    let taps = 0;
    let yields = 0;
    const ports: ScrubPorts = {
      hit,
      play: (k) => ticks.push(k),
      onIndex: (i) => indices.push(i),
      onTap: () => {
        taps += 1;
      },
      onYield: () => {
        yields += 1;
      },
    };
    const driver = createScrubDriver(() => ports);
    return { driver, ticks, indices, taps: () => taps, yields: () => yields };
  };
  const byTen = (x: number) => Math.max(0, Math.min(11, Math.floor(x / 10)));

  test("hold, then sweep across 4 categories with repeats: 4 ticks, release → rest", () => {
    const h = harness(byTen);
    h.driver.send({ type: "down", p: { x: 5, y: 5 }, t: 0 });
    expect(h.driver.holding()).toBe(true);
    h.driver.send({ type: "timer", t: HOLD_MS });
    expect(h.driver.scrubbing()).toBe(true);
    for (const x of [6, 8, 15, 18, 25, 25, 35])
      h.driver.send({ type: "move", p: { x, y: 5 }, t: 400 });
    h.driver.send({ type: "up" });
    expect(h.ticks).toEqual(["tick", "tick", "tick", "tick"]);
    expect(h.indices).toEqual([0, 1, 2, 3, null]);
    expect(h.driver.holding()).toBe(false);
    expect(h.taps()).toBe(0);
  });
  test("a quick tap opens full screen, with no tick", () => {
    const h = harness(byTen);
    h.driver.send({ type: "down", p: { x: 5, y: 5 }, t: 0 });
    h.driver.send({ type: "up" });
    expect(h.taps()).toBe(1);
    expect(h.ticks).toEqual([]);
  });
  test("a vertical pan before the hold yields to the list: no tick, no tap", () => {
    const h = harness(byTen);
    h.driver.send({ type: "down", p: { x: 5, y: 5 }, t: 0 });
    h.driver.send({ type: "move", p: { x: 5, y: 40 }, t: 60 });
    h.driver.send({ type: "timer", t: HOLD_MS });
    h.driver.send({ type: "up" });
    expect(h.yields()).toBe(1);
    expect(h.ticks).toEqual([]);
    expect(h.taps()).toBe(0);
  });
  test("a chart that does not scrub: the hold does nothing, no tick", () => {
    const h = harness(() => null);
    h.driver.send({ type: "down", p: { x: 5, y: 5 }, t: 0 });
    h.driver.send({ type: "timer", t: HOLD_MS });
    h.driver.send({ type: "up" });
    expect(h.ticks).toEqual([]);
    expect(h.indices).toEqual([]);
  });
});
