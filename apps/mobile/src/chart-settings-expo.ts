/**
 * The Charts setting's Keychain adapter (docs/feat/mobile-chart-labels.md D7).
 * Wiring only, like `activity-settings-expo.ts`: the rules live in
 * `chart-settings-store.ts`.
 */
import * as SecureStore from "expo-secure-store";
import { createChartSettingsHolder, createChartSettingsStore } from "./chart-settings-store.ts";
import { keychainKV } from "./secure-kv.ts";

/** The app's ONE Charts setting (loaded at launch by `App.tsx`). */
export const CHART_SETTINGS = createChartSettingsHolder(
  createChartSettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
