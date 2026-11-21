/**
 * The Figtree try-out switch's Keychain adapter (docs/feat/mobile-theme-beta.md).
 * Wiring only, like `chart-settings-expo.ts`: the rules live in
 * `theme-settings-store.ts`.
 */
import * as SecureStore from "expo-secure-store";
import { keychainKV } from "./secure-kv.ts";
import { createThemeSettingsHolder, createThemeSettingsStore } from "./theme-settings-store.ts";

/** The app's ONE theme switch (loaded at launch by `App.tsx`). */
export const THEME_SETTINGS = createThemeSettingsHolder(
  createThemeSettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
