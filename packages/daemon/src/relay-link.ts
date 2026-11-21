/**
 * The daemon's dial-OUT to the mobile relay (docs/feat/mobile-relay.md R4).
 *
 * Shape (Owner Q3, "reverse accept"): ONE control socket to `<relay>/v1/daemon`
 * carries `hello`, the relay's `open`, and liveness; each phone stream is its OWN
 * socket to `<relay>/v1/accept`, which after the `accept` frame is a raw splice
 * leg. That leg is a plain `ByteCarrier`, so the phone lands in
 * `acceptDevice` — the DIRECT route's own code (R3) — and therefore in the same
 * Noise handshake, the same device registry, the same `Connection`, the same
 * revoke handle and the same single broker. **This file adds a transport and
 * nothing else** (AGENTS §7 one session path).
 *
 * **The relay is not trusted.** Every frame it sends is input: `ready.id` must
 * equal the id our own secret derives (`relayIdOf`, R1) or the link drops; `open`
 * only names a stream and an untrusted `ip` used as a rate-limit key; a bogus
 * stream simply fails to accept; every stream still needs the Noise handshake
 * against the computer key. Nothing here decides access — decisions stay on the
 * laptop, in `DeviceAuthority`.
 *
 * Everything about WHEN to dial is in `relay-link-policy.ts` (pure, clock- and
 * random-injected). This file is the socket plumbing around it: dial, validate,
 * accept, close, and stop.
 */
import {
  RELAY_PROTOCOL_VERSION,
  type RelayToDaemonFrame,
  RelayToDaemonFrameSchema,
  encodeBase64Url,
  isInboundFrameTooLarge,
  isPushDeliveryStatus,
  isRelayUrl,
  knownRelayFeatures,
} from "@tentacle/protocol";
import { type ByteCarrier, type CarrierFrame, carrierFrameOf } from "@tentacle/transport";
import { relayIdOf } from "@tentacle/transport/relay-id";
import type { HooksTrustPrecheck } from "./connection.ts";
import { acceptDevice } from "./device-accept.ts";
import type { DeviceAuthority } from "./device-authority.ts";
import type { HandshakeLimiter } from "./handshake-limit.ts";
import {
  RELAY_LIMIT_KEY_PREFIX,
  RELAY_PING_INTERVAL_MS,
  type RelayDownReason,
  type RelayLiveness,
  type RelayPolicySeeds,
  backoffCounterFor,
  createRelayLiveness,
  nextAttempt,
  reasonForErrorCode,
  relayRetryAfter,
  relayWanted,
} from "./relay-link-policy.ts";

import type { SessionHost } from "./session-host.ts";

/** The bits of a Bun client WebSocket this file touches (never Bun's own types). */
export interface RelaySocket {
  /** Text for the control socket and the `accept` frame; binary for the data leg's Noise frames. */
  send(data: string | Uint8Array): void;
  close(): void;
}

/** What a dial does — injected, so a test drives a fake hostile relay with no socket. */
export type RelayDialer = (url: string) => RelaySocketHost;

/**
 * A connected-or-connecting socket plus the callbacks it was opened with. The
 * `dialer` returns this synchronously; the caller's handlers are attached to it
 * (`setOnOpen` etc.) so an implementation is free to be a real WebSocket, which
 * fires its events asynchronously and may have fired `open` already.
 */
export interface RelaySocketHost {
  readonly socket: RelaySocket;
  setOnOpen(handler: () => void): void;
  /** A text frame as its string, a binary one as its bytes (`carrierFrameOf`). */
  setOnMessage(handler: (data: CarrierFrame) => void): void;
  /** `code`/`reason` are Bun's close event; absent when the transport gave none. */
  setOnClose(handler: (info: { readonly code?: number; readonly reason?: string }) => void): void;
}

/**
 * How the link reports what it did, in the plan's audit vocabulary: `relay-ready
 * <id8>`, `relay-down <reason>`, `relay-open`, `relay-accept-failed`,
 * `relay-replaced <id8>`. One plain string sink, exactly like `ws-server`'s
 * `onAudit`: the device path's own lines (`device-open …`) flow through the same
 * one, so an operator reads one ordered stream.
 */
export type RelayLinkAudit = (line: string) => void;

