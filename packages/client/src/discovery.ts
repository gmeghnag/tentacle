/**
 * Sibling discovery, client side (docs/feat/sibling-discovery.md): the PURE
 * retention policy a paired client (the app, task 11) applies to what a daemon
 * announces, and the `rev` guard.
 *
 * Pure and React-free (AGENTS §7): every decision the phone makes about an
 * address is here, so it is testable without a channel, a timer or a screen.
 * The rules are the owner's (Q6): an announced address comes FIRST in announced
 * order, a previously known one (pairing-time or learned) is kept as a FALLBACK
 * for 30 days after it was last seen, and an announcement never erases one.
 */
import {
  type DaemonDiscovery,
  type DiscoveredDaemon,
  MAX_DISCOVERED_DAEMONS,
  MAX_PAIRING_ADDRESSES,
  isPairingAddress,
} from "@tentacle/protocol";

/** How long a known address nobody announces any more is still tried (owner Q6). */
export const DISCOVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** A project this client knows of, whether or not its daemon is live now. */
export interface KnownProject {
  /** The project's key on this client (the daemon's `cwd`). */
  readonly cwd: string;
  /** Every address worth trying, in order: announced first, then fallbacks. */
  readonly addresses: readonly string[];
  /** When an announcement last confirmed this project (`Date.now()`). */
  readonly lastSeenAt: number;
  /** The daemon's process stamp, as last announced (`0` = never seen live). */
  readonly startedAt: number;
}

/** What `mergeAddresses` produces: the projects to show, and the announcement it came from. */
export interface MergedDiscovery {
  readonly projects: readonly MergedProject[];
  /** The snapshot this merge applied (`undefined` = nothing announced yet). */
  readonly snapshot: DaemonDiscovery | undefined;
}

/** One project, with the app's display facts (task 11 greys out a `live: false` one). */
export interface MergedProject extends KnownProject {
  /** A daemon for this project is in the CURRENT announcement (decision 7). */
  readonly live: boolean;
  /** The daemon said it is the one that answered (`self`). */
  readonly self: boolean;
  /** The daemon's process stamp: a change means it RESTARTED (its `rev` restarted too). */
  readonly startedAt: number;
}

/** The client's discovery state: the last good snapshot plus when it arrived. */
export interface DiscoveryState {
  readonly snapshot: DaemonDiscovery | undefined;
  /** When `snapshot` was accepted (`Date.now()`), for the app's staleness display. */
  readonly at: number;
  /** Did THIS fold accept the frame? `false` = a stale or duplicate one (the caller stays silent). */
  readonly changed: boolean;
}

/** This client's own project, from the announcement (`self: true`), if any. */
function selfStamp(discovery: DaemonDiscovery | undefined): number | undefined {
  return discovery?.daemons.find((d) => d.self === true)?.startedAt;
}

/**
 * Apply a `DaemonDiscovery` (a response or a notification) to the client's
 * state, dropping one that is stale:
 *
 * - a lower-or-equal `rev` is dropped, because a notification may overtake the
 *   response that subscribed it (F12);
 * - a NEW `self.startedAt` resets the guard: `rev` is per daemon PROCESS, so a
 *   restarted daemon legitimately goes back to 1 (F7).
 */
export function foldDiscovery(
  state: DiscoveryState | undefined,
  incoming: DaemonDiscovery,
  now: number,
): DiscoveryState {
  const previous = state?.snapshot;
  const restarted =
    previous !== undefined &&
    selfStamp(previous) !== undefined &&
    selfStamp(incoming) !== undefined &&
    selfStamp(previous) !== selfStamp(incoming);
  if (previous !== undefined && !restarted) {
    if (incoming.rev < previous.rev) {
      // Overtaken: a frame older than what we already have (F12).
      return { snapshot: previous, at: state?.at ?? now, changed: false };
    }
    if (incoming.rev === previous.rev && sameSnapshot(previous, incoming)) {
      // Same content at the same rev: keep the older stamp, so "when did it
      // last change" stays honest.
      return { snapshot: previous, at: state?.at ?? now, changed: false };
    }
  }
  return { snapshot: incoming, at: now, changed: true };
}

