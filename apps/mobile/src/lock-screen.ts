/**
 * The Lock screen's view-model (docs/feat/mobile-ui-polish.md Design 5 "Lock",
 * mockup `Lock`). Pure and React-free (AGENTS §7): `LockGate.tsx` maps this to
 * elements and decides nothing.
 *
 * Two decisions live here:
 * - the unlock button names the sensor the device actually has (an iPhone SE
 *   has Touch ID, not Face ID; a device with neither unlocks with its passcode);
 * - the footnote states the delay the person chose, so it never claims
 *   "5 minutes" when the setting says otherwise. `never` and a setting still
 *   loading get no footnote: there is no honest delay to state.
 */
import type { LockDelay } from "./app-lock.ts";

/** Which biometric sensor the device offers (`unknown` until asked). */
export type Biometry = "unknown" | "face" | "touch" | "none";

export interface LockScreenView {
  readonly title: string;
  readonly subtitle: string;
  readonly unlockLabel: string;
  /** SF Symbol drawn in the unlock button. */
  readonly unlockIcon: "faceid" | "touchid" | "lock.fill";
  /**
   * The "Use Passcode" text button. Shown only beside a biometric unlock: the
   * system prompt already falls back to the passcode in the same call
   * (`lock-auth.ts`, `disableDeviceFallback: false`), so it is the same action.
   */
  readonly showPasscode: boolean;
  readonly footnote: string | null;
}

const DELAY_PHRASE: Record<Exclude<LockDelay, "never">, string> = {
  immediately: "Locks as soon as you leave tentacle.",
  "5m": "Locks after 5 minutes in the background.",
  "1h": "Locks after 1 hour in the background.",
};

/**
 * The sensor the button may name: only an ENROLLED one (a Face ID iPhone with no
 * face enrolled goes straight to the passcode, so "Unlock with Face ID" would
 * lie). Face wins when both are reported (no iPhone has both).
 */
export function biometryFrom(input: {
  readonly enrolled: boolean;
  readonly face: boolean;
  readonly touch: boolean;
}): Biometry {
  if (!input.enrolled) {
    return "none";
  }
  return input.face ? "face" : input.touch ? "touch" : "none";
}

export function lockScreenView(setting: LockDelay | "loading", biometry: Biometry): LockScreenView {
  const unlock =
    biometry === "face"
      ? { unlockLabel: "Unlock with Face ID", unlockIcon: "faceid" as const }
      : biometry === "touch"
        ? { unlockLabel: "Unlock with Touch ID", unlockIcon: "touchid" as const }
        : { unlockLabel: "Unlock", unlockIcon: "lock.fill" as const };
  const footnote =
    setting === "loading" || setting === "never"
      ? null
      : `${DELAY_PHRASE[setting]} Change it in Settings.`;
  return {
    title: "tentacle is locked",
    subtitle: "Your sessions stay hidden, in the app switcher too.",
    ...unlock,
    showPasscode: biometry === "face" || biometry === "touch",
    footnote,
  };
}
