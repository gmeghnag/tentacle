/**
 * T6, the pure half (docs/feat/model-charts.md slice C6): which tool row draws
 * as a chart, the per-mode chart tokens, and how a layout `Paint` / text role
 * resolves to a colour. The component (`ui/chart/ChartView.tsx`) only maps.
 */
import { describe, expect, test } from "bun:test";
import { seriesColor } from "@tentacle/core";
import {
  chartRowSpec,
  chartRowView,
  chartScheme,
  paintColor,
  textColor,
} from "../src/chart-row.ts";
import { chartTokensFor, darkPalette, lightPalette } from "../src/theme.ts";
import { REVENUE } from "./chart-fixtures.ts";

const ARGS = JSON.stringify(REVENUE);
const row = (over: Partial<{ name: string; args: string; status: string }> = {}) => ({
  name: "chart",
  args: ARGS,
  status: "ok" as const,
  ...over,
});

describe("chartRowSpec — the transcript branch's decision", () => {
  test("a `chart` call with a valid spec draws as a chart (running and ok)", () => {
    expect(chartRowSpec(row())?.title).toBe("Ricavi");
    expect(chartRowSpec(row({ status: "running" }))?.title).toBe("Ricavi");
  });

  test("another tool with the same arguments stays a generic row", () => {
    expect(chartRowSpec(row({ name: "fs_write" }))).toBeNull();
  });

  test("a forged / invalid spec (a pod's rawInput) falls back to the generic row", () => {
    const forged = JSON.stringify({ ...REVENUE, datasets: [{ label: "x", data: ["12.5"] }] });
    expect(chartRowSpec(row({ args: forged }))).toBeNull();
    expect(chartRowSpec(row({ args: "{not json" }))).toBeNull();
    expect(chartRowSpec(row({ args: "" }))).toBeNull();
  });

  test("a failed or refused call keeps its tool row (its error text is the content)", () => {
    expect(chartRowSpec(row({ status: "error" }))).toBeNull();
    expect(chartRowSpec(row({ status: "denied" }))).toBeNull();
  });
});

describe("chartRowView", () => {
  const opts = { width: 358, fontScale: 1, locale: "it-IT", palette: lightPalette };

  test("lays the chart out at the given width, with the spec's caption", () => {
    const view = chartRowView(row(), opts);
    expect(view?.layout.width).toBe(358);
    expect(view?.title).toBe("Ricavi");
    expect(view?.scheme).toBe("light");
  });

  test("a new width re-lays out (rotation / split view), not a stale cached layout", () => {
    const a = chartRowView(row(), opts);
    const b = chartRowView(row(), { ...opts, width: 700 });
    expect(a?.layout.width).toBe(358);
    expect(b?.layout.width).toBe(700);
  });

  test("full screen (C7): a height and hidden series re-lay out; the spec rides the view", () => {
    const inline = chartRowView(row(), opts);
    const full = chartRowView(row(), { ...opts, height: 240, hidden: new Set([1]) });
    expect(full?.layout.height).toBe(240);
    const lineSeries = (v: typeof full) =>
      (v?.layout.paths ?? []).filter((p) => p.role === "line").map((p) => p.series);
    expect(lineSeries(full)).toEqual([0]);
    // The inline row (same width, nothing hidden) is not served the full-screen layout.
    expect(lineSeries(chartRowView(row(), opts)).sort()).toEqual([0, 1]);
    expect(inline?.layout.height).not.toBe(240);
    // Same width and height, the series back on: not the cached hidden layout.
    expect(lineSeries(chartRowView(row(), { ...opts, height: 240 })).sort()).toEqual([0, 1]);
    expect(full?.spec.datasets.length).toBe(2);
  });

  test("no width yet, or an invalid spec → null", () => {
    expect(chartRowView(row(), { ...opts, width: 0 })).toBeNull();
    expect(chartRowView(row({ name: "shell" }), opts)).toBeNull();
  });
});

describe("chart tokens and colours", () => {
  test("the scheme follows the palette", () => {
    expect(chartScheme(lightPalette)).toBe("light");
    expect(chartScheme(darkPalette)).toBe("dark");
  });

  test("the tokens per mode are the picked mockup's (modern-manifest.json)", () => {
    const light = chartTokensFor(lightPalette);
    const dark = chartTokensFor(darkPalette);
    expect(light.guide).toBe("rgba(60,60,67,0.22)");
    expect(light.track).toBe("#F0F0F3");
    expect(dark.guide).toBe("rgba(242,241,236,0.16)");
    expect(dark.mutedLine).toBe("#77756F");
    // Text and the dot rings come from the app's own theme, not the mockup.
    expect(light.label).toBe(lightPalette.label);
    expect(dark.secondary).toBe(darkPalette.sec);
    expect(dark.surface).toBe(darkPalette.page);
  });

  test("a series paint is its palette slot in that mode; a token paint is the token", () => {
    const tokens = chartTokensFor(darkPalette);
    expect(paintColor({ series: 2 }, "dark", tokens)).toBe(seriesColor(2, "dark"));
    expect(paintColor({ series: 2 }, "light", tokens)).toBe(seriesColor(2, "light"));
    expect(paintColor({ token: "track" }, "dark", tokens)).toBe(tokens.track);
    expect(paintColor({ token: "label" }, "dark", tokens)).toBe(tokens.label);
  });

  test("text: direct labels in their series colour, ticks secondary, strong ones label", () => {
    const tokens = chartTokensFor(lightPalette);
    const t = { x: 0, y: 0, text: "a", anchor: "start" as const, size: 11 };
    expect(textColor({ ...t, role: "direct", series: 1 }, "light", tokens)).toBe(
      seriesColor(1, "light"),
    );
    expect(textColor({ ...t, role: "x" }, "light", tokens)).toBe(tokens.secondary);
    expect(textColor({ ...t, role: "guide" }, "light", tokens)).toBe(tokens.secondary);
    expect(textColor({ ...t, role: "x", strong: true }, "light", tokens)).toBe(tokens.label);
    expect(textColor({ ...t, role: "center" }, "light", tokens)).toBe(tokens.label);
  });
});
