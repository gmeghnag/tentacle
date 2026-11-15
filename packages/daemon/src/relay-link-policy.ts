/**
 * The mobile relay link's POLICY, as a PURE module (no sockets, no timers, no
 * fs — AGENTS §7), so every decision the link makes about WHEN to dial, how long
 * to wait and when to give up is unit-tested with an injected clock and random
 * source (docs/feat/mobile-relay.md R4).
 *
 * What lives here, and why each piece is not in `relay-link.ts`:
 *
 * - **Backoff** (1 s → 60 s cap, FULL jitter): a fleet of daemons re-registering
 *   after a relay restart must not arrive together (F3 "no thundering herd"),
 *   and jitter is a computation, not a socket.
 * - **Holds** that are NOT backoff: `error:"version"` is 1 h (a skew is fixed by
 *   a deploy, not by retrying — and a 1 h wait is what keeps an incompatible
 *   pair from reconnecting all day; F13), and `replaced` is 5 min with a notice
 *   (a second daemon holds our id — two processes on one config dir, or a leaked
 *   secret; retrying sooner only flaps the id back and forth; F16).
 * - **The ping deadline** (25 s ping, 10 s answer): R0(c) measured that a Bun
 *   WebSocket client NEVER notices a dead-but-open TCP path (70 s, state still
 *   `open`), so liveness has to be the application's own. Without this the link
 *   would stay "up" while unregistered and every phone dial would `4404`.
 * - **The oversize backoff** (F7's fallback): R0(b) showed the allocation has
 *   already happened when a handler first sees a giant frame, and Bun exposes no
 *   client-side `maxPayloadLength` (R0(d)). What the link CAN do is refuse to be
 *   reconnected into the same allocation in a tight loop, so an oversize close is
 *   a normal (jittered) backoff step, never an immediate redial.
 */

/** The first retry: fast enough that a relay restart is barely noticed. */
export const RELAY_BACKOFF_INITIAL_MS = 1_000;
/** The cap: a steady-state reconnect every ≤ 60 s, never a storm. */
export const RELAY_BACKOFF_CAP_MS = 60_000;
/** `error:"version"`: a skew needs a deploy, so wait like one (F13). */
export const RELAY_VERSION_HOLD_MS = 60 * 60 * 1_000;
/** `replaced`: another daemon holds this id — wait, and let the human read the notice (F16). */
export const RELAY_REPLACED_HOLD_MS = 5 * 60 * 1_000;
/**
 * A phone stream's rate-limit key prefix. The relay's `open.ip` is UNTRUSTED
 * (the relay could send anything) and is used for nothing but this key, so a
 * flood costs the relay's own reputation and never becomes an identity.
 */
export const RELAY_LIMIT_KEY_PREFIX = "relay:";
/** Control-socket liveness: send `{t:"ping"}` this often (R0(c) killed "do nothing"). */
export const RELAY_PING_INTERVAL_MS = 25_000;
/** …and reconnect when no `pong` arrived within this window (F2). */
export const RELAY_PONG_DEADLINE_MS = 10_000;

/** An injected clock + randomness, so a test drives time instead of waiting for it. */
export interface RelayPolicySeeds {
  /** Milliseconds since the epoch (`Date.now` in production). */
  readonly now: () => number;
  /** `[0, 1)` like `Math.random` — the jitter source. */
  readonly random: () => number;
}

/**
 * Why the link is not connected, in the terms the caller reacts to. A `reason`
 * is not a message: the caller maps it to one audit line (Design §4's audit
 * vocabulary) and the policy maps it to a wait.
 */
export type RelayDownReason =
  | "closed"
  | "version"
  | "invalid"
  | "busy"
  | "replaced"
  | "wrong-id"
  | "oversize"
  | "timeout"
  | "unsupported-url";

/**
 * The next wait after a failure: `delayMs` from NOW, plus `notice` when the
 * reason is one a human should read once (version skew, a replaced id).
 */
export interface RelayRetry {
  /** How long to wait before dialling again (already jittered where it should be). */
  readonly delayMs: number;
  /**
   * One operator line, when the reason means something the user must act on
   * (a version skew, a copied config dir). Absent for the ordinary retries: a
   * relay restart must not spam the audit trail every 60 s.
   */
  readonly notice?: string;
}

/**
 * The wait after a `reason`.
 *
 * Backoff-shaped reasons (a dropped socket, a relay restart, an oversize close)
 * use exponential growth with FULL jitter: `uniform(0, min(cap, initial·2^n))`.
 * Full jitter (not "half fixed + half random") is deliberate — it is the variant
 * that actually spreads a fleet, because every daemon's wait is independent of
 * the nominal step. `attempt` is 0 for the first retry after a good connection.
 *
 * Non-backoff reasons are FIXED waits: a version skew at 1 h and a replaced id
 * at 5 min are decisions, not a distribution, so jittering them would only add
 * noise to a wait the human is being told about.
 */
