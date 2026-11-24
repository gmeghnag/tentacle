/**
 * docs/fix/mobile-push-tap-open.md Design 1: the app and the Notification
 * Service Extension must address the SAME Keychain service, or the extension
 * finds nothing and the banner stays the placeholder.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PUSH_KEYCHAIN_SERVICE } from "../src/push-access-group.ts";

const APP = join(import.meta.dir, "..");
const swift = readFileSync(
  join(APP, "targets", "notification-service", "NotificationService.swift"),
  "utf8",
);
const secureKv = readFileSync(join(APP, "src", "secure-kv.ts"), "utf8");

describe("push Keychain service", () => {
  test("the extension's literal is `<service>:no-auth` of the app's constant", () => {
    const m = /keychainService = "([^"]+)"/.exec(swift);
    expect(m?.[1]).toBe(`${PUSH_KEYCHAIN_SERVICE}:no-auth`);
  });
  test("pushKeychain passes the constant on get, set and delete", () => {
    const start = secureKv.indexOf("export const pushKeychain");
    const block = secureKv.slice(start, secureKv.indexOf("};", start));
    expect(block.match(/keychainService: PUSH_KEYCHAIN_SERVICE/g)?.length).toBe(3);
  });
  test("expo-secure-store composes `<service>:no-auth`", () => {
    const path = join(APP, "node_modules", "expo-secure-store", "ios", "SecureStoreModule.swift");
    if (!existsSync(path)) return;
    const src = readFileSync(path, "utf8");
    expect(src).toContain("options.keychainService ??");
    expect(src).toContain('requireAuthentication ? "auth" : "no-auth"');
  });
});
