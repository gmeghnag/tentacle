/**
 * Keeping the session list's link-status subscription in step with whichever
 * client is CURRENT for a computer (docs/feat/mobile-app-shell.md).
 *
 * The registry forgets a failed dial so Retry can dial again, which means a
 * retry hands back a NEW client. A subscription made once, at mount, therefore
 * goes silent for good after the first failed dial: later drops would neither
 * mark the list stale nor refresh it on the way back (AGENTS §7 — the rule
 * lives here, in a pure injected module, not in a component).
 */
import type { LinkStatus } from "@tentacle/client";

/** What this module needs from a client: the client's own subscription. */
export interface StatusSource {
  onStatus(listener: (status: LinkStatus) => void): () => void;
}

export interface LinkStatusWatcher<T extends StatusSource> {
  /** Subscribe to `link`, replacing the previous subscription (idempotent per link). */
  watch(link: T): void;
  /** Drop the current subscription (the screen unmounted). */
  stop(): void;
}

/**
 * Follow the current link: `onUp` is told whether the link is up. A new link
 * replaces the old one — the old subscription is removed first, so two clients
 * never feed one list.
 */
export function createLinkStatusWatcher<T extends StatusSource>(
  onUp: (up: boolean) => void,
): LinkStatusWatcher<T> {
  let current: T | undefined;
  let unsubscribe: (() => void) | undefined;

  return {
    watch(link: T): void {
      if (current === link) {
        return; // the same link again: one subscription is enough
      }
      // A DIFFERENT link (Retry dialled a new client after a failed dial): the
      // old client's subscription is dead weight and would feed the list
      // nothing, so it goes first. Without this the first link wins forever
      // (review round 1 finding 4).
      unsubscribe?.();
      current = link;
      unsubscribe = link.onStatus((status) => onUp(status.state === "up"));
    },
    stop(): void {
      unsubscribe?.();
      unsubscribe = undefined;
      current = undefined;
    },
  };
}
