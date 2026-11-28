/**
 * The app's outbox WIRING (fix/mobile-media-live item 1), plus the settings row
 * the downscale bypass needs (item 5).
 *
 * The DECISIONS are pure and tested (`outbox.ts`, `photo-input.ts`,
 * `photo-settings-store.ts`). `App.tsx` imports React Native, whose sources are
 * Flow, so Bun cannot parse it: what is left to pin is "is it wired at all, and
 * over ONE session handle" — the `push-wiring-guards.test.ts` idiom.
 *
 * Item 1's bug was exactly this line: `outboxOf`'s `getSession` built its port
 * over `client.newSession(...)` — a SECOND `RemoteSession` for the same id. The
 * client keys its session table by id and reassigns the entry's listener
 * (`remote-client.ts:3023-3026`), so the screen's own `watch` received nothing:
 * a photo message's `text`/`turn_end` were dropped and the header stayed
 * "Running" over a turn the daemon had finished.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const app = readFileSync(join(APP, "App.tsx"), "utf8");

/** `App.tsx`'s `outboxOf`, from its declaration to the end of the driver factory. */
function outboxOf(): string {
  const start = app.indexOf("function outboxOf(");
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf("const drafts = createDraftStore(", start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
}

/** `App.tsx`'s `composeWiring`, from its declaration to the session-info wiring that follows it. */
function composeWiring(): string {
  const start = app.indexOf("function composeWiring(");
  expect(start).toBeGreaterThan(-1);
  const end = app.indexOf("function infoWiring(", start);
  expect(end).toBeGreaterThan(start);
  return app.slice(start, end);
}

describe("item 1: the outbox drives the SCREEN's session, never a second handle", () => {
  test("the driver's session source is the folding handle (mutation: `client.newSession` here → the screen's turn never ends)", () => {
    const body = outboxOf();
    // The one seam: the port comes from the screen's own handle, through the
    // driver's folding object — so the turn it starts folds into THAT transcript.
    expect(body).toContain("foldingOutboxSession(folding.handle");
    // A second handle for the same id replaces the client's stream listener and
    // steals the screen's turn: no `newSession` may appear in this factory.
    expect(body).not.toContain("newSession");
    expect(body).not.toContain("client.newSession");
    expect(body).not.toContain("open()");
  });

  test("the screen hands the driver its handle accessor (mutation: drop `handle` → the port has no session)", () => {
    const body = composeWiring();
    // The screen's own bindings: `driver: outbox.driver` and `handle: …` — the
    // accessor `foldingOutboxSession` reads.
    expect(body).toContain("driver: outbox.driver");
    expect(body).toContain("handle:");
  });
});

describe("item 5: the 'Send photos at original size' switch reaches the picker", () => {
  test("the photo port is built with the stored setting (mutation: drop it → every photo downscaled)", () => {
    // The whole function body, not a fixed character window: a slice of N chars
    // goes stale the moment an unrelated port is added above (it did, when the
    // PDF adapter landed — the guard then read text it never aimed at).
    const body = composeWiring();
    expect(body).toContain("sendPhotoOriginalSize");
    expect(body).toContain("adaptPick(await pickFromLibrary(taken, ");
  });

  test("Settings renders the row (the plan's switch, off by default)", () => {
    const settings = readFileSync(join(APP, "src", "screens", "SettingsScreen.tsx"), "utf8");
    expect(settings).toContain('testID="photos-original-size"');
  });
});

describe("item 3: pull-to-refresh is wired to the transcript list", () => {
  test("the transcript FlatList carries a RefreshControl over `controller.resync()` (mutation: drop it → no gesture)", () => {
    const screen = readFileSync(join(APP, "src", "screens", "SessionScreen.tsx"), "utf8");
    expect(screen).toContain("<RefreshControl");
    // The decision is the controller's (one session path); the component only
    // renders it (AGENTS §7) — and re-arms the silent landing first, so a pull
    // never scrolls the transcript again (docs/fix/mobile-open-at-end.md).
    expect(screen).toMatch(/onRefresh=\{\(\) => \{[\s\S]{0,300}void controller\.resync\(\);/);
    expect(screen).toContain("refreshing={rowsSlice.refreshing}");
  });
});

describe("item 4: the media bubble is laid out, not hand-placed", () => {
  test("TranscriptRow lays the media out through the pure model (mutation: hard-code a 96 pt square → no ratio, no clamp)", () => {
    const row = readFileSync(
      join(APP, "src", "screens", "transcript", "TranscriptRow.tsx"),
      "utf8",
    );
    // Since feat/mobile-thinking-images S4 the geometry is `photoBlock`'s (the
    // block above the bubble) and the bubble's existence is `userRowParts`'.
    expect(row).toContain("photoBlock(");
    expect(row).toContain("userRowParts(");
    // The local copy wins over a fetched thumbnail: it is the only pixels a
    // fresh send has.
    expect(row).toContain("ref.localUri ?? thumbnailFor(thumbnails, ref.id)?.uri");
  });

  test("tapping an image opens the full-screen viewer", () => {
    const row = readFileSync(
      join(APP, "src", "screens", "transcript", "TranscriptRow.tsx"),
      "utf8",
    );
    expect(row).toContain("<MediaViewer");
    const viewer = readFileSync(
      join(APP, "src", "screens", "transcript", "MediaViewer.tsx"),
      "utf8",
    );
    expect(viewer).toContain("<Modal");
    expect(viewer).toContain('testID="media-viewer"');
  });
});

describe("fix/mobile-qa-1119 row 8: the viewer draws its photo and can be closed", () => {
  const viewer = (): string =>
    readFileSync(join(APP, "src", "screens", "transcript", "MediaViewer.tsx"), "utf8");

  test('the photo has a MEASURED height, never a percent of a height-less zoom container (mutation: `height: "100%"` → a 0 pt photo)', () => {
    const source = viewer();
    expect(source).not.toContain('height: "100%"');
    expect(source).toContain(
      "onLayout={(event) => setPageHeight(event.nativeEvent.layout.height)}",
    );
    expect(source).toContain("style={{ width, height: pageHeight }}");
  });

  test("the bars clear the status bar: the ✕ is reachable (mutation: no safe-area top → ✕ under the status bar)", () => {
    const source = viewer();
    expect(source).toContain("useSafeAreaInsets()");
    expect(source).toContain("paddingTop: insets.top");
  });
});

describe("Review round 2 R2-1: a photo file that is gone falls back to the label", () => {
  test("the row's Image reports a load failure and the bubble then draws its label (mutation: no `onError` → an empty frame over a deleted file)", () => {
    const row = readFileSync(
      join(APP, "src", "screens", "transcript", "TranscriptRow.tsx"),
      "utf8",
    );
    // The decision is the pure module's (`media-layout.ts` `displayUri`, tested
    // there); the component supplies the answer to `<Image>`'s `onError` and
    // draws the label when that answer is `undefined`.
    expect(row).toContain("displayUri(");
    expect(row).toContain("onError=");
    expect(row).toContain("broken");
    // The label path is reachable AFTER a failed load, not only for a ref that
    // never had bytes: one `uri === undefined` branch, fed by `displayUri`.
    expect(row.match(/uri === undefined/g)?.length ?? 0).toBe(1);
  });

  test("the photo folder is bounded by the app, over the store's own in-use set (mutation: drop the sweep → the copies stay for ever; wire it before the load → an unread store guards nothing)", () => {
    const body = outboxOf();
    expect(body).toContain("prunePhotoCopies(");
    expect(body).toContain("inUseCopies(store.data)");
    expect(body).toContain("photosRoot()");
    // After the LOAD: the items and drafts it read back are exactly what must
    // not be trimmed.
    expect(body).toContain("store.load().then(");
    // A newer build's file is unreadable: its items guard their photos, so the
    // sweep is skipped rather than guessing.
    expect(body).toContain('loaded.kind === "refused"');
  });
});

describe("fix/mobile-qa-1119 row 12: sent photos keep their pixels after a resync", () => {
  test("the session screen's thumbnail port is the sent-photo index (mutation: no `thumbnails` → every history ref draws its label)", () => {
    expect(app).toContain("thumbnails: sentPhotoSource(");
    expect(app).toContain("store.data.sentPhotos?.[id]");
  });
});

describe("fix/mobile-qa-1119 row 12: the thumbnail window reads the LIST's current rows", () => {
  const screen = readFileSync(join(APP, "src", "screens", "SessionScreen.tsx"), "utf8");

  test("the viewability callback (created once) reads a ref of the rows, never the first render's state (mutation: `state.transcript.rows` → nothing is ever fetched)", () => {
    expect(screen).not.toContain("state.transcript.rows as readonly { kind: string }[]");
    expect(screen).toContain(
      "controller.window(visible.current.first, visible.current.last, listRows.current);",
    );
    expect(screen).toContain("listRows.current = data;");
  });

  test("a resync's new rows ask the window again (mutation: no effect → a rebuilt history stays labels)", () => {
    expect(screen).toContain(
      "controller.window(visible.current.first, visible.current.last, data);",
    );
  });
});
