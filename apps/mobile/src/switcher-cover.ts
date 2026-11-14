/**
 * The app-switcher cover's ONE native import (docs/feat/mobile-lock.md D4): kept
 * to wiring, so the rule lives in the pure `switcher-cover-rule.ts` and is tested
 * without a simulator (AGENTS §7).
 *
 * Step 0 decided this: the stock `expo-screen-capture`
 * `enableAppSwitcherProtectionAsync` EXISTS in the installed 58.0.6 build, so
 * D4(a) ships and the local native module D4(b) is not needed.
 */
import * as ScreenCapture from "expo-screen-capture";
import type { LockDelay } from "./app-lock.ts";
import { COVER_INTENSITY, coverForSetting } from "./switcher-cover-rule.ts";

export interface SwitcherCover {
  /** Apply the cover for this setting (idempotent; never throws). */
  apply(setting: LockDelay | "loading"): Promise<void>;
}

/**
 * The app's ONE cover. A failure is swallowed on purpose: the cover is
 * defence-in-depth and the LOCK is the gate — but the failure goes to the
 * caller's sink so it is not silent.
 *
 * A failed ENABLE leaves the state "not enabled", so the next apply retries; a
 * failed DISABLE leaves it "enabled", which fails CLOSED (a leftover blur hides
 * nothing that was readable).
 */
export function createSwitcherCover(onError?: (error: unknown) => void): SwitcherCover {
  let enabled = false;
  return {
    async apply(setting): Promise<void> {
      const want = coverForSetting(setting);
      if (want === enabled) {
        return;
      }
      try {
        if (want) {
          await ScreenCapture.enableAppSwitcherProtectionAsync(COVER_INTENSITY);
        } else {
          await ScreenCapture.disableAppSwitcherProtectionAsync();
        }
        enabled = want;
      } catch (error) {
        onError?.(error);
      }
    },
  };
}
