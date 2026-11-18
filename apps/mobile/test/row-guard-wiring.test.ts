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

  test("renderItem wraps the whole row (SwipeTime + TranscriptRow) in RowGuard", () => {
    expect(screen).toMatch(
      /<RowGuard[\s\S]{0,300}fallback=\{<RowFallback palette=\{palette\} \/>\}[\s\S]{0,300}>\s*<SwipeTime[\s\S]*<TranscriptRow[\s\S]*<\/SwipeTime>\s*<\/RowGuard>/,
    );
  });

  test("a failed row retries when its row object changes (resetKey is the row itself)", () => {
    expect(screen).toMatch(/<RowGuard[\s\S]{0,300}resetKey=\{item\}[\s\S]{0,300}>\s*<SwipeTime/);
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
    expect(screen).toMatch(
      /onError=\{\(error\) => onRowError\?\.\(rowErrorFields\(item\.kind, error\)\)\}/,
    );
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
