/**
 * The camera's permission states as a VIEW-MODEL (docs/feat/mobile-pairing-screen.md
 * 11b.2, Design 6; AGENTS §7 "logic in pure modules"): every branch a person can
 * hit is decided here, tested without a device, a simulator or `expo-camera`
 * (which cannot be imported outside the Expo runtime, so a branch left in the
 * screen would be untestable):
 *
 *   undetermined → the Scan button ASKS on the tap (decision 10: only when needed)
 *   granted      → the tap opens the scanner
 *   denied       → the denied CARD: "Camera access is off — enable it in
 *                  Settings, or paste the code", an action that opens Settings,
 *                  and the paste card
 *   unavailable  → its own line, no Scan and no Settings (a camera that failed to
 *                  mount: restricted, no camera hardware)
 *
 * In EVERY state the paste card stays: scanning is an accelerator, never the path
 * (F-P15/F-P16).
 */
import { describe, expect, test } from "bun:test";
import {
  CAMERA_DENIED_MESSAGE,
  CAMERA_UNAVAILABLE_MESSAGE,
  type CameraState,
  cameraStateOf,
  cameraViewFor,
} from "../src/camera-access.ts";

const STATES: readonly CameraState[] = ["undetermined", "granted", "denied", "unavailable", null];

describe("cameraViewFor: each permission state → its view-model", () => {
  test("undetermined: the Scan button is offered and ASKS on the tap (decision 10)", () => {
    expect(cameraViewFor("undetermined")).toEqual({
      scan: "ask",
      card: undefined,
      settings: false,
      message: undefined,
      paste: true,
    });
  });

  test("granted: the tap opens the scanner", () => {
    expect(cameraViewFor("granted")).toEqual({
      scan: "open",
      card: undefined,
      settings: false,
      message: undefined,
      paste: true,
    });
  });

  test("denied BEFORE a tap: the Scan control is there and explains (no card yet)", () => {
    // Decision 10: the app does not open on a warning about a button nobody
    // pressed. The tap is what reveals the card.
    const view = cameraViewFor("denied");
    expect(view.scan).toBe("explain");
    expect(view.card).toBeUndefined();
    expect(view.message).toBeUndefined();
  });

  test("denied AFTER a tap: the denied card + Settings + the paste way, and NO Scan (F-P15)", () => {
    const view = cameraViewFor("denied", true);
    // (mutation: keep the Scan control here → red) A `denied` permission cannot
    // be re-prompted by the OS, so a Scan that asked would be a dead button.
    expect(view.scan).toBe("none");
    expect(view.card).toBe("denied");
    expect(view.settings).toBe(true);
    expect(view.message).toBe(CAMERA_DENIED_MESSAGE);
    expect(view.message).toContain("Camera access is off");
    expect(view.message).toContain("paste the code");
  });

  test("unavailable: no Scan, no Settings, its own line (the tap is never needed)", () => {
    const view = cameraViewFor("unavailable");
    expect(view.scan).toBe("none");
    expect(view.card).toBe("unavailable");
    // An iOS Settings toggle cannot give a device a camera: offering it would
    // send the person somewhere that cannot help.
    expect(view.settings).toBe(false);
    expect(view.message).toBe(CAMERA_UNAVAILABLE_MESSAGE);
    expect(view.message).not.toContain("Camera access is off");
  });

  test("a NULL permission (the hook has not answered yet) is not a verdict", () => {
    // Reading `null` as `unavailable` would flash "no camera" on every real
    // device; reading it as `granted` would mount the scanner unpermitted. It is
    // the same view as `undetermined`: offered, and the tap asks.
    expect(cameraViewFor(null)).toEqual(cameraViewFor("undetermined"));
  });

  test("EVERY state keeps the paste card (scanning is never the only way)", () => {
    for (const state of STATES) {
      for (const tapped of [false, true]) {
        expect({ state, tapped, paste: cameraViewFor(state, tapped).paste }).toEqual({
          state,
          tapped,
          paste: true,
        });
      }
    }
  });
});

describe("cameraStateOf: the OS's answer + a failed mount → the state", () => {
  const granted = { status: "granted", granted: true } as const;
  const denied = { status: "denied", granted: false } as const;
  const undetermined = { status: "undetermined", granted: false } as const;

  test("no answer yet → null (the hook has not resolved; not a verdict)", () => {
    expect(cameraStateOf(null)).toBe(null);
  });

  test("granted / denied / undetermined map to themselves", () => {
    expect(cameraStateOf(granted)).toBe("granted");
    expect(cameraStateOf(denied)).toBe("denied");
    expect(cameraStateOf(undetermined)).toBe("undetermined");
  });

  test("a mount error means no usable camera, whatever the permission says (mutation: ignore `mountFailed` → red)", () => {
    // The permission can be `granted` and the preview still not mount (a
    // restricted device): a black frame forever is worse than saying so.
    expect(cameraStateOf(granted, true)).toBe("unavailable");
    expect(cameraStateOf(null, true)).toBe("unavailable");
  });

  test("`granted: true` with a contradictory status is still a grant (one field is not a second definition)", () => {
    expect(cameraStateOf({ status: "undetermined", granted: true })).toBe("granted");
  });
});
