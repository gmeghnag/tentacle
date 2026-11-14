/**
 * The live scan session's lifetime (docs/feat/mobile-pairing-screen.md 11b.2,
 * fix round 1 finding 1). RED before the fix: the session's lifetime was a
 * `useState` in the native seam, so the only way it ended was a decode or a mount
 * error — a paste after a Scan tap left the camera live through
 * `review`/`connecting`/`compare` until the route unmounted, and nothing could
 * close it.
 */
import { describe, expect, test } from "bun:test";
import {
  INITIAL_SCAN_SESSION,
  type PairingStage,
  type ScanSession,
  scanReduce,
  scannerLive,
} from "../src/scan-session.ts";

/** Apply events in order (the hook's own sequence). */
function run(events: Parameters<typeof scanReduce>[1][]): ScanSession {
  return events.reduce(scanReduce, INITIAL_SCAN_SESSION);
}

const STAGES_PAST_INTAKE: readonly PairingStage[] = ["review", "connecting", "compare", "done"];

describe("the intake owns the live session (finding 1)", () => {
  test("a Scan tap opens it; it is live only at the intake", () => {
    const session = run([{ type: "tap" }, { type: "open" }]);
    expect(scannerLive(session, "intake")).toBe(true);
    // The screen's own gate: the same session at any later stage is not live.
    for (const stage of STAGES_PAST_INTAKE) {
      expect({ stage, live: scannerLive(session, stage) }).toEqual({ stage, live: false });
    }
  });

  test("moving PAST the intake ends the session (a paste after a Scan tap) — the finding's scenario", () => {
    const session = run([{ type: "tap" }, { type: "open" }, { type: "stage", stage: "review" }]);
    // Mutation: ignore the stage event → every assertion below goes red (the
    // session stays `requested`, which is the bug: a live camera over the review).
    expect(session.requested).toBe(false);
    expect(scannerLive(session, "review")).toBe(false);
  });

  test("a return to the intake does NOT revive it (a failure's 'Try again' is not a camera)", () => {
    // `failed` → `intake` is the retry path; the person walked away from the
    // camera, and re-mounting it there would surprise them on their own tap's
    // behalf. They can tap Scan again.
    const session = run([
      { type: "tap" },
      { type: "open" },
      { type: "stage", stage: "connecting" },
      { type: "stage", stage: "intake" },
    ]);
    expect(session.requested).toBe(false);
    expect(scannerLive(session, "intake")).toBe(false);
  });

  test("the person can CLOSE it (the control finding 1 found missing)", () => {
    const open = run([{ type: "tap" }, { type: "open" }]);
    expect(scanReduce(open, { type: "close" }).requested).toBe(false);
  });

  test("a decode ends it, and the intake keeps the text (the scan is a paste)", () => {
    const session = run([{ type: "tap" }, { type: "open" }, { type: "scanned" }]);
    expect(session.requested).toBe(false);
  });
});

describe("the request is the only thing a stage can end (the card and the tap stay)", () => {
  test("a mount error ends it and is STICKY: neither Scan nor Close revives a preview that failed", () => {
    const session = run([{ type: "tap" }, { type: "open" }, { type: "mount-error" }]);
    expect(session).toEqual({ requested: false, tapped: true, mountFailed: true });
    // Mutation: let `open` clear `mountFailed` → the `unavailable` card would be
    // a button that mounts a preview the device already refused.
    const afterOpen = scanReduce(session, { type: "open" });
    expect(afterOpen.requested).toBe(false);
    expect(afterOpen.mountFailed).toBe(true);
  });

  test("a stage event does not un-mount a failed preview, and cannot invent a tap", () => {
    const session = run([
      { type: "stage", stage: "review" },
      { type: "stage", stage: "intake" },
    ]);
    expect(session).toEqual(INITIAL_SCAN_SESSION);
  });

  test("`open` without a tap is not a tap (the hook asks the OS first, this only records)", () => {
    expect(run([{ type: "open" }]).tapped).toBe(false);
  });

  test("events are idempotent: a closed session stays closed, a decoded one is not reopened", () => {
    const closed = run([{ type: "tap" }, { type: "open" }, { type: "close" }]);
    expect(scanReduce(closed, { type: "close" })).toBe(closed);
    const scanned = run([{ type: "tap" }, { type: "open" }, { type: "scanned" }]);
    expect(scanReduce(scanned, { type: "scanned" })).toBe(scanned);
  });
});

describe("a paste submit ends it even when the stage cannot change (finding 1)", () => {
  test("`submit` ends a live session — the parse-failure path stays at `intake`", () => {
    // The reducer keeps a failed parse AT the intake (`reduce` returns
    // `{name:"intake", failure}`, not a `failed` stage), so the stage rule above
    // never fires and the camera would run on over the person's failure card.
    const session = run([{ type: "tap" }, { type: "open" }, { type: "submit" }]);
    expect(session.requested).toBe(false);
    expect(scannerLive(session, "intake")).toBe(false);
  });

  test("a submit with nothing open changes nothing (it is not a state reset)", () => {
    const session = run([{ type: "tap" }]);
    expect(scanReduce(session, { type: "submit" })).toBe(session);
  });
});
