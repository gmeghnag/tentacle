/**
 * `feat/mobile-chart-labels` D7 — the setting's wiring, pinned as SOURCE (the
 * `tool-rows-wiring.test.ts` pattern): these files import React Native and the
 * Keychain adapter, so the thing to prove is which component OWNS the
 * subscription (one listener per screen, not one per chart row) and that every
 * consumer passes the mode down instead of re-reading it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");
const APP = join(import.meta.dir, "..");
const read = (...parts: readonly string[]): string => readFileSync(join(SRC, ...parts), "utf8");

describe("the Charts setting reaches every chart, and only the screen subscribes", () => {
  test("the session screen reads it once and hands it to every transcript row", () => {
    const screen = read("screens", "SessionScreen.tsx");
    expect(screen).toMatch(
      /useState<ChartSettings>\(\(\) => CHART_SETTINGS\.current\(\)\)[\s\S]{0,120}CHART_SETTINGS\.subscribe\(setChartSettings\)/,
    );
    // Through the memoized cell (docs/fix/mobile-fan-jank-device.md).
    expect(screen).toMatch(/<TranscriptCell[\s\S]{0,800}chartLabels=\{chartSettings\.labels\}/);
    const cell = read("screens", "transcript", "TranscriptCell.tsx");
    expect(cell).toMatch(/<TranscriptRow[\s\S]{0,400}chartLabels=\{props\.chartLabels\}/);
  });

  test("a transcript chart row takes the mode as a prop (no listener of its own)", () => {
    const row = read("screens", "transcript", "TranscriptRow.tsx");
    expect(row).toMatch(/readonly chartLabels\?: LabelMode;/);
    expect(row).toMatch(/const labels = props\.chartLabels \?\? "inside";/);
    expect(row).toMatch(/chartRowView\(tool, \{[\s\S]{0,300}labels,/);
    // …and it becomes the full screen's mode too, so a tap does not re-lay out.
    expect(row).toMatch(/<ChartBlock[\s\S]{0,300}labels=\{labels\}/);
    // The store import lives in the ONE hook + the two screens, never here.
    expect(row).not.toContain("chart-settings-expo");
  });

  test("the gallery owns the setting for a chart artifact's full screen", () => {
    const gallery = read("screens", "ArtifactGallery.tsx");
    expect(gallery).toContain("useChartLabels");
    expect(gallery).toMatch(/<ArtifactViewerModal[\s\S]{0,300}chartLabels=\{chartLabels\}/);
    const modal = read("screens", "artifacts", "ArtifactViewerModal.tsx");
    expect(modal).toMatch(/readonly chartLabels\?: LabelMode;/);
    expect(modal).toMatch(/<ChartFullScreen[\s\S]{0,400}labels: props\.chartLabels/);
  });

  test("full screen takes the mode; absent (a build without the setting) it is `inside`", () => {
    const full = read("ui", "chart", "ChartFullScreen.tsx");
    expect(full).toMatch(/readonly labels\?: LabelMode;/);
    expect(full).toMatch(/const labels = props\.labels \?\? "inside";/);
    expect(full).toMatch(/chartRowView\(props\.tool, \{[\s\S]{0,400}labels,\n\s*\}\);/);
    // D3's two taps, in the stateful half the render test cannot walk: a legend
    // item toggles the highlight, and hiding that series clears it.
    expect(full).toMatch(
      /onHighlight: \(k: number\) => setHighlight\(\(h\) => toggleHighlight\(h, k\)\)/,
    );
    expect(full).toMatch(/setHighlight\(\(h\) => \(h === k \? null : h\)\)/);
  });

  test("the inline block applies the highlight to the layout it draws", () => {
    const block = read("ui", "chart", "ChartBlock.tsx");
    // The scrub reads the SHOWN layout, so a scrubbed hero is `k`'s too (D6).
    expect(block).toMatch(
      /const shown =[\s\S]{0,200}highlightLayout\(view\.layout, view\.spec, highlight, locale\)/,
    );
    expect(block).toMatch(/useChartScrub\(shown\.layout/);
    expect(block).toMatch(/<ChartView\s+view=\{shown\}/);
    expect(block).toMatch(
      /onHighlight: \(k: number\) => setHighlight\(\(h\) => toggleHighlight\(h, k\)\)/,
    );
    // Only where a legend exists: C has no item to tap (the scrub is its gesture).
    expect(block).toMatch(/view\.layout\.legend === null\s*\?\s*\{\}/);
  });

  test("Settings has its own Charts section, with the two choices, and App loads it at launch", () => {
    const settings = read("screens", "SettingsScreen.tsx");
    expect(settings).toContain('title="Charts"');
    expect(settings).toMatch(
      /export const CHART_LABEL_ROWS[\s\S]{0,220}\{ value: "inside", label: "Labels on the lines" \},\s*\{ value: "legend", label: "Legend above the chart" \},/,
    );
    expect(settings).toMatch(/testID=\{`chart-labels-\$\{row\.value\}`\}/);
    // A newer build's record can be read but not written: the rows say so.
    expect(settings).toMatch(/dimmed=\{!chartWritable\}/);
    const app = readFileSync(join(APP, "App.tsx"), "utf8");
    expect(app).toMatch(/void CHART_SETTINGS\.load\(\)/);
    expect(app).toMatch(/<SettingsScreen[\s\S]{0,2000}chartLabels=\{chartSettings\.labels\}/);
    expect(app).toMatch(/onChartLabels=\{selectChartLabels\}/);
  });
});
