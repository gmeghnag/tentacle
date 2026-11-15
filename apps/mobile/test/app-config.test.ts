/**
 * docs/feat/mobile-notifications.md slice N5: the NATIVE configuration, pinned
 * where a text diff can see it (AGENTS §9: prove the exact property the change
 * hinges on).
 *
 * Two load-bearing properties, and both were WRONG before fix round 1:
 *
 *  1. **C1, the access-group ORDER and SEPARATION.** iOS writes a Keychain item
 *     with no explicit access group into the FIRST group listed in the
 *     entitlement — and the app writes its per-computer records (`deviceKey`,
 *     the Noise key that authenticates this phone) WITHOUT one. So the app's OWN
 *     group is listed first. But that alone is not enough: the SHARED group must
 *     be a DIFFERENT group from it, or an item with no group and an item with
 *     the shared group are the same group and the extension can read the device
 *     key (fix round 1, finding #3 — the shipped config listed one group).
 *  2. **the group string JS and Swift pass at runtime is TEAMID-prefixed.**
 *     `kSecAttrAccessGroup` must match the BUILT entitlement exactly, and the
 *     build expands `$(AppIdentifierPrefix)` (fix round 1, finding #4).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const appJson = JSON.parse(readFileSync(new URL("../app.json", import.meta.url), "utf8")) as {
  expo: {
    ios: {
      bundleIdentifier: string;
      appleTeamId?: string;
      entitlements: Record<string, unknown>;
    };
    plugins: unknown[];
  };
};

const targetConfig = (() => {
  // The target config is CommonJS (the tool does not support ESM/TS there).
  const path = new URL("../targets/notification-service/expo-target.config.js", import.meta.url);
  const module_ = { exports: {} as unknown };
  new Function("module", "exports", readFileSync(path, "utf8"))(module_, module_);
  const factory = module_.exports as (config: unknown) => Record<string, unknown>;
  return factory(appJson.expo);
})();

/** A group string without the `$(AppIdentifierPrefix)` build variable. */
const bare = (entry: string): string => entry.replace("$(AppIdentifierPrefix)", "");

/** The app's `keychain-access-groups`, as `app.json` writes them (with the build variable). */
const groups = (appJson.expo.ios.entitlements["keychain-access-groups"] as string[]) ?? [];

describe("the app's keychain access groups (plan C1)", () => {
  test("the app's OWN group is listed FIRST", () => {
    // Mutation: swap the two entries → every `deviceKey` written without an
    // explicit group lands where the extension can read it.
    expect(groups[0]).toBe("$(AppIdentifierPrefix)so.tentacle.app");
  });

  test("the shared notification group is a DIFFERENT group, listed second (finding #3)", () => {
    // Mutation: list ONE group (as the shipped config did) → the "shared" group
    // IS the app's own group, so an item written with it is readable by the
    // extension, and `deviceKey` (written without a group) lands there too.
    expect(groups.length).toBe(2);
    expect(groups[1]).toBe("$(AppIdentifierPrefix)so.tentacle.app.push");
    expect(bare(groups[1] ?? "")).not.toBe(bare(groups[0] ?? ""));
  });

  test("the extension is entitled to the SHARED group only (never the app's own)", () => {
    // Mutation: give the extension the app's group (as the shipped config did)
    // → it can read `tentacle.computer.*`, i.e. the Noise device key.
    const entitlements = targetConfig.entitlements as Record<string, unknown>;
    expect(entitlements["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)so.tentacle.app.push",
    ]);
    // …and nothing else: no per-computer item, no second capability.
    expect(Object.keys(entitlements)).toEqual(["keychain-access-groups"]);
  });

  test("Time Sensitive is requested (decision 8: an ask is time-sensitive)", () => {
    expect(
      appJson.expo.ios.entitlements["com.apple.developer.usernotifications.time-sensitive"],
    ).toBe(true);
  });
});

