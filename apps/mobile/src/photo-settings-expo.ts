/**
 * The photo settings' Keychain adapter (fix/mobile-media-live item 5). Wiring
 * only, like `voice-settings-expo.ts`: the rules live in
 * `photo-settings-store.ts`. Read only while a person looks at the app, so the
 * stricter `WHEN_UNLOCKED_THIS_DEVICE_ONLY` class costs nothing.
 */
import * as SecureStore from "expo-secure-store";
import { createPhotoSettingsHolder, createPhotoSettingsStore } from "./photo-settings-store.ts";
import { keychainKV } from "./secure-kv.ts";

/** The app's ONE photo-settings copy (loaded at launch by `App.tsx`). */
export const PHOTO_SETTINGS = createPhotoSettingsHolder(
  createPhotoSettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
