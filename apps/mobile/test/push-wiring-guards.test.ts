/**
 * The push WIRING (docs/feat/mobile-push.md P9): the four lines only `App.tsx`
 * and the Settings screen can get wrong.
 *
 * The DECISIONS are pure and tested (`push-registration.test.ts`,
 * `push-manager.test.ts`, `push-key.test.ts`); `App.tsx` imports React Native,
 * whose sources are Flow, so Bun cannot parse it. What is left is "is it called
 * at all, in the right place" — the same shape as `pairing-wiring-guards.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dir, "..");
const app = readFileSync(join(APP, "App.tsx"), "utf8");
const settings = readFileSync(join(APP, "src", "screens", "SettingsScreen.tsx"), "utf8");
const secureKv = readFileSync(join(APP, "src", "secure-kv.ts"), "utf8");
const expo = readFileSync(join(APP, "src", "push-expo.ts"), "utf8");

describe("a computer's link coming UP is what registers for push", () => {
  test("the link-up handler syncs that computer (mutation: drop the call → red)", () => {
    const start = app.indexOf("createLinkStatusWatcher<ComputerLink>((");
    expect(start).toBeGreaterThan(-1);
    const watcher = app.slice(start, start + 900);
    expect(watcher).toContain("if (up) {");
    expect(watcher).toContain("PUSH.sync(computerId");
    // With the CLIENT of the computer whose link just came up: a link dialled for
    // one computer must never register another's.
    expect(watcher).toContain("CLIENTS.get(computerId)");
  });

  test("the watcher is rebuilt per computer, so its sync cannot outlive one", () => {
    // The dependency list is the whole reason a switch between computers cannot
    // cross their registrations: a memo with `[]` would keep the FIRST id.
    const start = app.indexOf("createLinkStatusWatcher<ComputerLink>((");
    const tail = app.slice(start, start + 1200);
    expect(tail).toContain("[computerId]");
  });
});

describe("the notification prompt comes from a successful pairing", () => {
  test("Pair's `onDone` asks through the push manager (mutation: drop it → red)", () => {
    const start = app.indexOf("onDone={(computerId, superseded) => {");
    expect(start).toBeGreaterThan(-1);
    // The `onDone` block: up to the first `}` at its indent.
    const done = app.slice(start, app.indexOf("\n              }", start));
    expect(done).toContain("PUSH.paired(computerId, true)");
    // And it is not awaited: the OS sheet is the person's, not the screen's.
    expect(done).not.toContain("await PUSH.paired");
  });
});

describe("Settings has the row, as a dumb renderer", () => {
  test("the toggle and its detail line are testIDs a flow can assert (P9's rule: RN's new arch shows no text)", () => {
    expect(settings).toContain('testID="notifications-toggle"');
    expect(settings).toContain('testID="notifications-detail"');
  });

  test("the switch is DISABLED when flipping it would be a lie", () => {
    // `notifications === undefined` (nothing paired) and `!switchable` (no iOS
    // permission, or a daemon too old): the two cases where a tap changes nothing.
    expect(settings).toContain(
      "disabled={notifications === undefined || !notifications.switchable}",
    );
  });

  test("the row carries no decision of its own: it renders the strings it is given", () => {
    // Every branch of the copy lives in `push-registration.ts`'s `pushPhaseText`:
    // the component may QUOTE a phase in prose, but may never branch on one.
    expect(settings).not.toContain("relay-no-push");
    expect(settings).not.toContain("phase ===");
    expect(settings).not.toContain("pushPhaseText");
  });

  test("App passes the phone-wide row and the toggle", () => {
    expect(app).toContain("notifications={notificationsForSettings}");
    expect(app).toContain("PUSH.viewForAll(pairedComputers, pushPermission)");
    expect(app).toContain("PUSH.setEnabledForAll(");
  });

  test("the row is withheld until the stored switch is read (H1: no frame claims `on` blind)", () => {
    // `PUSH.ready()` resolves the Keychain read every manager method awaits, and
    // the prop is `undefined` (Settings' "nothing to show") until it lands.
    expect(app).toContain("PUSH.ready()");
    expect(app).toContain("pushReady ? notificationsRow : undefined");
  });
});

describe("ONE Keychain seam for the app", () => {
  test("the push key's Keychain is the SAME adapter file (mutation: import expo-secure-store in push-expo → red)", () => {
    expect(secureKv).toContain("pushKeychain");
    expect(expo).not.toContain('from "expo-secure-store"');
    expect(expo).toContain("pushKeychain");
  });

  test("the shared access group travels on all three Keychain calls (iOS keys an item BY it)", () => {
    const surface = secureKv.slice(secureKv.indexOf("export const pushKeychain"));
    expect(surface).toMatch(/SecureStore\.getItemAsync\(key, \{\s*accessGroup/);
    expect(surface).toContain("SecureStore.setItemAsync(key, value, {");
    expect(surface).toMatch(/SecureStore\.deleteItemAsync\(key, \{\s*accessGroup/);
  });
});
