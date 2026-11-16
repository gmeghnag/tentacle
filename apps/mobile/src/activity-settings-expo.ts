/**
 * The Activity button setting's Keychain adapter (docs/feat/mobile-chrome.md
 * Design 6). Wiring only, like `voice-settings-expo.ts`: the rules live in
 * `activity-settings-store.ts`.
 */
import * as SecureStore from "expo-secure-store";
import {
  createActivitySettingsHolder,
  createActivitySettingsStore,
} from "./activity-settings-store.ts";
import { keychainKV } from "./secure-kv.ts";

/** The app's ONE Activity-button setting (loaded at launch by `App.tsx`). */
export const ACTIVITY_SETTINGS = createActivitySettingsHolder(
  createActivitySettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
