/**
 * The lock setting's Keychain adapter (docs/feat/mobile-lock.md D3). Five lines
 * of wiring, like `secure-kv.ts`: the rules live in `lock-settings-store.ts`.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` and not the computer store's
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: this item is only ever read while a
 * person is looking at the app, so the stricter class costs nothing here.
 */
import * as SecureStore from "expo-secure-store";
import { createLockSettingStore, guardLockSettingStore } from "./lock-settings-store.ts";

/** The accessibility class the setting is written with. */
export const LOCK_SETTING_ACCESSIBLE = SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY;

/** The app's ONE lock-setting store. */
export const LOCK_SETTING_STORE = guardLockSettingStore(
  createLockSettingStore({
    kv: {
      get: (key) => SecureStore.getItemAsync(key),
      set: (key, value, options) =>
        SecureStore.setItemAsync(key, value, {
          keychainAccessible: options.keychainAccessible,
        }),
      delete: (key) => SecureStore.deleteItemAsync(key),
    },
    keychainAccessible: LOCK_SETTING_ACCESSIBLE,
  }),
);
