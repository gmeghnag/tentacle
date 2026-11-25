/**
 * The Keychain adapter (docs/feat/mobile-pairing-screen.md 11b.1, Files 9): the
 * ONE native import of the store, kept to five lines of wiring so
 * `computer-store.ts` stays pure and testable (AGENTS §7).
 *
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` is Owner Q3's decision: this-device-only
 * (no iCloud Keychain, no backup migration — mobile decision 3), and readable
 * after the first unlock so the background reconnects of tasks 16–18 work while
 * the phone is locked. No `requireAuthentication` (the Face ID app lock is
 * task 14 and must not gate these items).
 */
import * as SecureStore from "expo-secure-store";
import type { ComputerStore } from "./computer-store.ts";
import { type SecureKV, createComputerStore } from "./computer-store.ts";
import { PUSH_KEYCHAIN_SERVICE } from "./push-access-group.ts";
import { directoryStore } from "./push-directory-expo.ts";
import type { DirectoryStore } from "./push-directory.ts";
import type { PushKeyStore } from "./push-key.ts";

/** The accessibility class every write carries (Owner Q3). */
export const KEYCHAIN_ACCESSIBLE = SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;

/** `expo-secure-store` behind the store's injected surface. */
export const keychainKV: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value, options) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: options.keychainAccessible,
    }),
  delete: (key) => SecureStore.deleteItemAsync(key),
};

/**
 * The same Keychain, for the ONE item that crosses an app boundary: this phone's
 * push key (docs/feat/mobile-push.md P9, decision 8 — task 17's Notification
 * Service Extension opens every push with it, while the app is not running).
 *
 * Two differences from `keychainKV`, both load-bearing:
 *  - **the ACCESS GROUP travels on all three calls**, because `kSecAttrAccessGroup`
 *    is part of an item's KEY on iOS: a write with the group and a read without
 *    it silently find nothing;
 *  - **`accessGroup` is a REQUIRED option of the store's own surface** (`push-key.ts`),
 *    so no call site can forget it and quietly write outside the shared group.
 *
 * It stays in THIS file because it is the app's one Keychain adapter: a second
 * file importing `expo-secure-store` is a second place a security option can be
 * dropped (`pairing-guards.test.ts` pins that).
 */
export const pushKeychain: PushKeyStore = {
  get: (key, options) =>
    SecureStore.getItemAsync(key, {
      accessGroup: options.accessGroup,
      keychainService: PUSH_KEYCHAIN_SERVICE,
    }),
  set: (key, value, options) =>
    SecureStore.setItemAsync(key, value, {
      keychainAccessible: options.keychainAccessible,
      accessGroup: options.accessGroup,
      keychainService: PUSH_KEYCHAIN_SERVICE,
    }),
  delete: (key, options) =>
    SecureStore.deleteItemAsync(key, {
      accessGroup: options.accessGroup,
      keychainService: PUSH_KEYCHAIN_SERVICE,
    }),
};

/** The app's ONE computer store (the Keychain, this-device-only). */
export const KEYCHAIN_STORE: ComputerStore = createComputerStore({
  kv: keychainKV,
  keychainAccessible: KEYCHAIN_ACCESSIBLE,
});

/**
 * The push NOTIFICATION items (`tentacle.push.directory`, `tentacle.push.seen`),
 * in the same shared access group as `pushKeychain` — task 17's Notification
 * Service Extension reads them while the app is not running
 * (docs/feat/mobile-notifications.md Design 6).
 *
 * It is defined HERE, next to `pushKeychain`, for the same reason: this file is
 * the app's one Keychain adapter, so the access group and the accessibility
 * class have a single place to be right (`pairing-guards.test.ts` pins that no
 * second file imports `expo-secure-store`).
 */
export const NOTIFICATION_DIRECTORY_STORE: DirectoryStore = directoryStore(
  pushKeychain,
  KEYCHAIN_ACCESSIBLE,
);
