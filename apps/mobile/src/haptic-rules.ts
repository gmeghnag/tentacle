/**
 * WHEN the app plays a haptic (Owner decision 4, docs/feat/mobile-ui-polish.md
 * Slice 6). Pure and React-free (AGENTS §7); `haptics.ts` plays the kind, the
 * screen only reports what happened.
 */
import { type ComposerAction, returnKeyAction } from "./composer.ts";

export type HapticKind = "light" | "firm" | "success";

/**
 * The composer's press: light when words leave (send / queue / send later),
 * firm for Stop, nothing for a no-op. Return goes through `returnKeyAction`,
 * the SAME gate the controller uses, so it never "feels" like a Stop (B2).
 */
export function pressHaptic(action: ComposerAction, via: "button" | "return"): HapticKind | null {
  const acted = via === "return" ? returnKeyAction(action) : action;
  if (acted === null) {
    return null;
  }
  switch (acted.kind) {
    case "send":
    case "queue":
    case "send-later":
      return "light";
    case "stop":
      return "firm";
    case "none":
      return null;
  }
}

/** A turn that was running and is not any more: success (own or another device's). */
export function turnEndHaptic(wasRunning: boolean, running: boolean): HapticKind | null {
  return wasRunning && !running ? "success" : null;
}
