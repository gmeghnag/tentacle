/**
 * Face ID / passcode, behind `app-lock.ts`'s result kinds (docs/feat/mobile-lock.md
 * D2). The ONE native import for authentication, kept thin on purpose (AGENTS §7):
 * every decision lives in the pure module, and this file only maps strings.
 *
 * `disableDeviceFallback: false` is decision 14's fallback, and it is the whole
 * implementation of it: iOS's `deviceOwnerAuthentication` policy asks Face ID
 * first and then the device passcode, so F1 (no enrolment / sensor covered) and
 * F3 (lockout) both converge on the passcode with NO app code. `lock-auth.ts`
 * never sees the difference — it sees success or a failure kind.
 */
import * as LocalAuthentication from "expo-local-authentication";
import type { AuthResult, Capability } from "./app-lock.ts";

/** The prompt's own copy (decision 14's wording; it is the system sheet's title). */
export const UNLOCK_PROMPT = "Unlock tentacle";

/**
 * `getEnrolledLevelAsync()` → the lock's capability. `SECURITY_LEVEL_NONE` is the
 * only value that means "this device cannot authenticate a person" (F2: no
 * passcode AND no biometrics). Anything else — a passcode, a passcode plus a
 * face — can open a lock.
 */
export async function capability(): Promise<Capability> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    return level === LocalAuthentication.SecurityLevel.NONE ? "none" : "ok";
  } catch {
    // A device that cannot answer is treated as able to lock: fail-closed (the
    // person can always tap Unlock, and the passcode sheet is the OS's).
    return "ok";
  }
}

/**
 * Map `authenticateAsync`'s `error` string onto the lock's kind. iOS returns
 * `"user_cancel"`, `"authentication_failed"`, `"lockout"`, `"not_interactive"`,
 * `"system_cancel"`, `"app_cancel"`, `"passcode_not_set"`, `"not_enrolled"`,
 * `"no_space"`, `"timeout"`, `"unknown"`. Everything unrecognised is `fail`,
 * which keeps the lock up (never `success`).
 */
export function mapError(error: string | undefined): AuthResult {
  switch (error) {
    case undefined:
      return "fail";
    case "user_cancel":
    case "system_cancel":
    case "app_cancel":
      return "cancel";
    case "lockout":
      return "lockout";
    case "not_interactive":
      return "not_interactive";
    default:
      return "fail";
  }
}

/** One evaluation: the lock's own prompt copy, with the passcode fallback. */
export async function authenticate(): Promise<AuthResult> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: UNLOCK_PROMPT,
      // Decision 14's fallback: Face ID, then the device passcode. Never `true`:
      // a device with no face enrolled would then be unlockable only by Face ID.
      disableDeviceFallback: false,
    });
    return result.success ? "success" : mapError(result.error);
  } catch {
    // A throw (a missing usage string, a broken module) is NOT a success.
    return "fail";
  }
}
