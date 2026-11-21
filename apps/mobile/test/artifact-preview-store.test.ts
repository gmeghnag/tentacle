/**
 * The preview cards' KEPT previews, bounded (docs/feat/mobile-file-preview-cards.md,
 * Review round 1's finding 1): a preview is written beside the artifact cache —
 * outside `put`, so outside the 200 MB plan — and without its own bound every
 * page scrolled past leaves a JPEG for good. `planPreviewPrune` is the rule; the
 * expo binding (`artifact-preview-expo.ts`) only applies it.
 *
 * What this pins that a plain "delete the oldest file" cannot:
 * - a preview is a PAIR (`<sha>-w<W>.json` + its `.jpg`): deleting one half is
 *   not bounding anything — it is orphaning the other;
 * - the preview just written is never the one deleted, even when its clock is
 *   the oldest (two files may share a modification time);
 * - the store stops as soon as the rest fits, and still gets under a cap that
 *   even everything cannot meet.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PREVIEW_STORE_BYTES, planPreviewPrune } from "../src/artifact-preview-store.ts";

const expo = readFileSync(join(import.meta.dir, "..", "src", "artifact-preview-expo.ts"), "utf8");

const KB = 1024;

/** A real 64-hex content hash (the previews directory is named after versions). */
const sha = (tag: string): string => {
  let hex = "";
  for (const ch of tag) {
    hex += (ch.codePointAt(0) ?? 0).toString(16).padStart(2, "0");
  }
  return hex.repeat(Math.ceil(64 / hex.length)).slice(0, 64);
};
const A = `${sha("a")}-w358`;
const B = `${sha("b")}-w358`;
const C = `${sha("c")}-w358`;

/** One file in the previews directory (a `.json` or its `.jpg`). */
const file = (name: string, kb: number, usedAt: number) => ({
  name,
  size: kb * KB,
  usedAt,
});

/** A preview made at `usedAt`: its JSON, and the page image beside it. */
const pair = (base: string, kb: number, usedAt: number) => [
  file(`${base}.json`, 1, usedAt),
  file(`${base}.jpg`, kb, usedAt),
];

const sorted = (names: readonly string[]): readonly string[] => [...names].sort();

describe("planPreviewPrune: which previews are deleted", () => {
  test("under the cap nothing is deleted (mutation: always prune → red)", () => {
    const files = [...pair(A, 100, 1), ...pair(B, 100, 2)];
    expect(planPreviewPrune(files, 300 * KB)).toEqual([]);
    expect(planPreviewPrune([], 300 * KB)).toEqual([]);
  });

  test("over the cap the least recently MADE preview goes, JSON and image together (mutation: per-file → red)", () => {
    const files = [...pair(A, 100, 1), ...pair(B, 100, 2)];
    // 202 KB over a 150 KB cap: one whole preview has to go, not one file.
    expect(sorted(planPreviewPrune(files, 150 * KB))).toEqual([`${A}.jpg`, `${A}.json`]);
  });

  test("it stops as soon as the rest fits (mutation: delete everything → red)", () => {
    const files = [...pair(A, 100, 1), ...pair(B, 100, 2), ...pair(C, 100, 3)];
    expect(sorted(planPreviewPrune(files, 250 * KB))).toEqual([`${A}.jpg`, `${A}.json`]);
  });

  test("the preview just saved survives even when it looks the oldest (mutation: ignore `keep` → red)", () => {
    const files = [...pair(A, 100, 1), ...pair(B, 100, 2)];
    expect(sorted(planPreviewPrune(files, 150 * KB, A))).toEqual([`${B}.jpg`, `${B}.json`]);
  });

  test("a cap nothing fits still bounds the store (mutation: `wontFit`-style early return → red)", () => {
    const files = [...pair(A, 100, 1), ...pair(B, 100, 2)];
    expect(sorted(planPreviewPrune(files, 10 * KB))).toEqual([
      `${A}.jpg`,
      `${A}.json`,
      `${B}.jpg`,
      `${B}.json`,
    ]);
  });

  test("a preview whose image is already gone counts alone (and goes alone)", () => {
    const files = [file(`${A}.json`, 10, 1), ...pair(B, 90, 2)];
    expect(planPreviewPrune(files, 100 * KB)).toEqual([`${A}.json`]);
  });

  test("a shared modification time is broken by name, so the order is stable", () => {
    const files = [...pair(B, 100, 5), ...pair(A, 100, 5)];
    expect(sorted(planPreviewPrune(files, 150 * KB))).toEqual([`${A}.jpg`, `${A}.json`]);
  });

  test("a file that is not a preview is not counted (mutation: count every file → red)", () => {
    // Otherwise a stray file the plan cannot delete makes it over-evict previews
    // it never needed to touch — and never converge.
    const files = [...pair(A, 50, 1), { name: "stray.txt", size: 200 * KB, usedAt: 9 }];
    expect(planPreviewPrune(files, 100 * KB)).toEqual([]);
  });

  test("the default cap is the module's, and it is the one applied (mutation: default ∞ → red)", () => {
    const files = [file(`${A}.jpg`, PREVIEW_STORE_BYTES / KB - 10, 1), file(`${B}.jpg`, 20, 2)];
    expect(planPreviewPrune(files)).toEqual([`${A}.jpg`]);
    expect(
      planPreviewPrune(
        [file(`${A}.jpg`, PREVIEW_STORE_BYTES / KB - 10, 1), file(`${B}.jpg`, 5, 2)],
        PREVIEW_STORE_BYTES,
      ),
    ).toEqual([]);
  });
});

describe("the expo store applies the bound on every write", () => {
  test("`save` prunes after writing, and keeps the preview it just saved (mutation: plan only, never delete → red)", () => {
    // The rule is `planPreviewPrune`'s; what only the wiring can get wrong is
    // NOT calling it (the bytes then grow until unpair — Review round 1, finding 1).
    expect(expo).toContain("planPreviewPrune(");
    expect(expo).toContain("PREVIEW_STORE_BYTES");
    // It runs on `save`, and the preview being saved is the one excluded.
    const save = expo.slice(expo.indexOf("    save(meta, key, preview) {"));
    const body = save.slice(0, save.indexOf("\n    imageUri("));
    expect(body).toContain("file.writeSync(");
    expect(body.indexOf("planPreviewPrune(")).toBeGreaterThan(body.indexOf("file.writeSync("));
    expect(body).toContain("`${meta.sha256}-${key}`");
    // The files it lists are only what is IN the previews directory.
    expect(body).toContain("directory.list()");
    expect(body).toContain("doomed.delete()");
  });

  test("the bound is the previews' own, not the artifact cache's (mutation: use ARTIFACT_CACHE_BYTES → red)", () => {
    expect(expo).toContain("PREVIEW_STORE_BYTES");
    expect(expo).not.toContain("ARTIFACT_CACHE_BYTES");
    expect(PREVIEW_STORE_BYTES).toBeLessThan(200 * 1024 * 1024);
  });
});
