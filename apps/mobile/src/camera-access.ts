/**
 * The camera's permission states as a VIEW-MODEL (docs/feat/mobile-pairing-screen.md
 * 11b.2, Design 6; AGENTS §7 "logic in pure modules"): every branch a person can
 * hit is decided here, tested without a device, a simulator or `expo-camera`
 * (which cannot be imported outside the Expo runtime, so a branch left in the
 * screen would be untestable):
 *
 *   undetermined → the Scan button ASKS on the tap (decision 10: only when needed)
 *   granted      → the tap opens the scanner
 *   denied       → the tap shows the denied CARD (nothing is ever mounted, and no
 *                  OS dialog appears): "Camera access is off — enable it in
 *                  Settings, or paste the code", an action that opens Settings
 *                  (`Linking.openSettings()`), and the paste card
 *   unavailable  → its own line, no Scan and no Settings (a camera that failed to
 *                  mount: restricted, no camera hardware)
 *
 * In EVERY state the paste card stays: scanning is an accelerator, never the path
 * (F-P15/F-P16).
 */

/**
 * What the OS says about the camera, as the app sees it:
 * - `null` — the permission hook has not answered yet (one frame at mount). It
 *   is the same view as `undetermined`, never a verdict of its own: reading it
 *   as `unavailable` would flash "no camera" on every real device, and as
 *   `granted` would mount the scanner unpermitted.
 * - `unavailable` — a camera that cannot be used: its own line, because nothing
 *   was ever switched on and an iOS Settings toggle cannot fix it.
 */
export type CameraState = "undetermined" | "granted" | "denied" | "unavailable" | null;

/** F-P16's sentence: no camera to switch on. */
export const CAMERA_UNAVAILABLE_MESSAGE = "This device has no camera — paste the code instead";

/** F-P15's sentence (decision 10: explain, then name the way that always works). */
export const CAMERA_DENIED_MESSAGE =
  "Camera access is off — enable it in Settings, or paste the code";

/**
 * What the Scan control does when tapped:
 * - `ask` — request the camera permission, then open on a grant;
 * - `open` — open the scanner now;
 * - `explain` — the OS will not prompt again: show the denied card (the card's
 *   own "Open Settings" button is the way out — a `requestCameraPermissionsAsync`
 *   in this state resolves `denied` at once, so asking would be a dead button);
 * - `none` — there is no Scan control (the card took its place).
 */
export type CameraScan = "ask" | "open" | "explain" | "none";

/** The card that replaces the Scan button, if any. */
export type CameraCard = "denied" | "unavailable" | undefined;

export interface CameraView {
  /** The Scan control's action (`none` = the control is not offered). */
  readonly scan: CameraScan;
  /** Which card to show, if any. */
  readonly card: CameraCard;
  /** The card carries an "Open Settings" action (only where Settings can help). */
  readonly settings: boolean;
  /** The card's line, or none. */
  readonly message: string | undefined;
  /** The paste card is always rendered (true in every state — a test pins it). */
  readonly paste: boolean;
}

/** The part of expo's `PermissionResponse` this decision needs (structural: no expo import). */
export interface CameraPermission {
  readonly status: "granted" | "denied" | "undetermined";
  readonly granted: boolean;
}

/**
 * The OS's answer + whether the preview FAILED TO MOUNT → the view-model's state.
 *
 * `mountFailed` is the only way an unusable camera is visible to the app:
 * `CameraView.isAvailableAsync()` is documented for web and throws
 * `UnavailabilityError` on iOS (the native module defines no such function), and
 * a session with no capture device emits no error at all. What DOES report is
 * `onMountError` ("Camera could not be started - …"), which the screen passes
 * here — the simulator is covered in Execution, since it reports neither.
 */
export function cameraStateOf(
  permission: CameraPermission | null,
  mountFailed = false,
): CameraState {
  if (mountFailed) {
    return "unavailable";
  }
  if (permission === null) {
    return null;
  }
  // `granted` is the boolean the OS answers with; `status` is its string twin.
  // Either saying granted IS a grant (they cannot disagree, and preferring one
  // field would be a second definition of the same fact).
  if (permission.granted || permission.status === "granted") {
    return "granted";
  }
  return permission.status === "undetermined" ? "undetermined" : "denied";
}

/**
 * The camera's view. `tapped` is "the person has tapped Scan at least once":
 * a denied camera is EXPLAINED only then (decision 10 — the app does not open on
 * a warning about a button nobody pressed), which is also what makes flow 12's
 * `tap scan → pair-camera-denied` a real sequence rather than a lucky frame.
 */
export function cameraViewFor(state: CameraState, tapped = false): CameraView {
  switch (state) {
    case "granted":
      return { scan: "open", card: undefined, settings: false, message: undefined, paste: true };
    case "denied":
      // No Scan control once the card is up: nothing left to ask the OS.
      return tapped
        ? {
            scan: "none",
            card: "denied",
            settings: true,
            message: CAMERA_DENIED_MESSAGE,
            paste: true,
          }
        : {
            scan: "explain",
            card: undefined,
            settings: false,
            message: undefined,
            paste: true,
          };
    case "unavailable":
      return {
        scan: "none",
        card: "unavailable",
        settings: false,
        message: CAMERA_UNAVAILABLE_MESSAGE,
        paste: true,
      };
    // `undetermined`, and `null` (the hook has not answered): offer the control
    // and ask on the tap — the one case left, so `default` states it once.
    default:
      return { scan: "ask", card: undefined, settings: false, message: undefined, paste: true };
  }
}
