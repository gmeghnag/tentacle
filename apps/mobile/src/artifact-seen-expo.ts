/**
 * The artifact seen record's Keychain adapter (docs/feat/model-artifacts.md D9,
 * Files 9's "+ expo binding"). Wiring only, like `voice-settings-expo.ts`: the
 * rules — the versioned record, the refusal, the bound — live in
 * `artifact-seen-store.ts`. Read only while a person looks at the app, so the
 * stricter `WHEN_UNLOCKED_THIS_DEVICE_ONLY` class costs nothing.
 */
import * as SecureStore from "expo-secure-store";
import type { ArtifactSeenMap, ArtifactSeenRead } from "./artifact-seen-store.ts";
import { createArtifactSeenStore } from "./artifact-seen-store.ts";
import { keychainKV } from "./secure-kv.ts";

const STORE = createArtifactSeenStore({
  kv: keychainKV,
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});

/**
 * The app's ONE seen record, kept in memory after the first read: the gallery
 * marks and the Session info row both read it, and re-reading the Keychain on
 * every render would be a native round-trip per row.
 *
 * `load()` is idempotent; after it, `current()` is synchronous and `mark*` write
 * through (a refused or failed write rejects and leaves `current` as it was, so a
 * newer build's record is never overwritten in memory either).
 */
export interface ArtifactSeenHolder {
  load(): Promise<void>;
  /** Never rejects: a failed load reads as nothing seen. */
  current(): ArtifactSeenMap;
  writable(): boolean;
  set(next: ArtifactSeenMap): Promise<void>;
  subscribe(listener: (seen: ArtifactSeenMap) => void): () => void;
}

export function createArtifactSeenHolder(): ArtifactSeenHolder {
  let current: ArtifactSeenMap = {};
  let writable = true;
  let loaded = false;
  const listeners = new Set<(seen: ArtifactSeenMap) => void>();
  const publish = (next: ArtifactSeenMap): void => {
    current = next;
    for (const listener of listeners) {
      listener(next);
    }
  };
  return {
    async load() {
      if (loaded) {
        return;
      }
      loaded = true;
      const read: ArtifactSeenRead = await STORE.read();
      writable = read.writable;
      publish(read.seen);
    },
    current: () => current,
    writable: () => writable,
    async set(next) {
      await STORE.write(next);
      publish(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The app's ONE seen record (loaded at launch by `App.tsx`). */
export const ARTIFACT_SEEN = createArtifactSeenHolder();
