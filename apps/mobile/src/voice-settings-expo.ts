/**
 * The voice settings' Keychain adapter (docs/feat/mobile-voice.md Design §3).
 * Wiring only, like `lock-settings-expo.ts`: the rules live in
 * `voice-settings-store.ts`. Read only while a person uses the app, so the
 * stricter `WHEN_UNLOCKED_THIS_DEVICE_ONLY` class costs nothing.
 */
import * as SecureStore from "expo-secure-store";
import { keychainKV } from "./secure-kv.ts";
import { createVoiceSettingsHolder, createVoiceSettingsStore } from "./voice-settings-store.ts";

/** The app's ONE voice-settings copy (loaded at launch by `App.tsx`). */
export const VOICE_SETTINGS = createVoiceSettingsHolder(
  createVoiceSettingsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
