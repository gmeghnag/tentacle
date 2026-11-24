/**
 * Where a notification tap's route GOES while the navigator is not up yet
 * (docs/fix/mobile-push-tap-open.md Design 2; the same race `pending-link.ts`
 * solves for pairing links). A tap that LAUNCHED the app is drained before
 * `NavigationContainer` mounts, so a bare `navigate` was a silent no-op and the
 * app showed its landing screen.
 *
 * One slot: two taps before ready keep the last, and the replay is one-shot.
 */
export interface RouteQueue<R> {
  /** Send `route` now when `ready`, else park it (replacing any parked one). */
  route(route: R, ready: boolean): void;
  /** Replay the parked route, once, if `ready`. */
  flush(ready: boolean): void;
}

export function createRouteQueue<R>(go: (route: R) => void): RouteQueue<R> {
  let parked: { readonly route: R } | undefined;
  return {
    route(route, ready) {
      if (ready) {
        parked = undefined;
        go(route);
        return;
      }
      parked = { route };
    },
    flush(ready) {
      if (!ready || parked === undefined) {
        return;
      }
      const { route } = parked;
      parked = undefined;
      go(route);
    },
  };
}
