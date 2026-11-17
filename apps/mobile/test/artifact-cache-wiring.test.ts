/**
 * The D9 cache contract's WIRING (Review round 3, findings 1 and 2): the pure
 * plan (`artifact-cache.ts`) and the bytes' two pure steps (`artifact-open.ts`)
 * were tested while nothing called them, so the phone kept every byte it ever
 * read, forever, including after an unpair — and Share handed over a 64-hex blob
 * with no name and no extension.
 *
 * Source pins, not renders: `App.tsx` imports React Native (Flow) and the `.tsx`
 * viewers cannot be mounted under `bun test`. The decisions are asserted as
 * values in `artifact-cache-store.test.ts` / `artifact-cache.test.ts`; what only
 * the wiring can get wrong — not calling it at all, or calling it in the wrong
 * place — is what this file pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const read = (...parts: readonly string[]): string => readFileSync(join(APP, ...parts), "utf8");

const modal = read("src", "screens", "artifacts", "ArtifactViewerModal.tsx");
const store = read("src", "artifact-cache-store.ts");
const thumbnail = read("src", "artifact-thumbnail.ts");
const app = read("App.tsx");

/** One `App.tsx` block, from `from` to its own closing `}`. */
function body(from: string): string {
  const start = app.indexOf(from);
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf("\n              }", start);
  return app.slice(start, end === -1 ? app.indexOf("\n};", start) : end);
}

describe("the viewer writes through the LRU, never straight into the cache", () => {
  test("the modal calls the store's `put` and writes no file itself (mutation: back to `file.write(bytes)` → red)", () => {
    expect(modal).toContain("ARTIFACT_CACHE.put(");
    // The copy the plan governs is the store's; a second, unplanned write is
    // exactly the bug (the cap could never see those bytes).
    expect(modal).not.toContain("file.write(");
    expect(modal).not.toContain("file.create(");
    // And the plan's step is what the store itself applies (`cacheStep`).
    expect(store).toContain("cacheStep(");
    expect(store).toContain("step.evict");
  });

  test("a file too big to keep is SAID, never a blank screen (mutation: drop the note row → red)", () => {
    // The plan's `note` reaches the screen: the store returns it and the modal
    // renders it under the header (the bytes still show; only Share is lost).
    expect(modal).toContain('testID="artifact-cache-note"');
    expect(modal).toContain("note");
  });

  test("thumbnails go through the same one writer, so the cap sees them too (mutation: direct write → red)", () => {
    expect(thumbnail).toContain("ARTIFACT_CACHE.put(");
    expect(thumbnail).not.toContain("file.write(");
    expect(thumbnail).not.toContain("new File(");
  });
});

describe("Share hands over a NAMED copy, not the content hash", () => {
  test("the modal shares the store's named copy (mutation: share `phase.fileUri` → red)", () => {
    expect(modal).toContain("shareCopy(");
    // The hash path is still what the VIEWERS load; only Share wants the name.
    expect(modal).not.toMatch(/onShare\?\.\(phase\.fileUri\)/);
  });

  test("the named copy is removed after the sheet closes (never left uncounted)", () => {
    // A share copy is NOT a cached version, so nothing would ever evict it: the
    // Share handler deletes it when the sheet closes (the `app-log-fs` F18 rule).
    expect(read("src", "artifact-cache-expo.ts")).toContain("shareCachedCopy");
    expect(app).toContain("shareCachedCopy(fileUri)");
    expect(app).not.toContain("Share.share({ url: fileUri })");
  });

  test("the name is `shareName`'s, with the type's extension (D9)", () => {
    expect(store).toContain("shareName(");
    expect(store).toContain("artifactFileExt(");
  });
});

describe("an unpair drops the computer's cache and its feeds", () => {
  test("the app's ONE forget step carries them (mutation: leave them out of MEMORY → red)", () => {
    // One place decides what is forgotten (finding 1 of the pairing fix): the
    // cache and the feeds are two more facts about a computer whose record is
    // gone, so they ride the same `MEMORY` the removal already goes through.
    const memory = body("const MEMORY: ComputerMemory<ComputerLink> = {");
    expect(memory).toContain("artifactCache: ARTIFACT_CACHE,");
    expect(memory).toContain("feeds: ARTIFACT_FEEDS,");
    // And the removal itself is the step that applies it (never a second,
    // hand-rolled teardown that could forget one of them).
    expect(body("onRemove={async (row) => {")).toContain("withForgottenRecord(MEMORY, row.id");
  });

  test("the feeds also go when the session's own screen ends", () => {
    // A feed is per computer AND session: one whose session is gone must not let
    // a later gallery read a list nobody publishes any more.
    expect(read("src", "artifact-feed.ts")).toContain("forgetComputer(computerId)");
  });
});
