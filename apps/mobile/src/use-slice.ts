/**
 * `useSlice` (docs/feat/mobile-ui-fluidity-s3.md): the ONLY way a component
 * reads session state. It re-renders its caller only when THAT slice of the
 * session's store changed. Wiring only — the rules are `session-store.ts`'s.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { SessionSlices, SessionStore, SliceKey } from "./session-store.ts";

export function useSlice<K extends SliceKey>(store: SessionStore, key: K): SessionSlices[K] {
  const subscribe = useCallback((fn: () => void) => store.subscribe(key, fn), [store, key]);
  const snapshot = (): SessionSlices[K] => store.get(key);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
