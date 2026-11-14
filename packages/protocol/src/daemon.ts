/**
 * `daemon/session_ttl` — read, or change, this daemon's idle TTL: how long a
 * session nobody is attached to and that runs nothing is kept loaded
 * (docs/feat/session-ttl-control.md). Daemon-wide, not a session method.
 * Additive (an older daemon answers `MethodNotFound`).
 *
 * `idleTtlMs` absent → read only; a positive integer → the new TTL; `"never"`
 * → never (a `null` is invalid, so `v ?? null` cannot set `never` by mistake). The result is the value now in force. A change lasts until the daemon
 * restarts: it is NOT persisted, the `--session-ttl` flag is the TTL at every
 * start. Applied at once (a session already past a lowered TTL goes at the
 * next sweep). A daemon without an idle reaper (a pod, the in-process worker)
 * answers `MethodNotFound`. Any authenticated client may call it (one token =
 * one principal, per-device auth is a later task).
 */
import { z } from "zod";

/** A TTL on the wire: positive whole milliseconds, or the word `"never"` (no null: absent = read). */
// A function, not a shared constant: the JSON Schema export refuses a reused anonymous schema.
const idleTtl = () =>
  z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.literal("never")]);

export const SessionTtlParamsSchema = z.object({
  idleTtlMs: idleTtl().optional(),
});
export type SessionTtlParams = z.infer<typeof SessionTtlParamsSchema>;

export const SessionTtlResultSchema = z.object({
  /** The TTL in force now (ms), or `"never"`. */
  idleTtlMs: idleTtl(),
  /**
   * Always false: a change lasts until restart (the flag wins). Lets a UI say
   * so. Widening it to a boolean is NOT additive (an older client rejects
   * `true`): persisting a runtime change needs a `PROTOCOL_VERSION` bump.
   */
  persisted: z.literal(false),
});
export type SessionTtlResult = z.infer<typeof SessionTtlResultSchema>;

// ---------------------------------------------------------------------------
// `daemon/discover` + `daemon/discovery`
// ---------------------------------------------------------------------------

/**
 * Which other `serve` daemons run on this computer, and the addresses each is
 * reachable on (docs/feat/sibling-discovery.md, mobile task 10, owner decisions
 * 7 and 3).
 *
 * Daemon-scoped, never session-scoped: the phone's computer screen has no
 * session open (owner Q1), and a `session/update` kind would need one plus a
 * per-session `seq`/ring. The request returns a snapshot AND subscribes that
 * connection; the notification carries only CHANGES and is never sent to a
 * connection that did not ask (an unknown notification reaches an older
 * client's `onError`, so an unsolicited one is not additive).
 *
 * Additive on the wire, no `PROTOCOL_VERSION` bump: a new method (an older
 * daemon answers `MethodNotFound` = "no discovery") and a notification an older
 * client never asks for. Schemas are STRIP objects (AGENTS §7 v10 rules), so a
 * later optional field does not break this build.
 */
import { MAX_PAIRING_ADDRESSES } from "./pairing.ts";
import { line } from "./text-line.ts";

/** More than a laptop has live projects; a bound keeps one frame small and the app's list readable. */
export const MAX_DISCOVERED_DAEMONS = 32;

/**
 * One address on the wire: the same shape `isPairingAddress` accepts (a `ws(s)`
 * URL ending in the device route's `/e2e`), as a plain regex — the JSON-Schema
 * export does not map a `.refine()` (a plain regex is the repo's precedent,
 * `attachment.ts`). Producing code normalises first (`pairAddresses`, the
 * `--address` flag), so the scheme is always lowercase here; the agreement test
 * pins this against `isPairingAddress` on a fixed sample set.
 */
const ADDRESS_RE = /^wss?:\/\/[^\s?#]+\/e2e(\?[^\s#]*)?(#\S*)?$/;

/** `daemon/discover` params: nothing to say (a computer-wide read). */
export const DaemonDiscoverParamsSchema = z.object({});
export type DaemonDiscoverParams = z.infer<typeof DaemonDiscoverParamsSchema>;

/**
 * One live `serve` of this computer, as a paired client sees it.
 *
 * `cwd` is the project's key on the phone (one daemon per project, AGENTS §7),
 * a `line` like every peer-supplied display string: bounded, no control
 * characters, so it renders as plain text. `addresses` may be EMPTY: a sibling
 * bound to loopback is still listed, and the app says it is not reachable from
 * the phone rather than hiding it (owner Q4). `startedAt` lets the app tell a
 * restart from an address change. `self` marks the daemon that answered.
 */
export const DiscoveredDaemonSchema = z.object({
  cwd: line(4096),
  addresses: z.array(z.string().min(1).max(512).regex(ADDRESS_RE)).max(MAX_PAIRING_ADDRESSES),
  startedAt: z.number().int().nonnegative(),
  self: z.literal(true).optional(),
});
export type DiscoveredDaemon = z.infer<typeof DiscoveredDaemonSchema>;

/**
 * A snapshot of the computer's siblings. `rev` is monotonic per daemon process
 * and +1 on every change, so a client drops a frame that arrives after a newer
 * one (a notification may overtake the response that subscribed it). Order is
 * canonical (self first, then oldest `startedAt`) — the daemon sorts, so a
 * client can compare snapshots for equality without re-sorting.
 */
export const DaemonDiscoverySchema = z.object({
  rev: z.number().int().nonnegative(),
  daemons: z.array(DiscoveredDaemonSchema).max(MAX_DISCOVERED_DAEMONS),
});
export type DaemonDiscovery = z.infer<typeof DaemonDiscoverySchema>;
