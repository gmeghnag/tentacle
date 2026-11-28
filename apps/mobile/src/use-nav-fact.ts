/**
 * `useNavFact` (docs/fix/mobile-fluidity-e2e.md, flow 44): the way a screen
 * reads a fact of the navigator that its render and effects depend on.
 *
 * `navigation.getState()` — and `useNavigationState`, which hands back
 * `selector(getState())` live — is read from OUTSIDE React. A render that sees a
 * changed value there while no hook's state changed (a same-value `setState`,
 * landing before the navigator's notify) is bailed out by React: its effects are
 * dropped, their NEW deps are kept, and they never run. That left the run's ask
 * with no sheet. `useSyncExternalStore` keeps the value in a hook, so the render
 * that first sees it is never bailed out.
 */
import { useCallback, useSyncExternalStore } from "react";

export interface NavFactSource<S> {
  getState(): S;
  addListener(type: "state", listener: () => void): () => void;
}

export interface NavFactHooks {
  useCallback: typeof useCallback;
  useSyncExternalStore: typeof useSyncExternalStore;
}

const REACT: NavFactHooks = { useCallback, useSyncExternalStore };

/** `select` returns a primitive: the snapshot is compared with `Object.is`. */
export function useNavFact<S, T extends string | boolean | null>(
  navigation: NavFactSource<S>,
  select: (state: S) => T,
  // The test's seam: no React 19 renderer here, so it injects Ink's React.
  hooks: NavFactHooks = REACT,
): T {
  const subscribe = hooks.useCallback(
    (changed: () => void) => navigation.addListener("state", changed),
    [navigation],
  );
  const snapshot = (): T => select(navigation.getState());
  return hooks.useSyncExternalStore(subscribe, snapshot, snapshot);
}
