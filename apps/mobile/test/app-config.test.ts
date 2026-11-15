/**
 * docs/feat/mobile-notifications.md slice N5: the NATIVE configuration, pinned
 * where a text diff can see it (AGENTS §9: prove the exact property the change
 * hinges on).
 *
 * The load-bearing one is **C1, the access-group ORDER**: iOS writes a Keychain
 * item with no explicit access group into the FIRST group listed in the
 * entitlement — and the app writes its per-computer records (`deviceKey`, the
 * Noise key that authenticates this phone) WITHOUT one. If the shared
 * notification group came first, every device key would land where the
 * Notification Service Extension can read it, which is exactly what task 16
 * Design 2 forbids ("the extension never holds the key that authenticates the
 * device"). So: the app's OWN group first, the shared group second.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const appJson = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as {
  expo: {
    ios: {
      bundleIdentifier: string;
      entitlements: Record<string, unknown>;
    };
    plugins: unknown[];
  };
};

const targetConfig = (() => {
  // The target config is CommonJS (the tool does not support ESM/TS there).
  const path = new URL("../targets/notification-service/expo-target.config.js", import.meta.url);
  const module_ = { exports: {} as unknown };
  new Function("module", "exports", readFileSync(path, "utf8"))(module_, module_.exports);
  const factory = module_.exports as (config: unknown) => Record<string, unknown>;
  return factory(appJson.expo);
})();

describe("the app's keychain access groups (plan C1)", () => {
  const groups = appJson.expo.ios.entitlements["keychain-access-groups"] as string[] | undefined;

  test("the app's OWN group is listed FIRST, the shared one second", () => {
    // Mutation: swap the two entries → every `deviceKey` written without an
    // explicit group lands in the extension's group, and the extension could
    // read the key that authenticates the phone.
    expect(groups).toBeDefined();
    expect(groups?.[0]).toBe("$(AppIdentifierPrefix)so.tentacle.app");
    expect(groups?.length).toBeGreaterThanOrEqual(1);
    // The group `push-key.ts` / `push-directory.ts` actually pass to the
    // Keychain must be one of the listed ones (a mismatch = an item nobody finds).
    const shared = groups?.slice(1) ?? [];
    const expected = shared.length > 0 ? shared : ["$(AppIdentifierPrefix)so.tentacle.app"];
    expect(expected.some((group) => group.endsWith("so.tentacle.app"))).toBe(true);
  });

  test("Time Sensitive is requested (decision 8: an ask is time-sensitive)", () => {
    expect(
      appJson.expo.ios.entitlements["com.apple.developer.usernotifications.time-sensitive"],
    ).toBe(true);
  });
});

describe("the Notification Service Extension target (N5)", () => {
  test("it is a notification-service target, embedded as .NotificationService", () => {
    expect(targetConfig.type).toBe("notification-service");
    // `.NotificationService` = `so.tentacle.app.NotificationService`: the App ID
    // the owner registers in D3a.
    expect(targetConfig.bundleIdentifier).toBe(".NotificationService");
    // CryptoKit HPKE needs iOS 17+; the app's own target is 18.0 and the
    // extension must not be older than the API it calls.
    expect(Number(targetConfig.deploymentTarget)).toBeGreaterThanOrEqual(17);
  });

  test("the extension is entitled to the SAME group, and only that one", () => {
    const entitlements = targetConfig.entitlements as Record<string, unknown>;
    const extensionGroups = entitlements["keychain-access-groups"] as string[];
    expect(extensionGroups).toEqual([`$(AppIdentifierPrefix)${appJson.expo.ios.bundleIdentifier}`]);
    // The extension has no per-computer item and no group of its own: it reads
    // the two shared notification items and nothing else.
    expect(Object.keys(entitlements)).toEqual(["keychain-access-groups"]);
  });

  test("the apple-targets plugin is registered in app.json", () => {
    // Without the plugin entry the target folder is inert: `expo prebuild` would
    // generate an app with no extension, and every push shows the relay's text.
    const plugins = JSON.stringify(appJson.expo.plugins);
    expect(plugins).toContain("@bacons/apple-targets");
  });
});
