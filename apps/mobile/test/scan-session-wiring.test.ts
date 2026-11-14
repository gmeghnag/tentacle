/**
 * The wiring the live scan session must keep (fix round 1 finding 1;
 * docs/feat/mobile-pairing-screen.md 11b.2 Design 6).
 *
 * The DECISION is pure and tested (`scan-session.test.ts`). What only the wiring
 * can get wrong — and what finding 1 was — is where the decision is APPLIED:
 * `PairScreen.tsx` rendered whatever `scanner` element it was handed, at any
 * stage, and offered no way to close it. Those two lines are in `.tsx` files Bun
 * cannot import (React Native's sources are Flow), so they are pinned from the
 * source, like `pairing-wiring-guards.test.ts` pins `App.tsx`'s `onDone`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const app = readFileSync(join(APP, "App.tsx"), "utf8");
const screen = readFileSync(join(APP, "src", "screens", "PairScreen.tsx"), "utf8");
const scanner = readFileSync(join(APP, "src", "scanner.tsx"), "utf8");

/** The `{scanner === undefined ? …}` block of `PairScreen.tsx`, as source text. */
function scannerBlock(): string {
  const start = screen.indexOf("{scanner === undefined");
  expect(start).toBeGreaterThan(-1);
  return screen.slice(start, screen.indexOf("\n      )}", start));
}

/** The condition `PairScreen.tsx` mounts the live scanner under (the `? null :` head). */
function scannerCondition(): string {
  const start = screen.indexOf("{scanner === undefined");
  expect(start).toBeGreaterThan(-1);
  const end = screen.indexOf("? null :", start);
  expect(end).toBeGreaterThan(start);
  return screen.slice(start, end);
}

describe("the intake owns the live scanner (finding 1: it outlived the intake)", () => {
  test("`PairScreen` mounts it ONLY at the intake (mutation: drop the stage gate → red)", () => {
    // The bug: `scanner === undefined ? null : …`, with the element handed in by
    // `App.tsx` whatever the stage — so `review`/`connecting`/`compare` rendered
    // with the camera still live (and, on a simulator, a black 280-pt box).
    expect(scannerCondition()).toContain('view.stage !== "intake"');
  });

  test("there is a Close control for it (the finding's other half: it could not be closed)", () => {
    // A `pair-scan-close` press is the person's way out; it must reach the hook.
    expect(scannerBlock()).toContain('testID="pair-scan-close"');
    expect(scannerBlock()).toContain("onScanClose");
  });

  test("the mount decision is the PURE one, and the stage is handed to it (mutation: back to a `useState` flag → red)", () => {
    // `scannerLive(session, stage)` is the one place "may this be mounted" lives;
    // a bare `useState(false)` in the seam is what let the lifetime escape the
    // intake. `App.tsx` must hand the hook the stage for that rule to see it.
    expect(scanner).toContain("scannerLive(session, stage)");
    expect(app).toContain("usePairingCamera(");
    expect(app).toMatch(/const stage = state\.name;/);
    expect(app).toContain("...(camera.scanning");
  });

  test("a paste submit stops a live preview, before it dials anything (finding 1's other shape)", () => {
    // A submit that fails to parse stays at `intake`, so the stage rule cannot
    // see it: the wiring must end the session itself.
    const start = app.indexOf("const submit = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = app.slice(start, app.indexOf("void (async () => {", start));
    expect(body).toContain("stopCamera()");
  });

  test("`scanner.tsx` keeps no lifetime of its own (it obeys `scan-session.ts`)", () => {
    // Two lifetimes would be two answers to "is the camera on": the request,
    // the tap and the mount failure all live in the pure reducer.
    expect(scanner).toContain("useReducer(scanReduce");
    expect(scanner).toContain('dispatch({ type: "stage", stage })');
    // No `useState(false)` "scanning" flag: that WAS the bug (a lifetime the
    // seam kept and nothing outside it could end).
    expect(scanner).not.toContain("setScanning");
  });
});
