/**
 * docs/fix/mobile-crash-ibm-chart.md — the component half: these files import
 * React Native, so their wiring is pinned as SOURCE (the
 * `tool-rows-wiring.test.ts` pattern). The boundary's contract is in
 * `row-guard.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");

describe("every transcript row is guarded", () => {
  const screen = read("src", "screens", "SessionScreen.tsx");
  // The row is drawn by the memoized cell (docs/fix/mobile-fan-jank-device.md).
  const cell = read("src", "screens", "transcript", "TranscriptCell.tsx");

  test("renderItem wraps the whole row (SwipeTime + TranscriptRow) in RowGuard", () => {
    expect(screen).toMatch(/return \(\s*<TranscriptCell/);
    expect(cell).toMatch(
      /<RowGuard[\s\S]{0,300}fallback=\{<RowFallback palette=\{palette\} \/>\}[\s\S]{0,300}>\s*<SwipeTime[\s\S]*<TranscriptRow[\s\S]*<\/SwipeTime>\s*<\/RowGuard>/,
    );
  });

  test("a failed row retries when its row object changes (resetKey is the row itself)", () => {
    expect(screen).toMatch(/<TranscriptCell\s+row=\{item\}/);
    expect(cell).toMatch(/<RowGuard[\s\S]{0,300}resetKey=\{row\}[\s\S]{0,300}>\s*<SwipeTime/);
  });

  test("the artifact viewer's full-screen chart is guarded too, and logs a client-error", () => {
    const viewer = read("src", "screens", "artifacts", "ArtifactViewerModal.tsx");
    expect(viewer).toMatch(
      /<RowGuard[\s\S]{0,800}onError=\{\(error\) => props\.onRenderError\?\.\(rowErrorFields\("artifact-chart", error\)\)\}[\s\S]{0,200}>\s*<ChartFullScreen[\s\S]*?\/>\s*<\/RowGuard>/,
    );
    const gallery = read("src", "screens", "ArtifactGallery.tsx");
    expect(gallery).toMatch(
      /<ArtifactViewerModal\s+palette=[\s\S]{0,800}onRenderError: props\.onRenderError/,
    );
    const app = read("App.tsx");
    expect(app).toMatch(
      /<ArtifactGalleryScreen[\s\S]{0,1200}onRenderError=\{\(fields\) => APP_LOG\.log\("error", "client-error", fields\)\}/,
    );
  });

  test("a caught row error is reported with the row's kind", () => {
    expect(cell).toMatch(
      /onError=\{\(error\) => actions\.current\.onRowError\(rowErrorFields\(row\.kind, error\)\)\}/,
    );
    expect(screen).toMatch(/onRowError: \(fields\) => onRowError\?\.\(fields\)/);
  });

  test("the fallback is a TranscriptRow-side notice row", () => {
    const row = read("src", "screens", "transcript", "TranscriptRow.tsx");
    expect(row).toMatch(/export function RowFallback\([\s\S]{0,400}ROW_FALLBACK_TEXT/);
  });

  test("the app logs a row error to its ONE log, as a client-error", () => {
    const app = read("App.tsx");
    expect(app).toMatch(
      /onRowError=\{\(fields\) => APP_LOG\.log\("error", "client-error", fields\)\}/,
    );
  });
});
