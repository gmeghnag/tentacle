/**
 * The TUI's ONE auto-accept feed when the session's switch is SHARED
 * (docs/feat/session-auto-accept.md D5). A *routing* feed: it holds the
 * laptop's last known value and re-binds it to whichever session the TUI is on.
 *
 * - The session SHARES it (`AutoAcceptLink.shared()`, i.e. a trusted daemon —
 *   the worker, `connect` — that said so): the feed IS that session's link, so
 *   a flip from another device arrives here and a flip here reaches every
 *   device. A created session was already seeded daemon-side through
 *   `OpenParams.autoAccept`, so an attach adopts the daemon's value.
 * - It does NOT (a pod `run`/`attach`, an older daemon): the feed is this
 *   laptop's memory, carrying the value over to the next session — exactly
 *   today's behaviour, and what a detached run keeps in its laptop file.
 *
 * Pure and React-free (AGENTS §7): `permission-ui.ts` reads it as an
 * `AutoAcceptFeed`, `main.ts` calls `use` wherever a session is created or
 * switched, and every rule below is tested without Ink or a socket.
 */
import type { AutoAcceptLink, AutoAcceptSource } from "@tentacle/client";
import type { AutoAcceptFeed } from "@tentacle/tui";

export interface RoutingAutoAccept extends AutoAcceptFeed {
  /**
   * The TUI is on `session` now (`/clear`, `/sessions`, a new session, a hop's
   * new runtime). Adopts the session's shared value when it shares it, else
   * keeps this laptop's — carried over, so switching sessions never silently
   * changes what the person set.
   */
  use(session: AutoAcceptLink | undefined): void;
  /** The session the feed is bound to, if any (for a notice's wording). */
  bound(): boolean;
  /** Who made the last change the daemon reported (display only, untrusted text). */
  lastBy(): string | undefined;
  /**
   * Was the last reported change this laptop's OWN (its Shift+Tab, its own
   * echo)? A flip from another DEVICE is the only one worth a transcript notice
   * (docs/feat/session-auto-accept.md D5) — the person who pressed the key
   * already saw the status bar change. A session's SNAPSHOT is never news
   * either: an attach adopts a value, nobody pressed anything.
   */
  remote(): boolean;
}

/**
 * A controller's shared auto-accept link, when it has one. The TUI's
 * `SessionController` is a NARROW view (a hop facade's member, an in-process
 * agent), so the link is read structurally: an RPC runtime's controller
 * carries it (`RemoteSession.autoAccept`), and every other one has no session
 * to share — the feed then keeps this laptop's value, as before the feature.
 */
export function autoAcceptOf(controller: unknown): AutoAcceptLink | undefined {
  const link = (controller as { readonly autoAccept?: AutoAcceptLink } | null)?.autoAccept;
  return link !== undefined && typeof link.shared === "function" ? link : undefined;
}

/**
 * Tell a controller that the NEXT session it creates starts with `on`
 * (`OpenParams.autoAccept`): a `/clear` fork, a new session. A no-op for one
 * with no seam (an in-process agent, a hop facade's member): those have no
 * daemon to seed, and their session is this laptop's anyway.
 */
export function seedAutoAcceptOf(controller: unknown, on: boolean): void {
  const seed = (controller as { seedAutoAccept?: (v: boolean) => void } | null)?.seedAutoAccept;
  if (typeof seed === "function") seed.call(controller, on);
}

export function routingAutoAccept(initial = false): RoutingAutoAccept {
  let value = initial;
  /** The bound session's shared link, when it has one. */
  let link: AutoAcceptLink | undefined;
  const listeners = new Set<(on: boolean) => void>();
  let offLink: (() => void) | undefined;
  /**
   * This laptop set `value` last — its Shift+Tab, or the echo of it. Kept per
   * FEED (not per bound session), because the feed is the TUI's own identity
   * and the link is only the wire.
   */
  let ownFlip = true;
  /**
   * The value this TUI set and whose echo the daemon has not echoed back yet.
   * The link applies every update, our own echo included, and its callback says
   * nothing about who made it — so an update matching a set of OURS is that
   * echo, and anything else came from another device.
   */
  let awaitingEcho: boolean | undefined;

  const notify = (on: boolean): void => {
    const changed = value !== on;
    value = on;
    if (!changed) {
      return;
    }
    for (const listener of [...listeners]) listener(on);
  };

  const unbind = (): void => {
    offLink?.();
    offLink = undefined;
    link = undefined;
  };

  return {
    current: () => value,
    bound: () => link?.shared() ?? false,
    lastBy: () => link?.lastBy(),
    remote: () => !ownFlip,
    set(on) {
      // Locally at once: OFF must bite here without a round trip, and ON grants
      // what is on screen — the same as a local Shift+Tab (`permission-ui.ts`).
      ownFlip = true;
      awaitingEcho = on;
      notify(on);
      if (link !== undefined) {
        // A rejected send leaves this client's value as the person set it: the
        // link keeps it pending and re-sends it on a re-attach.
        void link.set(on)?.catch(() => {});
      }
    },
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    use(session) {
      unbind();
      if (session === undefined) {
        return;
      }
      // Bound ALWAYS, and that is safe: the link itself fails closed (`shared()`
      // is the trust bit AND the daemon's confirmation), so `set` on a pod's or
      // an older daemon's link sends nothing. Subscribing here — rather than only
      // once `shared()` is true — is what lets a session's snapshot SEED the feed:
      // a session attaches unconfirmed and confirms when its open answers.
      link = session;
      // Adopt the session's value only when it SHARES it. A pod session (or an
      // older daemon) must not overwrite this laptop's memory with its own zero:
      // the person's switch is carried over, exactly as `run --auto-accept` is
      // (AGENTS §7 — nothing a pod reports decides a laptop's auto-accept).
      if (session.shared()) {
        ownFlip = true;
        notify(session.current());
      }
      offLink = session.onChange((on, source: AutoAcceptSource) => {
        // The link calls this for EVERY applied change, this TUI's own echo
        // included (`auto-accept-link.ts`), and once for a session's SNAPSHOT.
        // One that matches a set of ours still waiting to come back IS that
        // echo, a snapshot is the attach's own fact, and anything else is
        // another DEVICE's — only that is worth a transcript notice.
        const echo = source === "update" && awaitingEcho === on;
        if (echo) awaitingEcho = undefined;
        ownFlip = echo || source === "snapshot" || value === on;
        notify(on);
      });
    },
  };
}