export interface RelayLinkOptions {
  /** The relay's base URL (`wss://…`, or `ws://` loopback: validated before the first dial). */
  readonly url: string;
  /** The 32-byte secret from `<store>/relay.json` (R5a owns reading/creating it). */
  readonly secret: Uint8Array;
  readonly authority: DeviceAuthority;
  readonly sessionHost: SessionHost;
  /**
   * The SAME limiter the direct `/e2e` route uses, so a relay flood and a direct
   * handshake share one `maxConcurrent` (F7) — a relay cannot starve the direct
   * route's cap without also being capped itself.
   */
  readonly limiter: HandshakeLimiter;
  /** Dial a URL: `bunDialer` in production, a fake in tests. */
  readonly dial: RelayDialer;
  /**
   * The host's own project-hooks answer (docs/feat/serve-mcp.md S4), threaded
   * to every `Connection` this link's accept legs build — the relay is the
   * usual remote path, so without it a phone over the relay is asked about a
   * folder this machine already decided about (S4 review 1, finding 1).
   */
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  /** Operator lines (`options.onAudit` on the server). Never payloads, never secrets. */
  readonly onAudit?: RelayLinkAudit;
  /** Injected time and randomness (tests own both; `Date.now`/`Math.random` otherwise). */
  readonly seeds?: RelayPolicySeeds;
  /** Injected timers, so a test drives backoff without waiting it out. */
  readonly timers?: RelayLinkTimers;
  /** Liveness intervals (25 s / 10 s in production; a test shortens them). */
  readonly liveness?: { readonly pingMs?: number; readonly pongMs?: number };
  readonly maxFrameBytes?: number;
  readonly onError?: (error: Error) => void;
  /**
   * How long a push waits for a reconnecting link before it is dropped
   * (docs/feat/mobile-push.md F2: "holds the frame ≤ 60 s, then drops it").
   * A test shortens it.
   */
  readonly pushHoldMs?: number;
  /** How long one push waits for its `push-result` (a lost answer must not leak a pending entry). */
  readonly pushTimeoutMs?: number;
}

/** The timers the link needs, injectable so a test never waits on a real 60 s cap. */
export interface RelayLinkTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimers: RelayLinkTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // Housekeeping, never a reason to keep the process alive (`serve`'s listener
    // decides that, and an un-unref'd tick makes `bun test` hang).
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** How long a push waits for a reconnecting link before it is dropped (F2: "≤ 60 s, then drops it"). */
export const DEFAULT_PUSH_HOLD_MS = 60_000;
/** How long one push waits for its `push-result` (docs/feat/mobile-push.md Design 4: 10 s). */
export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;

export interface RunningRelayLink {
  /** The id our secret derives (the relay confirms it; the address is built from it). */
  readonly id: string;
  /** The phone-facing address this daemon would be reached at (`<url>/d/<id>/e2e`). */
  readonly address: string;
  /** Is the control socket registered right now? (tests and `serve`'s own logging) */
  isConnected(): boolean;
  /** Open sockets: control (0/1) + one per live stream. */
  openStreams(): number;
  /**
   * Deliver one push through the relay (docs/feat/mobile-push.md Design 5,
   * slice P8), resolving with the `push-result` status.
   *
   * Refused — WITHOUT a frame on the wire — when the relay announced no
   * `"push"` in `ready.features` (`relay-no-push`) or the link is off entirely
   * (`relay-off`): an older relay closes the control socket on an unknown frame
   * (C1), so sending one is what would cost reachability, not skipping it.
   *
   * While the link is CONNECTING the frame is held briefly (up to
   * `holdMs`), so a push decided during a reconnect still lands; past that it
   * is dropped (`unavailable`) with one audit line, which is F2's "the ask
   * stays pending, the phone learns on open". Never rejects.
   */
  push(delivery: RelayPushDelivery): Promise<RelayPushStatus>;
  /** What this link can do about push right now (the `push_register` result's input). */
  pushStatus(): "relay-off" | "relay-no-push" | "on";
  /**
   * Deliver one Live Activity push (docs/feat/mobile-live-activity.md L8), with
   * the SAME contract as {@link push}: refused without a frame when the relay
   * announced no `"liveactivity"`, held briefly while the link reconnects, never
   * rejects.
   */
  liveActivity(delivery: RelayLiveActivityDelivery): Promise<RelayPushStatus>;
  /** What this link can do about Live Activities right now (the register result's input). */
  liveActivityStatus(): "relay-no-la" | "on";
  /** Register the callback run on every `ready` that carries `"liveactivity"` (F3's resend). */
  bindLiveActivityReady(callback: () => void): void;
  /** Stop: control and every accept leg closed, timers cleared. Idempotent. */
  stop(): void;
}

/** One push this link hands the relay: everything but the `n` correlation, which the link owns. */
export interface RelayPushDelivery {
  readonly token: string;
  readonly env: "sandbox" | "production";
  readonly collapse: string;
  readonly ttl: number;
  /** `{tp: <envelope>}` — the sealed envelope, and nothing else. */
  readonly payload: { readonly tp: unknown };
}

