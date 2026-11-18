/**
 * The diagram look's Keychain adapter (docs/fix/mobile-qa-1117.md, bug 3).
 * Wiring only, like `activity-settings-expo.ts`: the rules live in
 * `diagram-settings-store.ts`.
 */
import * as SecureStore from "expo-secure-store";
import {
  createDiagramSettingsHolder,
  createDiagramSettingsStore,
} from "./diagram-settings-store.ts";
import { keychainKV } from "./secure-kv.ts";

/** The app's ONE diagram setting (loaded at launch by `App.tsx`). */
export const DIAGRAM_SETTINGS = createDiagramSettingsHolder(
  createDiagramSettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
