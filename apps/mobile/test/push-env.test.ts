/**
 * The APNs environment of this build (docs/fix/mobile-push-not-registered.md,
 * root cause 1): the token's environment is the RUNNING BINARY's signed
 * `aps-environment`, never the JS bundle mode.
 *
 * The bug this pins, and why it is silent: a Release archive exported
 * `method: debugging` is a RELEASE bundle (`--dev false`, so Metro inlines
 * `NODE_ENV === "production"`) signed with the SANDBOX entitlement. Deriving the
 * env from the bundle declared `production` for a sandbox token, APNs answered
 * `400 BadDeviceToken`, the relay mapped it to `gone`, and the daemon deleted
 * the registration on the very first unattended push. Nothing in JS reported it:
 * the row said "on", and the phone's own fingerprint suppressed every retry.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pushEnvironmentOfAps } from "../src/push-env.ts";

const APP = join(import.meta.dir, "..");
const expo = readFileSync(join(APP, "src", "push-expo.ts"), "utf8");

describe("pushEnvironmentOfAps: the signature decides, not the bundle", () => {
  test("a development-signed build is `sandbox`, a production-signed one `production`", () => {
    expect(pushEnvironmentOfAps("development")).toBe("sandbox");
    expect(pushEnvironmentOfAps("production")).toBe("production");
  });

  test("no embedded profile is a STORE build (`production`), never a guess at sandbox", () => {
    // `null` is what `getIosPushNotificationServiceEnvironmentAsync` answers for
    // an App Store/TestFlight install: the profile is not in the bundle because
    // Apple re-signs it. Those tokens ARE production ones.
    expect(pushEnvironmentOfAps(null)).toBe("production");
  });
});

describe("the adapter no longer derives the environment from the bundle mode (mutation: restore `process.env.NODE_ENV` → red)", () => {
  test("push-expo.ts does not read NODE_ENV at all", () => {
    expect(expo).not.toContain("process.env.NODE_ENV");
  });

  test("it reads the SIGNATURE, through expo-application's own getter", () => {
    expect(expo).toContain("expo-application");
    expect(expo).toContain("getIosPushNotificationServiceEnvironmentAsync(");
    // A read that fails sends NOTHING: a guessed environment is the bug itself.
    expect(expo).toContain("pushEnvironmentOfAps(");
  });
});
