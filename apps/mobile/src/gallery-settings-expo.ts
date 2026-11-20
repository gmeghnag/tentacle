/**
 * The gallery look's Keychain adapter (docs/feat/mobile-gallery-polish.md).
 * Wiring only, like `chart-settings-expo.ts`: the rules live in
 * `gallery-settings-store.ts`.
 */
import * as SecureStore from "expo-secure-store";
import {
  createGallerySettingsHolder,
  createGallerySettingsStore,
} from "./gallery-settings-store.ts";
import { keychainKV } from "./secure-kv.ts";

/** The app's ONE gallery look (read by the gallery on open). */
export const GALLERY_SETTINGS = createGallerySettingsHolder(
  createGallerySettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