export function relayRetryAfter(
  reason: RelayDownReason,
  attempt: number,
  seeds: RelayPolicySeeds,
): RelayRetry {
  if (reason === "version") {
    return {
      delayMs: RELAY_VERSION_HOLD_MS,
      // F13: once, not every hour — the caller dedupes by reason (see below).
      notice: `relay speaks an unsupported version — retrying in ${RELAY_VERSION_HOLD_MS / 60_000} min`,
    };
  }
  if (reason === "replaced") {
    return {
      delayMs: RELAY_REPLACED_HOLD_MS,
      // F16's cause, in the words the human needs: almost always a copied config dir.
      notice: "another daemon took over this relay id (copied config dir?) — pausing 5 min",
    };
  }
  if (reason === "unsupported-url") {
    // A bad `relay.url` never fixes itself (R5a refuses to start on one): the
    // link stays down and says nothing more, rather than re-dialling forever.
    return { delayMs: Number.POSITIVE_INFINITY };
  }
  const nominal = Math.min(RELAY_BACKOFF_CAP_MS, RELAY_BACKOFF_INITIAL_MS * 2 ** attempt);
  // Never 0: a `random()` of exactly 0 would otherwise redial in a tight loop.
  const jitter = 1 + Math.max(1, Math.floor(seeds.random() * nominal));
  return { delayMs: Math.min(nominal, jitter) };
}

/**
 * The backoff counter a wait is computed from (F7's fallback, R4 review 1).
 *
 * `oversize` deliberately keeps its OWN counter (`oversizeStrikes`) instead of
 * the shared `attempt`: the shared one is reset by an accepted `ready`, because
 * an hour of service must not earn a 60 s first retry — and a hostile relay
 * exploits exactly that by alternating `ready` (which proves the id) with one
 * oversize frame. Every cycle then looks like "a good connection that dropped",
 * the wait never grows past its first step, and Bun has already materialised the
 * frame (R0(b)/(d): no client-side cap), about once a second, forever. With its
 * own counter the oversize waits progress 1 s → 2 s → … → the 60 s cap, so the
 * worst case for a hostile relay is one allocation a minute.
 *
 * A benign relay never sends an oversize control frame, so it never consults
 * this counter and pays nothing for it.
 */
export function backoffCounterFor(
  reason: RelayDownReason,
  attempt: number,
  oversizeStrikes: number,
): number {
  return reason === "oversize" ? oversizeStrikes : attempt;
}

/**
 * The `attempt` counter after a retry: grows on every ordinary failure, and
 * RESETS to 0 after a connection that actually became usable (`ready` accepted),
 * so an hour of flap-free service does not earn a 60 s first retry next time.
 */
export function nextAttempt(reason: RelayDownReason, attempt: number): number {
  if (reason === "version" || reason === "replaced" || reason === "unsupported-url") {
    return 0;
  }
  return attempt + 1;
}

/**
 * Should the daemon dial the relay at all right now (Owner Q1)? True while the
 * device store has a device OR a pairing window is open — the authority answers
 * this (`DeviceAuthority.wantsReachability`). A user who never pairs never
 * contacts the relay, which is the whole point of making it conditional.
 *
 * Trivial by itself; it is a named function so the CONDITION has one home and its
 * test can say what it protects without reading `relay-link.ts`.
 */
export function relayWanted(hasDeviceOrWindow: boolean, enabled: boolean): boolean {
  return enabled && hasDeviceOrWindow;
}

/**
 * Map a relay refusal onto a {reason} the policy waits on. `version` is its own
 * case; every other code (`invalid`, `busy`, or a code this build has never
 * heard of — review R1 finding 1) is an ordinary backoff, because none of them
 * is fixed by waiting a specific time.
 *
 * `RELAY_ERROR_CODES` is deliberately NOT the input type: a newer relay's code
 * must land in the same place as `invalid` (AGENTS §7 forward compat).
 */
export function reasonForErrorCode(code: string): RelayDownReason {
  if (code === "version") {
    return "version";
  }
  if (code === "busy") {
    return "busy";
  }
  // `invalid`, or a code a newer relay invented: an ordinary retry either way.
  return "invalid";
}

/**
 * The liveness deadline: `ping` is due when a connection has been up this long
 * without one; a `pong` missed past `RELAY_PONG_DEADLINE_MS` means the far end is
 * gone (R0(c)) and the link reconnects.
 *
 * Pure and clock-injected, so "we do not notice a dead path" is testable without
 * a 25 s wait — the bug R0(c) proved is exactly a missing deadline.
 */
export interface RelayLiveness {
  /** Is a `ping` due at `at`? */
  pingDue(at: number): boolean;
  /** Record that a `ping` went out at `at` (arms the pong deadline). */
  pingSent(at: number): void;
  /** Record a `pong` (clears the deadline). */
  pongReceived(): void;
  /** Has the pong deadline passed at `at` (i.e. the link must be dropped)? */
  expired(at: number): boolean;
}

export function createRelayLiveness(
  startedAt: number,
  intervals: { readonly pingMs?: number; readonly pongMs?: number } = {},
): RelayLiveness {
  const pingMs = intervals.pingMs ?? RELAY_PING_INTERVAL_MS;
  const pongMs = intervals.pongMs ?? RELAY_PONG_DEADLINE_MS;
  let lastPing = startedAt;
  let awaitingSince: number | undefined;
  return {
    pingDue(at) {
      return at - lastPing >= pingMs;
    },
    pingSent(at) {
      lastPing = at;
      awaitingSince = at;
    },
    pongReceived() {
      awaitingSince = undefined;
    },
    expired(at) {
      return awaitingSince !== undefined && at - awaitingSince >= pongMs;
    },
  };
}