describe("the RUNTIME group string is TEAMID-prefixed (finding #4)", () => {
  test("`push-access-group.ts` derives it from the ONE team id, and app.json agrees", async () => {
    // Mutation: pass the bare bundle id (as the shipped code did) →
    // `kSecAttrAccessGroup` matches no entitlement, the write fails
    // (`errSecMissingEntitlement`) and every push renders the placeholder.
    const { PUSH_ACCESS_GROUP, PUSH_GROUP, TEAM_ID, accessGroupFor } = await import(
      "../src/push-access-group.ts"
    );
    expect(TEAM_ID).toMatch(/^[A-Z0-9]{10}$/);
    // ONE source of truth: the app's config names the same team.
    expect(appJson.expo.ios.appleTeamId).toBe(TEAM_ID);
    // The runtime value is the bare group with the team in front of it…
    expect(PUSH_ACCESS_GROUP).toBe(`${TEAM_ID}.${PUSH_GROUP}`);
    // …and the bare group is exactly what the entitlements name (build variable
    // stripped), so the derived string cannot drift from the signed config.
    const entitled = groups.map(bare);
    expect(entitled).toContain(PUSH_GROUP);
    expect(accessGroupFor("ABCDE12345", "x.y")).toBe("ABCDE12345.x.y");
    // The app's OWN group is reachable the same way (a device key stays there).
    const { APP_ACCESS_GROUP, APP_GROUP } = await import("../src/push-access-group.ts");
    expect(APP_ACCESS_GROUP).toBe(`${TEAM_ID}.${APP_GROUP}`);
    expect(entitled).toContain(APP_GROUP);
    expect(APP_ACCESS_GROUP).not.toBe(PUSH_ACCESS_GROUP);
  });

  test("the extension names NO access group, so its queries match its own groups (finding #4)", () => {
    // Apple: "If you don't specify an access group in the query, the search
    // matches any of your app's groups" — and this extension's groups are the
    // shared push group plus its own app ID, never the app's own group. Naming
    // the group here instead would need the TEAMID prefix at build time (a
    // second source of truth); naming it WITHOUT the prefix matches nothing.
    // Mutation: pass the bare "so.tentacle.app*" literal → errSecItemNotFound
    // for every push (and, with the write path, errSecMissingEntitlement).
    const swift = readFileSync(
      new URL("../targets/notification-service/NotificationService.swift", import.meta.url),
      "utf8",
    );
    expect(swift).not.toMatch(/accessGroup\s*=\s*"/);
    expect(swift).toMatch(/accessGroup:\s*nil/);
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

  test("the apple-targets plugin is registered in app.json", () => {
    // Without the plugin entry the target folder is inert: `expo prebuild` would
    // generate an app with no extension, and every push shows the relay's text.
    const plugins = JSON.stringify(appJson.expo.plugins);
    expect(plugins).toContain("@bacons/apple-targets");
  });
});

// --- Live Activities: the widget target and the plist keys (L10) ------------
/**
 * The native half of Live Activities, as far as a HEADLESS gate can check it
 * (docs/feat/mobile-live-activity.md Design 6, L10): the keys iOS reads, the
 * extension target's existence and bundle id, and the one invariant that must
 * survive the new group — the app's OWN keychain group stays FIRST (so a
 * group-less write of the Noise device key still never lands where an extension
 * can read it).
 *
 * The SwiftUI views and the Expo module cannot be tested here (they need a
 * simulator/device build): `bun run test:swift` runs `LACore`'s logic, and the
 * real-device checklist (D5) covers the rendering.
 */
describe("Live Activities: the app's declaration and the widget target (L10)", () => {
  test("NSSupportsLiveActivities is on, and the FrequentPushes variant is not", () => {
    // Mutation: drop the key → iOS never starts an activity, and every push is
    // silently ignored with no error anywhere (the feature is simply absent).
    const infoPlist = (appJson.expo.ios as { infoPlist?: Record<string, unknown> }).infoPlist ?? {};
    expect(infoPlist.NSSupportsLiveActivities).toBe(true);
    // `FrequentPushes` raises the system's update budget; the plan's cadence
    // (Owner Q4) fits the normal one, and claiming it without need is a review
    // flag at Apple's side, so it must stay ABSENT until L0/L12 proves it needed.
    expect(infoPlist.NSSupportsLiveActivitiesFrequentUpdates).toBeUndefined();
  });

  test("the widget extension target is declared, with its own bundle id", () => {
    const config = require("../targets/live-activity/expo-target.config.js")({
      ios: { bundleIdentifier: "so.tentacle.app" },
    }) as {
      type: string;
      bundleIdentifier: string;
      deploymentTarget: string;
      entitlements: Record<string, string[]>;
    };
    // A widget is a `widget` target (Apple's extension point), not a second
    // notification service: the type is what `@bacons/apple-targets` generates
    // the Info.plist's NSExtension from.
    expect(config.type).toBe("widget");
    expect(config.bundleIdentifier).toBe(".LiveActivity");
    // iOS 18 is the floor (the app's own): push-to-start needs 17.2, interactive
    // buttons 17, so every supported phone has them.
    expect(config.deploymentTarget).toBe("18.0");
    // The widget needs the SHARED group only: it opens a content-state and reads
    // the pinned computers, never the device's Noise key.
    expect(config.entitlements["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)so.tentacle.app.push",
    ]);
  });

  test("the app's OWN keychain group is still FIRST, with the widget added", () => {
    // The invariant of task 17's fix round 1 finding #3, re-pinned because task 18
    // adds a THIRD entry to this list: the order is what keeps a group-less
    // `tentacle.computer.*` write out of an extension's reach.
    expect(groups[0]).toBe("$(AppIdentifierPrefix)so.tentacle.app");
    expect(groups).toContain("$(AppIdentifierPrefix)so.tentacle.app.push");
    // No per-target group was invented: two groups, in that order.
    expect(groups).toHaveLength(2);
  });
});