/** One activity this link hands the relay: the `la` block is L3's, already validated. */
export interface RelayLiveActivityDelivery {
  readonly token: string;
  readonly env: "sandbox" | "production";
  readonly priority: 5 | 10;
  readonly la: {
    readonly event: "start" | "update" | "end";
    readonly timestamp: number;
    readonly staleDate?: number | undefined;
    readonly dismissalDate?: number | undefined;
    readonly contentState?: { readonly v: 1; readonly e: string; readonly c: string } | undefined;
    readonly attributes?: { readonly v: 1; readonly k: string; readonly slot: string } | undefined;
  };
}

/** What a push resolved to: the relay's own status vocabulary (P2's `PUSH_DELIVERY_STATUSES`). */
export type RelayPushStatus = "sent" | "gone" | "rejected" | "throttled" | "unavailable";

/**
 * Start the link. It dials only while `authority.wantsReachability()` says
 * something wants this daemon reachable (Owner Q1), re-checked on every retry, so
 * a daemon whose last device is revoked stops dialling without a restart.
 */
export function startRelayLink(options: RelayLinkOptions): RunningRelayLink {
  const seeds = options.seeds ?? { now: Date.now, random: Math.random };
  const timers = options.timers ?? systemTimers;
  const audit = options.onAudit ?? (() => {});
  const id = relayIdOf(options.secret);
  const base = options.url.trim().replace(/\/+$/, "");
  const address = `${base}/d/${id}/e2e`;

  let stopped = false;
  let attempt = 0;
  /**
   * Oversize strikes have their OWN counter (F7's fallback, R4 review 1): the
   * shared `attempt` is reset by an accepted `ready`, and alternating `ready`
   * with one oversize frame is exactly how a hostile relay would keep every
   * cycle looking like a fresh, well-behaved connection.
   */
  let oversizeStrikes = 0;
  let connected = false;
  const noteSent = new Set<RelayDownReason>();
  /** The live control socket and its stream legs, newest last. */
  let control: RelaySocketHost | undefined;
  /** Every open accept leg by stream token: closing it is what a `stop` does. */
  const legs = new Map<string, () => void>();
  let retryHandle: unknown;
  let livenessHandle: unknown;
  let liveness: RelayLiveness | undefined;
  /** Reasons whose one-off notice already went out (never repeated). */
  let noticed = new Set<RelayDownReason>();
  /**
   * Push (P8): whether THIS relay announced `"push"` in its `ready`, the
   * per-socket correlation counter, and the frames awaiting their
   * `push-result`. Cleared on every control teardown — a `push-result` for a
   * counter the relay never saw can never arrive, and a pending promise must
   * settle rather than leak.
   */
  let features: readonly string[] = [];
  /**
   * The control socket that completed `ready` (and is therefore the ONE a `push`
   * may go on), or undefined. `dial` keeps its own per-socket `ready` flag; this
   * is the same fact at link scope, because the counter and the pending answers
   * belong to it (`push-result`s are `n`-correlated per socket).
   */
  let readyControl: RelaySocketHost | undefined;
  let pushSeq = 0;
  const pendingPushes = new Map<
    number,
    { resolve: (status: RelayPushStatus) => void; handle: unknown }
  >();
  /**
   * Frames waiting for the link to be ready again (F2's short hold): a push or an
   * activity, plus a wait timer. Keyed by a SEND function rather than a frame
   * object, so `flushHeldPushes` does not have to know which kind it is
   * re-sending — the two share the `n` correlation and the answer vocabulary.
   */
  const heldPushes: {
    send: (resolve: (status: RelayPushStatus) => void) => void;
    resolve: (status: RelayPushStatus) => void;
    handle: unknown;
  }[] = [];
  /** One notice per start about a relay that cannot push (F4: never one per push). */
  let pushNoFeatureNoticed = false;
  /** The same, for a relay without Live Activity support (F4). */
  let laNoFeatureNoticed = false;
  /** Called once per `ready` that carried `"liveactivity"`: the notifier resends its live states (F3). */
  let onLaReady: (() => void) | undefined;

  /** A bad URL cannot fix itself: refuse loudly once and never dial (R5a validates too). */
  if (!isRelayUrl(base)) {
    audit("relay-down url-invalid");
    stopped = true;
  }

  const endLiveness = (): void => {
    if (livenessHandle !== undefined) {
      timers.clearInterval(livenessHandle);
      livenessHandle = undefined;
    }
    liveness = undefined;
  };

  /**
   * Send one push frame NOW. Its callers — `push()` and `flushHeldPushes()` —
   * have each checked the `features` gate first, so no frame can reach a relay
   * that did not announce `"push"` (C1). `host === undefined` here means the
   * socket went away between the check and this call (a `dropControl` in the
   * same tick): `unavailable`, never a throw.
   */
  /**
   * Send ONE frame that expects a `push-result` (a push, or an activity: the
   * relay answers both with the same vocabulary, and the `n` correlation is the
   * same mechanism). The caller has already checked the `features` gate, so no
   * frame can reach a relay that did not announce its name (C1). `host ===
   * undefined` here means the socket went away between the check and this call
   * (a `dropControl` in the same tick): `unavailable`, never a throw.
   */
  const sendFrameOf = (
    frameOf: (n: number) => unknown,
    resolve: (status: RelayPushStatus) => void,
  ): void => {
    const host = readyControl;
    if (host === undefined || control !== host) {
      resolve("unavailable");
      return;
    }
    const n = ++pushSeq;
    // A lost answer must not leak a pending entry (or hang a caller): the entry
    // resolves `unavailable` on its own deadline.
    const handle = timers.setTimeout(() => {
      if (pendingPushes.delete(n)) {
        resolve("unavailable");
      }
    }, options.pushTimeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS);
    pendingPushes.set(n, { resolve, handle });
    try {
      host.socket.send(JSON.stringify(frameOf(n)));
    } catch (error) {
      // A send that throws closed the socket underneath us: the frame is lost.
      if (pendingPushes.delete(n)) {
        timers.clearTimeout(handle);
        resolve("unavailable");
      }
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  /** One banner push: the `push` frame P3 defines. */
  const sendPush = (
    delivery: RelayPushDelivery,
    resolve: (status: RelayPushStatus) => void,
  ): void => {
    sendFrameOf(
      (n) => ({
        t: "push",
        n,
        token: delivery.token,
        env: delivery.env,
        collapse: delivery.collapse,
        ttl: delivery.ttl,
        payload: delivery.payload,
      }),
      resolve,
    );
  };

  /** One Live Activity push: the `liveactivity` frame (docs/feat/mobile-live-activity.md L4/L8). */
  const sendLiveActivity = (
    delivery: RelayLiveActivityDelivery,
    resolve: (status: RelayPushStatus) => void,
  ): void => {
    sendFrameOf(
      (n) => ({
        t: "liveactivity",
        n,
        token: delivery.token,
        env: delivery.env,
        priority: delivery.priority,
        la: delivery.la,
      }),
      resolve,
    );
  };

  /** Hold a push for a reconnecting link (F2), dropping it after `pushHoldMs` with one line. */
  const holdPush = (
    send: (resolve: (status: RelayPushStatus) => void) => void,
    resolve: (status: RelayPushStatus) => void,
  ): void => {
    const entry = {
      send,
      resolve,
      handle: timers.setTimeout(() => {
        const at = heldPushes.indexOf(entry);
        if (at >= 0) heldPushes.splice(at, 1);
        audit("push-dropped link-down");
        resolve("unavailable");
      }, options.pushHoldMs ?? DEFAULT_PUSH_HOLD_MS),
    };
    heldPushes.push(entry);
  };

  /** Settle everything waiting on the control socket: a new registration may reuse the counters. */
  const dropPendingPushes = (): void => {
    for (const [, entry] of pendingPushes) {
      timers.clearTimeout(entry.handle);
      entry.resolve("unavailable");
    }
    pendingPushes.clear();
    // Held frames survive a control blip: the hold's whole point is that a push
    // decided during a reconnect still lands (F2). They keep their own timer.
  };

  /**
   * The link is ready again: flush what was held (in order, the oldest first).
   *
   * A hold survives the reconnect it was waiting for, so this is the ONE place a
   * frame could otherwise reach a relay that announced no `"push"` — the same
   * relay answered `ready` without it (C1/F4). Re-checking `features` HERE is
   * what makes the gate hold across a reconnect: a held push that cannot be sent
   * is refused, never put on the wire.
   */
  const flushHeldPushes = (): void => {
    const pushable = readyControl !== undefined && features.includes("push");
    for (const entry of heldPushes.splice(0)) {
      timers.clearTimeout(entry.handle);
      if (pushable) {
        entry.send(entry.resolve);
        continue;
      }
      entry.resolve("unavailable");
    }
  };

  /** Tear the control socket down WITHOUT scheduling anything (a caller decides). */
  const dropControl = (): void => {
    const current = control;
    control = undefined;
    connected = false;
    // A socket that is gone has seen neither these counters nor these frames:
    // settle them now, so no caller waits on an answer nothing can send.
    dropPendingPushes();
    readyControl = undefined;
    features = [];
    endLiveness();
    current?.socket.close();
  };

  /** Close every accept leg: a stopped link leaves nothing dialled into the relay. */
  const dropStreams = (): void => {
    for (const [, closeLeg] of [...legs]) {
      closeLeg();
    }
    legs.clear();
  };

  /**
   * Schedule the next dial from the policy. `Infinity` means never, which is the
   * honest answer for a URL that will not become valid.
   */
  const schedule = (reason: RelayDownReason): void => {
    if (stopped) {
      return;
    }
    const counter = backoffCounterFor(reason, attempt, oversizeStrikes);
    const retry = relayRetryAfter(reason, counter, seeds);
    attempt = nextAttempt(reason, attempt);
    if (reason === "oversize" && Number.isFinite(retry.delayMs)) {
      // Its own progression, so a following `ready` cannot reset it (see
      // `backoffCounterFor`).
      oversizeStrikes += 1;
    }
    // ONE line per cause, never one per retry: a version skew held an hour, and
    // a replaced id held five minutes, would otherwise repeat the same sentence
    // forever (F13, F16). A cause already told is silently retried.
    if (retry.notice !== undefined && !noticed.has(reason)) {
      noticed.add(reason);
      audit(`relay-down ${reason}`);
    } else if (retry.notice === undefined) {
      // An ordinary retry still says WHY once per outage, not once per tick: the
      // set empties on a successful registration.
      if (!noticed.has(reason)) {
        noticed.add(reason);
        audit(`relay-down ${reason}`);
      }
    }
    if (!Number.isFinite(retry.delayMs)) {
      stopped = true;
      return;
    }
    retryHandle = timers.setTimeout(() => {
      retryHandle = undefined;
      dial();
    }, retry.delayMs);
    (retryHandle as { unref?: () => void })?.unref?.();
  };

  /** One control-socket attempt. */
  const dial = (): void => {
    if (stopped) {
      return;
    }
    // Owner Q1, re-checked on EVERY attempt: no device and no pairing window
    // means we never contact the relay at all, not even once.
    if (!relayWanted(options.authority.wantsReachability(), true)) {
      // Idle, not failed: no audit line, no backoff — re-check soon, cheaply.
      retryHandle = timers.setTimeout(() => {
        retryHandle = undefined;
        dial();
      }, 5_000);
      (retryHandle as { unref?: () => void })?.unref?.();
      return;
    }
    let host: RelaySocketHost;
    try {
      host = options.dial(`${base}/v1/daemon`);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      schedule("closed");
      return;
    }
    control = host;
    let ready = false;
    host.setOnOpen(() => {
      if (control !== host) {
        return;
      }
      // The secret travels in the FRAME, never in the URL (a URL reaches an
      // access log) — Design §2.
      host.socket.send(
        JSON.stringify({ t: "hello", v: RELAY_PROTOCOL_VERSION, secret: b64url(options.secret) }),
      );
    });
    host.setOnMessage((data) => {
      if (control !== host) {
        return;
      }
      if (isInboundFrameTooLarge(data)) {
        // The frame is over the DECODE bound (F7). It must NOT be treated as
        // "malformed": an oversize strike has its own backoff counter, or a
        // relay alternating `ready` with one huge frame keeps the link in a ~1 s
        // allocation loop (R0(b)/(d): the 2 MiB already exists by now).
        dropControl();
        schedule("oversize");
        return;
      }
      // The control socket carries JSON text only: a binary frame is malformed
      // (a close, never a parse — F19).
      const frame = typeof data === "string" ? parseFrame(data) : undefined;
      if (frame === undefined) {
        // A malformed control frame is a close, never a guess (F19).
        dropControl();
        schedule("closed");
        return;
      }
      if (frame.t === "ready") {
        if (frame.id !== id) {
          // A LYING relay (F7): it claims an id our secret does not derive, so
          // everything it says next is worthless. Mutation: skip this check and
          // a hostile relay can hold the link and feed us bogus `open`s.
          dropControl();
          schedule("wrong-id");
          return;
        }
        ready = true;
        connected = true;
        // A usable registration resets the backoff: an hour of service must not
        // earn a 60 s first retry (relay-link-policy's `nextAttempt`). The
        // OVERSIZE counter is deliberately not reset here — a hostile relay
        // alternates `ready` with one oversize frame precisely to keep this
        // reset firing (F7's fallback, R4 review 1).
        attempt = 0;
        noticed = new Set();
        // The relay's OWN statement of what it carries (P3/C1): a `push` frame
        // may only be sent to a relay that says `"push"`, or an older one closes
        // the control socket on the unknown frame and costs every phone its
        // reachability (F4).
        features = knownRelayFeatures(frame.features);
        readyControl = host;
        if (!features.includes("push") && !pushNoFeatureNoticed) {
          pushNoFeatureNoticed = true;
          audit("relay-no-push");
        }
        if (!features.includes("liveactivity") && !laNoFeatureNoticed) {
          laNoFeatureNoticed = true;
          audit("relay-no-la");
        }
        if (features.includes("liveactivity")) {
          // F3: an activity state kept while the link was down is resent NOW,
          // once per live slot — convergence by state, never by replaying the
          // events the link missed.
          onLaReady?.();
        }
        audit(`relay-ready ${id.slice(0, 8)}`);
        startLiveness(host);
        // A push decided during the reconnect lands now (F2's short hold).
        flushHeldPushes();
        return;
      }
      if (frame.t === "error") {
        dropControl();
        schedule(reasonForErrorCode(frame.code));
        return;
      }
      if (frame.t === "replaced") {
        // A second daemon registered our id (F16). Pausing is the whole point:
        // retrying sooner only flaps the id back and forth.
        dropControl();
        audit(`relay-replaced ${id.slice(0, 8)}`);
        schedule("replaced");
        return;
      }
      if (frame.t === "pong") {
        liveness?.pongReceived();
        return;
      }
      if (frame.t === "push-result") {
        // The relay's answer to one `push` (P3: out of order, `n`-correlated).
        // An unknown `n` is a stray (a restart, a lying relay): ignored, because
        // acting on it would settle a request it does not answer.
        const entry = pendingPushes.get(frame.n);
        if (entry === undefined) {
          return;
        }
        pendingPushes.delete(frame.n);
        timers.clearTimeout(entry.handle);
        // A status this build does not know (a newer relay) is `unavailable`,
        // never a close: the daemon does not answer the relay's QUESTION here.
        entry.resolve(isPushDeliveryStatus(frame.status) ? frame.status : "unavailable");
        return;
      }
      if (frame.t === "open") {
        if (!ready) {
          // F7 (R4 review 1): `open` needs an ACCEPTED `ready`, or the
          // `ready.id` check above gates nothing — a relay that never registers
          // would get an accept dial and a limiter slot anyway, exactly what a
          // lying one gets. Refusing is the only order that makes the handshake
          // mean something. (Noise still protects access either way.)
          audit("relay-accept-failed");
          return;
        }
        openStream(host, frame.stream, frame.ip);
        return;
      }
    });
    host.setOnClose((info) => {
      if (control !== host) {
        return;
      }
      // An oversize close is Bun telling us it gave up on a frame: F7's fallback
      // is an ordinary (jittered) backoff, never an immediate redial into the
      // same allocation.
      schedule(oversizeHint(info) ? "oversize" : "closed");
      // ONLY the control socket goes. A stream is its own splice of two sockets
      // and the relay keeps it after a control close ("its streams live on, F2"
      // — `apps/relay/src/relay-core.ts`), so closing the legs here would detach
      // every live phone mid-turn on one control blip. `stop()` is what closes
      // them; a leg also closes itself when its own phone or the relay drops it.
      dropControl();
    });
  };

  /** Arm the liveness tick for one registered control socket (R0(c): nothing else notices). */
  const startLiveness = (host: RelaySocketHost): void => {
    endLiveness();
    const live = createRelayLiveness(seeds.now(), options.liveness ?? {});
    liveness = live;
    livenessHandle = timers.setInterval(
      () => {
        if (control !== host || stopped) {
          return;
        }
        const at = seeds.now();
        if (live.expired(at)) {
          // No `pong` in the deadline: the path is dead even though Bun says
          // `open` (R0(c)). Drop it and let the backoff reconnect.
          dropControl();
          schedule("timeout");
          return;
        }
        if (live.pingDue(at)) {
          live.pingSent(at);
          host.socket.send(JSON.stringify({ t: "ping" }));
        }
      },
      Math.min(options.liveness?.pingMs ?? RELAY_PING_INTERVAL_MS, 1_000),
    );
  };

  /**
   * Take one phone stream: dial the accept leg, send its token, then hand the
   * socket to `acceptDevice` — the direct route's own device path (R3).
   */
  const openStream = (host: RelaySocketHost, token: string, ip: string): void => {
    if (control !== host || stopped) {
      return;
    }
    if (legs.has(token)) {
      // The same token twice is a relay bug or a replay (F12); a stream token is
      // single-use, so the second one is dropped rather than opening two legs.
      audit("relay-accept-failed");
      return;
    }
    // The limiter, keyed by the relay's UNTRUSTED `ip` (F7): a flood of `open`s
    // cannot outrun `maxConcurrent`, and it shares the cap with the direct route.
    const limitKey = `${RELAY_LIMIT_KEY_PREFIX}${ip}`;
    if (!options.limiter.begin(limitKey)) {
      audit("relay-accept-failed");
      return;
    }
    let settled = false;
    const endSlot = (): void => {
      if (settled) return;
      settled = true;
      options.limiter.end();
    };
    let leg: RelaySocketHost;
    try {
      leg = options.dial(`${base}/v1/accept`);
    } catch (error) {
      endSlot();
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      audit("relay-accept-failed");
      return;
    }
    let closed = false;
    let release: () => void = () => {};
    let onMessage: ((data: CarrierFrame) => void) | undefined;
    let onClose: (() => void) | undefined;
    let released = false;
    /** The device path's teardown, idempotent (it stops the watcher and drops the handle). */
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    // After the `accept` frame the leg is the Noise responder's raw byte carrier
    // (E2E v2: binary frames, docs/feat/noise-binary-carrier.md).
    const channel: ByteCarrier = {
      send: (data) => leg.socket.send(data),
      close: () => leg.socket.close(),
      setOnMessage: (handler) => {
        onMessage = handler;
      },
      setOnClose: (handler) => {
        onClose = handler;
      },
    };
    const forget = (): void => {
      legs.delete(token);
    };
    legs.set(token, () => {
      forget();
      leg.socket.close();
    });
    leg.setOnOpen(() => {
      leg.socket.send(JSON.stringify({ t: "accept", v: RELAY_PROTOCOL_VERSION, stream: token }));
      if (closed) {
        // The leg closed while we were still connecting: do not start a
        // handshake on a dead socket (the F22 orphan in the other direction).
        return;
      }
      // The SAME device path the direct `/e2e` route runs (R3): Noise against
      // the computer key, the device registry, the pairing handler, one
      // `Connection`, the revoke handle. This file decides nothing about access.
      const accepted = acceptDevice(channel, {
        authority: options.authority,
        sessionHost: options.sessionHost,
        isClosed: () => closed,
        ...(options.hooksTrustPrecheck ? { hooksTrustPrecheck: options.hooksTrustPrecheck } : {}),
        ...(options.onAudit ? { onAudit: options.onAudit } : {}),
        ...(options.onError ? { onError: options.onError } : {}),
        ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
        onSettled: endSlot,
      });
      release = accepted.release;
      audit("relay-open");
    });
    leg.setOnMessage((data) => {
      // The DECODE guard (R1/F7): the string already exists (R0(b) — Bun built
      // it), so this bounds the JSON/handshake work, not the allocation.
      if (isInboundFrameTooLarge(data)) {
        leg.socket.close();
        return;
      }
      onMessage?.(data);
    });
    leg.setOnClose(() => {
      if (closed) {
        return;
      }
      closed = true;
      forget();
      // Frees the limiter slot exactly once whether the handshake resolved,
      // rejected or never started (the slot the `begin` above took).
      endSlot();
      releaseOnce();
      onClose?.();
    });
  };

  dial();

  return {
    id,
    address,
    isConnected: () => connected,
    openStreams: () => legs.size,
    /**
     * One push through the control socket (P8).
     *
     * Refused WITHOUT a frame when the relay announced no `"push"`: an older
     * relay closes the control socket on an unknown frame (C1), so sending one
     * is what would cost reachability, never the push. A relay that IS
     * registered and lacks `"push"` is refused AT ONCE, never held: holding it
     * would hand the frame to the next `ready` (which is how a re-registered
     * no-push relay used to get one), and it would make every device wait out
     * the whole hold for a `push-dropped link-down` that names the wrong cause.
     * While the link is CONNECTING the frame is held (F2), which is what makes
     * a push decided during a reconnect land instead of being dropped on the
     * floor. Never rejects: a push is best-effort, and the ask stays pending
     * (F1).
     */
    push(delivery) {
      return new Promise<RelayPushStatus>((resolve) => {
        if (stopped) {
          resolve("unavailable");
          return;
        }
        if (readyControl !== undefined) {
          if (features.includes("push")) {
            sendPush(delivery, resolve);
            return;
          }
          // Registered, and not push-capable: the answer is known now, and it
          // is `unavailable` with no frame (the `relay-no-push` notice already
          // said why once per start: F4 never repeats itself per push).
          resolve("unavailable");
          return;
        }
        holdPush((next) => sendPush(delivery, next), resolve);
      });
    },
    liveActivity(delivery) {
      return new Promise<RelayPushStatus>((resolve) => {
        if (stopped) {
          resolve("unavailable");
          return;
        }
        if (readyControl !== undefined) {
          if (features.includes("liveactivity")) {
            sendLiveActivity(delivery, resolve);
            return;
          }
          // Registered, and this relay cannot carry an activity: the answer is
          // known now, and the `relay-no-la` notice already said why once per
          // start (F4 never repeats itself per push).
          resolve("unavailable");
          return;
        }
        holdPush((next) => sendLiveActivity(delivery, next), resolve);
      });
    },
    bindLiveActivityReady(callback) {
      onLaReady = callback;
    },
    liveActivityStatus() {
      // `relay-off` is the CALLER's word (it knows whether the relay is enabled);
      // this link only says whether a registered relay announced the feature.
      if (readyControl !== undefined && features.includes("liveactivity")) {
        return "on";
      }
      return "relay-no-la";
    },
    pushStatus() {
      // `relay-off` is the CALLER's word for "the relay is disabled" (it knows);
      // this link only ever says whether a registered relay carries push.
      if (readyControl !== undefined && features.includes("push")) {
        return "on";
      }
      return "relay-no-push";
    },
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      if (retryHandle !== undefined) {
        timers.clearTimeout(retryHandle);
        retryHandle = undefined;
      }
      dropControl();
      dropStreams();
      // A held push has no link left to land on: settle it now, never a dangling promise.
      for (const entry of heldPushes.splice(0)) {
        timers.clearTimeout(entry.handle);
        entry.resolve("unavailable");
      }
      endLiveness();
    },
  };
}

/**
 * The real dialer: one Bun client WebSocket per leg. `host` events are attached
 * defensively — a socket can be `open` (or already closed) before the caller
 * registers its handlers, so the `readyState` is replayed on attach.
 *
 * Note what is deliberately NOT here: no `maxPayloadLength`. Bun's CLIENT
 * constructor takes none (R0(d) probed it being ignored), so the inbound size
 * bound is `isInboundFrameTooLarge` at the handler — a decode bound, not a memory
 * one (F7, still open by design).
 */
export function bunRelayDialer(): RelayDialer {
  return (url) => {
    const ws = new WebSocket(url);
    // Bun's client defaults to "nodebuffer": pinned, so binary arrives as an ArrayBuffer.
    ws.binaryType = "arraybuffer";
    let onOpen: (() => void) | undefined;
    let onMessage: ((data: CarrierFrame) => void) | undefined;
    let onClose: ((info: { code?: number; reason?: string }) => void) | undefined;
    let opened = false;
    let closed = false;
    const host: RelaySocketHost = {
      socket: {
        send: (data) => {
          if (!closed) {
            ws.send(data);
          }
        },
        close: () => ws.close(),
      },
      setOnOpen(handler) {
        onOpen = handler;
        if (opened) {
          handler();
        }
      },
      setOnMessage(handler) {
        onMessage = handler;
      },
      setOnClose(handler) {
        onClose = handler;
        if (closed) {
          handler({});
        }
      },
    };
    ws.addEventListener("open", () => {
      opened = true;
      onOpen?.();
    });
    ws.addEventListener("message", (event) => {
      // As received (never `String(x)`): text stays text, binary becomes its bytes.
      const frame = carrierFrameOf(event.data);
      if (frame === null) ws.close();
      else onMessage?.(frame);
    });
    ws.addEventListener("close", (event) => {
      if (closed) {
        return;
      }
      closed = true;
      onClose?.({ code: (event as { code?: number }).code });
    });
    // An error is always followed by a close (the spec), so it is not reported
    // separately here: ONE teardown path, ONE backoff. A swallowed error event
    // would otherwise look like an unhandled rejection in a test's output.
    ws.addEventListener("error", () => {});
    return host;
  };
}

/** Parse one relay→daemon frame, or `undefined` (a malformed frame is a close, never a guess). */
function parseFrame(data: string): RelayToDaemonFrame | undefined {
  if (isInboundFrameTooLarge(data)) {
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return undefined;
  }
  const parsed = RelayToDaemonFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** 1009 = "message too big": Bun's own close code when a frame broke a limit. */
function oversizeHint(info: { readonly code?: number; readonly reason?: string }): boolean {
  return info.code === 1009;
}

/**
 * base64url of a secret, exactly as `RelaySecretTextSchema` accepts it — the
 * protocol's own encoder, so the daemon and the relay cannot disagree.
 */
function b64url(bytes: Uint8Array): string {
  return encodeBase64Url(bytes);
}
