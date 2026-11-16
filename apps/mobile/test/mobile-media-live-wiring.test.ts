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
    const start = app.indexOf("function composeWiring(");
    expect(start).toBeGreaterThan(-1);
    // The screen's own bindings: `driver: outbox.driver` and `handle: …` — the
    // accessor `foldingOutboxSession` reads.
    expect(app.slice(start, start + 600)).toContain("driver: outbox.driver");
    expect(app.slice(start, start + 900)).toContain("handle:");
  });
});

describe("item 5: the 'Send photos at original size' switch reaches the picker", () => {
  test("the photo port is built with the stored setting (mutation: drop it → every photo downscaled)", () => {
    const start = app.indexOf("function composeWiring(");
    const body = app.slice(start, start + 1600);
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
    // renders it (AGENTS §7).
    expect(screen).toContain("onRefresh={() => void controller.resync()}");
    expect(screen).toContain("refreshing={state.refreshing}");
  });
});

describe("item 4: the media bubble is laid out, not hand-placed", () => {
  test("TranscriptRow lays the media out through the pure model (mutation: hard-code a 96 pt square → no ratio, no clamp)", () => {
    const row = readFileSync(
      join(APP, "src", "screens", "transcript", "TranscriptRow.tsx"),
      "utf8",
    );
    expect(row).toContain("layoutMedia(");
    expect(row).toContain("mediaBox(");
    // The local copy wins over a fetched thumbnail: it is the only pixels a
    // fresh send has.
    expect(row).toContain("image.localUri ?? thumb?.uri");
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
