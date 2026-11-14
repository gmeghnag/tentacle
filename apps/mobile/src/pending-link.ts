/**
 * Where an incoming pairing link GOES, given how far the app has got
 * (docs/feat/mobile-pairing-screen.md 11b.2, F-P17; AGENTS §7 "logic in pure
 * modules").
 *
 * The bug this module exists for: `App` renders a spinner while it reads the
 * store, and `NavigationContainer` is not mounted until that finishes — so
 * `navigationRef.navigate(...)` is a silent NO-OP for a COLD start from a link
 * (`Linking.getInitialURL()` resolves before the navigator mounts, which is the
 * slow path on a fresh install). The link must therefore be PARKED here and
 * replayed once the navigator is ready. Found on the simulator: flow
 * `19-deep-link` sat on the intake while the link had arrived.
 */

/**
 * What to do with a link, given the navigator's readiness:
 * - `route` — the navigator is up: send it now;
 * - `hold` — it is not: keep the text, and route it when it becomes ready.
 */
export type LinkHandling =
  | { readonly action: "route"; readonly text: string }
  | { readonly action: "hold"; readonly text: string }
  | { readonly action: "ignore" };

/**
 * The decision, once for both of `App`'s entry points (the cold-start
 * `getInitialURL()` and a warm `url` event).
 *
 * `ready` is `navigationRef.isReady()` — never a constant, since the whole point
 * is that it is false for a moment after launch.
 */
export function handlePairingText(text: string | undefined, ready: boolean): LinkHandling {
  if (text === undefined) {
    return { action: "ignore" };
  }
  return ready ? { action: "route", text } : { action: "hold", text };
}

/**
 * The text to route when the navigator becomes ready: the parked one, if any.
 * One-shot by construction (the caller clears its state), so a re-render cannot
 * re-submit the same link and bounce the person back to the review.
 */
export function takePendingLink(pending: string | undefined, ready: boolean): string | undefined {
  return ready ? pending : undefined;
}
