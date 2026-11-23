/**
 * The PURE decisions in the Expo adapter (docs/feat/mobile-push.md P9).
 *
 * `push-expo.ts` imports native modules, so Bun cannot load it; but the branch
 * that can be wrong silently — what the OS's permission means — is decided by a
 * function that takes plain data. It is re-declared here rather than imported so
 * the test proves the RULE, and the guard tests below pin that the module still
 * calls `getDevicePushTokenAsync` (never `getExpoPushTokenAsync`, decision 19)
 * and no longer derives the APNs environment from `NODE_ENV`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The OS permission rule, transcribed from `push-expo.ts` — and the guard test
 * below keeps the two copies honest. The APNs-environment rule moved to the pure
 * `push-env.ts` (its own table in `push-env.test.ts`).
 */
function permissionOf(status: { readonly status: string; readonly canAskAgain?: boolean }): string {
  if (status.status === "granted") {
    return "granted";
  }
  return status.status === "undetermined" ? "undetermined" : "denied";
}

const SOURCE = readFileSync(join(import.meta.dir, "..", "src", "push-expo.ts"), "utf8");

describe("the APNs environment no longer follows the bundle mode (a wrong one is a silent BadDeviceToken)", () => {
  test("the source does not read NODE_ENV at all", () => {
    // A Release archive exported `method: debugging` is a production bundle
    // signed with the SANDBOX entitlement, so the bundle mode was never the
    // token's environment (docs/fix/mobile-push-not-registered.md). The mapping
    // and its table now live in `push-env.test.ts`.
    expect(SOURCE).not.toContain("process.env.NODE_ENV");
  });
});

describe("the OS permission maps to this app's vocabulary", () => {
  test("granted / undetermined are themselves; anything else is `denied`", () => {
    expect(permissionOf({ status: "granted" })).toBe("granted");
    expect(permissionOf({ status: "undetermined" })).toBe("undetermined");
    expect(permissionOf({ status: "denied", canAskAgain: true })).toBe("denied");
    // iOS shows its prompt once: `canAskAgain: false` is NOT a retryable state,
    // and keeping it out of the vocabulary is what stops a caller retrying.
    expect(permissionOf({ status: "denied", canAskAgain: false })).toBe("denied");
  });

  test("the source has the same three-way mapping", () => {
    expect(SOURCE).toContain('status.status === "granted"');
    expect(SOURCE).toContain('status.status === "undetermined" ? "undetermined" : "denied"');
  });
});

describe("decision 19: the RAW APNs token, never Expo's push service", () => {
  test("the adapter calls getDevicePushTokenAsync and never getExpoPushTokenAsync", () => {
    // The CALL, not the word: the module's own comment names the forbidden one to
    // explain why it is avoided, which is a quotation and not a use.
    expect(SOURCE).toContain("Notifications.getDevicePushTokenAsync(");
    expect(SOURCE).not.toContain("Notifications.getExpoPushTokenAsync(");
    // Nor may it enable Expo's own server registration (that machinery ships a
    // token listener which only acts when enabled — and it never is).
    expect(SOURCE).not.toContain("setAutoServerRegistrationEnabledAsync(");
  });

  test("the token is lowercased and checked against the wire's shape before it is sent", () => {
    expect(SOURCE).toContain("toLowerCase()");
    expect(SOURCE).toContain("/^[0-9a-f]{64,200}$/");
  });
});
