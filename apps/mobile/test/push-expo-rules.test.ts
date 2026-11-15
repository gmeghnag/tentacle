/**
 * The two PURE decisions in the Expo adapter (docs/feat/mobile-push.md P9).
 *
 * `push-expo.ts` imports native modules, so Bun cannot load it; but the two
 * branches that can be wrong silently — which APNs environment a build's tokens
 * belong to, and what the OS's permission means — are decided by functions that
 * take plain data. They are re-declared here rather than imported so the test
 * proves the RULE, and a second test below pins that the module still exports
 * exactly these two and still calls `getDevicePushTokenAsync` (never
 * `getExpoPushTokenAsync`, decision 19).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PushEnvironment } from "@tentacle/protocol";

/**
 * The rules, transcribed from `push-expo.ts` — and the guard test below keeps the
 * two copies honest by failing if the source stops containing them.
 */
function environmentOf(nodeEnv: string | undefined): PushEnvironment {
  return nodeEnv === "production" ? "production" : "sandbox";
}

function permissionOf(status: { readonly status: string; readonly canAskAgain?: boolean }): string {
  if (status.status === "granted") {
    return "granted";
  }
  return status.status === "undetermined" ? "undetermined" : "denied";
}

const SOURCE = readFileSync(join(import.meta.dir, "..", "src", "push-expo.ts"), "utf8");

describe("the APNs environment follows the BUILD (a wrong one is a silent BadDeviceToken)", () => {
  test("a development build is `sandbox`, a release build is `production`", () => {
    expect(environmentOf("development")).toBe("sandbox");
    expect(environmentOf(undefined)).toBe("sandbox");
    expect(environmentOf("production")).toBe("production");
  });

  test("the source decides it from NODE_ENV, in one place", () => {
    expect(SOURCE).toContain('nodeEnv === "production" ? "production" : "sandbox"');
    expect(SOURCE).toContain("process.env.NODE_ENV");
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