/** Deep equality over the canonical order (the daemon sorts; a client need not). */
function sameSnapshot(a: DaemonDiscovery, b: DaemonDiscovery): boolean {
  if (a.daemons.length !== b.daemons.length) {
    return false;
  }
  return a.daemons.every((daemon, i) => {
    const other = b.daemons[i];
    return (
      other !== undefined &&
      daemon.cwd === other.cwd &&
      daemon.startedAt === other.startedAt &&
      (daemon.self === true) === (other.self === true) &&
      daemon.addresses.length === other.addresses.length &&
      daemon.addresses.every((address, j) => address === other.addresses[j])
    );
  });
}

/**
 * Merge an announcement into what this client already knew (owner Q6):
 *
 * - a project in the announcement is `live`, its ANNOUNCED addresses first in
 *   the daemon's order, then the ones it knew that are not announced now (a
 *   pairing-time address is a fallback, not a competitor);
 * - an announcement NEVER erases a known address — an empty `addresses` is
 *   "not reachable from here right now", not "forget these" (F8: a key holder
 *   cannot make the phone drop a pairing address);
 * - a known address unannounced for longer than `DISCOVERY_RETENTION_MS` is
 *   dropped; an announcement of that project refreshes the clock;
 * - a project the announcement omits is kept with `live: false`, never deleted
 *   (the app greys it out, decision 7);
 * - caps: `MAX_PAIRING_ADDRESSES` per project (announced first, so a fallback
 *   is what gets cut), `MAX_DISCOVERED_DAEMONS` projects.
 *
 * An invalid address (not `isPairingAddress`) is dropped: a hint, always
 * re-authenticated on dial, is still never worth trying if it cannot be dialled.
 */
export function mergeAddresses(
  known: readonly KnownProject[],
  discovery: DaemonDiscovery,
  now: number,
): MergedDiscovery {
  const announced = new Map<string, DiscoveredDaemon>();
  for (const daemon of discovery.daemons) {
    if (!announced.has(daemon.cwd)) {
      announced.set(daemon.cwd, daemon);
    }
  }
  const projects: MergedProject[] = [];
  const seen = new Set<string>();
  // Announced projects first, in the daemon's canonical order, then the ones
  // only this client knows (a daemon that is down stays on the screen).
  const order: Array<{ cwd: string; from: DiscoveredDaemon | undefined }> = [
    ...[...announced.values()].map((daemon) => ({ cwd: daemon.cwd, from: daemon })),
    ...known.filter((p) => !announced.has(p.cwd)).map((p) => ({ cwd: p.cwd, from: undefined })),
  ];
  for (const { cwd, from } of order) {
    if (seen.has(cwd)) {
      continue;
    }
    seen.add(cwd);
    const prior = known.find((p) => p.cwd === cwd);
    const announcedNow = (from?.addresses ?? []).filter(isPairingAddress);
    const live = from !== undefined;
    // An announcement refreshes the clock (the project answered); a project
    // missing from it keeps its stamp, so the 30-day window starts where its
    // daemon was last SEEN, not where this merge happened to run.
    const lastSeenAt = live ? now : (prior?.lastSeenAt ?? now);
    // One clock per project is what the app stores (not one per address), so
    // the window is the project's: past it, its unannounced fallbacks go. An
    // address announced again is not a fallback at all — that is how an
    // announcement keeps an address alive (owner Q6).
    const fallbacks =
      now - lastSeenAt > DISCOVERY_RETENTION_MS
        ? []
        : (prior?.addresses ?? []).filter(
            (address) => isPairingAddress(address) && !announcedNow.includes(address),
          );
    projects.push({
      cwd,
      // Announced first in the daemon's order, then the fallbacks: a cap cut
      // therefore always drops a fallback before an announced address.
      addresses: [...announcedNow, ...fallbacks].slice(0, MAX_PAIRING_ADDRESSES),
      lastSeenAt,
      live,
      self: from?.self === true,
      startedAt: from?.startedAt ?? prior?.startedAt ?? 0,
    });
    if (projects.length >= MAX_DISCOVERED_DAEMONS) {
      break;
    }
  }
  return { projects, snapshot: discovery };
}
