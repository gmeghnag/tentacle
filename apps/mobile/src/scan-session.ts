/**
 * The LIVE SCAN SESSION's lifetime, as a pure reducer (docs/feat/mobile-pairing-screen.md
 * 11b.2, Design 6; fix round 1 finding 1; AGENTS §7 "logic in pure modules").
 *
 * `camera-access.ts` decides what the Scan control DOES for each permission state;
 * this module decides how long the session it opens lives. That was the gap
 * finding 1 named: the request was a `useState` inside the native seam
 * (`scanner.tsx`), cleared only by a successful decode or a mount error — so a
 * person who tapped Scan and then PASTED instead kept the camera running through
 * `review`/`connecting`/`compare`, and there was no way to close it at all.
 *
 * Two rules, both here and both tested without a device:
 *   1. **The intake owns the session.** Any stage but `intake` ends it — and ends
 *      it for good, so a failure's "Try again" (back to `intake`) does NOT revive
 *      a camera the person already walked away from.
 *   2. **The person can always close it** (`close`), and a decode or a failed
 *      mount ends it too (the preview's own end).
 *
 * There is no clock and no I/O: the hook in `scanner.tsx` dispatches events and
 * obeys the answer, so no branch of this lifetime is left in a `.tsx` where no
 * test can reach it.
 */
import type { PairingView } from "./pairing-flow.ts";

/** The pairing screen's stage (`intake` is the only one a scan can feed). */
export type PairingStage = PairingView["stage"];

/** What the session remembers between events. */
export interface ScanSession {
  /** The person asked for the live scanner (and the OS allows it). */
  readonly requested: boolean;
  /** At least one Scan tap happened: a denied camera is explained only then (decision 10). */
  readonly tapped: boolean;
  /** The preview could not start (F-P16): sticky, because a retry would fail the same way. */
  readonly mountFailed: boolean;
}

export const INITIAL_SCAN_SESSION: ScanSession = {
  requested: false,
  tapped: false,
  mountFailed: false,
};

export type ScanEvent =
  /** The Scan control was pressed (before anything was asked of the OS). */
  | { readonly type: "tap" }
  /** ... and the camera may be used: granted now, or already granted. */
  | { readonly type: "open" }
  /** One QR was decoded (the intake takes over from here). */
  | { readonly type: "scanned" }
  /** The paste field was submitted: a parse failure leaves the stage at `intake`. */
  | { readonly type: "submit" }
  /** The live preview failed to start. */
  | { readonly type: "mount-error" }
  /** The Close control. */
  | { readonly type: "close" }
  /** The pairing screen moved to `stage`. */
  | { readonly type: "stage"; readonly stage: PairingStage };

export function scanReduce(session: ScanSession, event: ScanEvent): ScanSession {
  switch (event.type) {
    case "tap":
      // A tap never re-asks the OS from here (`camera-access.ts` decided that);
      // it only records that the person reached for the camera.
      return { ...session, tapped: true };
    case "open":
      // A preview that cannot mount is not mounted again: the card says so.
      return session.mountFailed ? session : { ...session, requested: true };
    // A decode, the Close control, and a paste SUBMIT end it. The submit is not
    // redundant with the stage rule below: a paste that FAILS TO PARSE leaves the
    // stage at `intake` (the failure rides on the intake's own view-model), so
    // the stage never changes and the camera would keep running over the person's
    // own "that code did not work" card — finding 1's other shape.
    case "scanned":
    case "close":
    case "submit":
      return session.requested ? { ...session, requested: false } : session;
    case "mount-error":
      return { ...session, requested: false, mountFailed: true };
    case "stage":
      // Rule 1: leaving the intake ends the session — and a return to the intake
      // does not bring it back, because the request is gone, not suspended.
      return event.stage === "intake" || !session.requested
        ? session
        : { ...session, requested: false };
  }
}

/**
 * Whether the live scanner may be mounted RIGHT NOW. The reducer already ends the
 * session when the stage moves on; this is the same rule applied to the frame in
 * hand, so the preview cannot outlive the intake even by one render.
 */
export function scannerLive(session: ScanSession, stage: PairingStage): boolean {
  return session.requested && stage === "intake";
}
