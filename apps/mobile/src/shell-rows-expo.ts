/**
 * The `Compact shell rows` Beta switch's Keychain adapter
 * (docs/feat/shell-intent-line.md §7). Wiring only, like
 * `theme-settings-expo.ts`: the rules live in `shell-rows-store.ts`.
 */
import * as SecureStore from "expo-secure-store";
import { keychainKV } from "./secure-kv.ts";
import { createShellRowsHolder, createShellRowsStore } from "./shell-rows-store.ts";

/** The app's ONE shell-rows switch (loaded at launch by `App.tsx`). */
export const SHELL_ROWS = createShellRowsHolder(
  createShellRowsStore({
    kv: keychainKV,
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  }),
);
