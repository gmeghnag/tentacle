/**
 * Should the app-switcher privacy cover be on? (docs/feat/mobile-lock.md D4,
 * Owner Q2.) Pure and React-free, in its own module for one reason: the RULE is
 * unit-tested under `bun test` with no simulator, while the native call that
 * applies it (`switcher-cover-expo.ts`) imports `expo-screen-capture` and cannot
 * be (AGENTS §7 — logic in a pure module, the adapter next to it).
 *
 * The cover is the NATIVE blur Step 0 proved is available in
 * `expo-screen-capture@58.0.6` (`enableAppSwitcherProtectionAsync`), not a JS
 * overlay: an overlay rendered on `inactive` races the snapshot and loses
 * (load-bearing fact 2).
 */
import type { LockDelay } from "./app-lock.ts";

/** The blur's intensity: max, so the snapshot is as unreadable as the API allows. */
export const COVER_INTENSITY = 1;

/**
 * On for every setting but `never` (Owner Q2): the snapshot is taken the moment
 * the app resigns active, long before a 5-minute timer would have locked
 * anything, so "only while locked" would show content for the whole window.
 *
 * `loading` (the first second of a launch) is ON: a wrong guess here leaks the
 * snapshot, so the default is to cover.
 */
export function coverForSetting(setting: LockDelay | "loading"): boolean {
  return setting !== "never";
}
