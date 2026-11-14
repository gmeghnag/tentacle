/**
 * The daemon's dial-OUT to the mobile relay (docs/feat/mobile-relay.md R4).
 *
 * Shape (Owner Q3, "reverse accept"): ONE control socket to `<relay>/v1/daemon`
 * carries `hello`, the relay's `open`, and liveness; each phone stream is its OWN
 * socket to `<relay>/v1/accept`, which after the `accept` frame is a raw splice
 * leg. That leg is a plain `DuplexChannel`, so the phone lands in
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
  isRelayUrl,
} from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { acceptDevice } from "./device-accept.ts";
import type { DeviceAuthority } from "./device-authority.ts";
import type { HandshakeLimiter } from "./handshake-limit.ts";
import {
  RELAY_LIMIT_KEY_PREFIX,
  RELAY_PING_INTERVAL_MS,
  type RelayDownReason,
  type RelayLiveness,
  type RelayPolicySeeds,
  createRelayLiveness,
  nextAttempt,
  reasonForErrorCode,
  relayRetryAfter,
  relayWanted,
} from "./relay-link-policy.ts";

import type { SessionHost } from "./session-host.ts";

/** The bits of a Bun client WebSocket this file touches (never Bun's own types). */
export interface RelaySocket {
  send(data: string): void;
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
  setOnMessage(handler: (data: string) => void): void;
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

export interface RunningRelayLink {
  /** The id our secret derives (the relay confirms it; the address is built from it). */
  readonly id: string;
  /** The phone-facing address this daemon would be reached at (`<url>/d/<id>/e2e`). */
  readonly address: string;
  /** Is the control socket registered right now? (tests and `serve`'s own logging) */
  isConnected(): boolean;
  /** Open sockets: control (0/1) + one per live stream. */
  openStreams(): number;
  /** Stop: control and every accept leg closed, timers cleared. Idempotent. */
  stop(): void;
}

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

  /** Tear the control socket down WITHOUT scheduling anything (a caller decides). */
  const dropControl = (): void => {
    const current = control;
    control = undefined;
    connected = false;
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
    const retry = relayRetryAfter(reason, attempt, seeds);
    attempt = nextAttempt(reason, attempt);
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
      const frame = parseFrame(data);
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
        // earn a 60 s first retry (relay-link-policy's `nextAttempt`).
        attempt = 0;
        noticed = new Set();
        audit(`relay-ready ${id.slice(0, 8)}`);
        startLiveness(host);
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
      if (frame.t === "open") {
        openStream(host, frame.stream, frame.ip);
        return;
      }
      // `ping` is a daemon→relay frame; receiving one is nonsense but harmless.
      void ready;
    });
    host.setOnClose((info) => {
      if (control !== host) {
        return;
      }
      // An oversize close is Bun telling us it gave up on a frame: F7's fallback
      // is an ordinary (jittered) backoff, never an immediate redial into the
      // same allocation.
      schedule(oversizeHint(info) ? "oversize" : "closed");
      dropControl();
      // The relay unregisters the id when the control socket goes, so every
      // stream is already dead on its phone's side (F2); our legs follow.
      dropStreams();
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
    let onMessage: ((data: string) => void) | undefined;
    let onClose: (() => void) | undefined;
    let released = false;
    /** The device path's teardown, idempotent (it stops the watcher and drops the handle). */
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      release();
    };
    const channel: DuplexChannel = {
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
    let onOpen: (() => void) | undefined;
    let onMessage: ((data: string) => void) | undefined;
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
      onMessage?.(String(event.data));
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
