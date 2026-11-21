/**
 * The relay service's sockets (docs/feat/mobile-relay.md R2). Everything here is
 * transport only: parse a frame, hand it to `RelayCore`, apply what it decided,
 * splice two legs. Every DECISION (register, newest-wins, hold, expiry, limits)
 * is in `relay-core.ts`, pure and unit-tested — this file must stay thin enough
 * that reading it teaches you nothing about policy (AGENTS §7).
 *
 * Routes:
 *   `/v1/daemon`     a daemon's CONTROL socket: `hello` → `ready`, `ping` → `pong`
 *   `/v1/accept`     the data leg for a stream the relay announced
 *   `/d/<id>/e2e`    a phone's leg (any Origin: the relay authorises nobody)
 *   `/healthz`       200 + the version, and no counters (deploy smoke test)
 *   anything else    404
 *
 * **The relay is not trusted** (AGENTS §7): it holds no key, verifies no peer and
 * authorises nothing. The daemon's Noise responder authenticates every stream, so
 * all this service can ever hand anyone is a socket.
 *
 * Shape (Owner Q3): one control socket per daemon, one data socket per phone
 * stream — no multiplexing, so backpressure, close and size limits are per stream
 * and come from Bun (R0(a) proved frames splice 1:1 and a close cascades).
 */
import {
  RELAY_CLOSE_UNREGISTERED,
  RELAY_CONTROL_LIMITS,
  RELAY_PROTOCOL_VERSION,
  RelayDaemonFrameSchema,
  type RelayFeature,
  type RelayLiveActivityFrame,
  type RelayPushFrame,
  type RelayToDaemonFrame,
  isInboundFrameTooLarge,
  isRelayId,
} from "@tentacle/protocol";
import type { ApnsClient } from "./apns-client.ts";
import { type ApnsJwtSource, apnsPayloadBytesOf, liveActivityPayloadOf } from "./apns.ts";
import { clientIpOf, limiterKeyOf } from "./client-ip.ts";
import { createLogLimiter } from "./log-limit.ts";
import {
  RELAY_CLOSE_REFUSED,
  RelayCore,
  type RelayEffect,
  type RelayLimits,
} from "./relay-core.ts";

/** The relay's default bind: loopback, because Caddy terminates TLS in front of it (R7). */
export const DEFAULT_RELAY_HOST = "127.0.0.1";
/** The port the R7 systemd unit and Caddy site block use. */
export const DEFAULT_RELAY_PORT = 4100;
/** How often the held-dial sweep runs (pure in the core; this is only the tick). */
export const DEFAULT_SWEEP_MS = 250;
/** How long a leg silent this long is closed (the `serve` policy, `ws-server.ts`). */
export const DEFAULT_RELAY_IDLE_TIMEOUT_SEC = 60;

export interface RelayServerOptions {
  readonly host?: string;
  readonly port?: number;
  /** Abuse-limit overrides (`--max-dials-per-minute`, or a test shortening one). */
  readonly limits?: Partial<RelayLimits>;
  /** Injectable clock and token source, as the core takes them (tests own both). */
  readonly now?: () => number;
  readonly mintToken?: () => string;
  /** One line per event — id prefixes only, never a secret, a payload or a full token. */
  readonly onLog?: (line: string) => void;
  readonly sweepMs?: number;
  readonly idleTimeoutSec?: number;
  /**
   * Read `X-Forwarded-For` from a LOOPBACK peer and key the limits on the real
   * client (`client-ip.ts`, H3). Off by default: without it the relay behaves
   * exactly as it did and the header is not read at all.
   */
  readonly trustProxy?: boolean;
  /**
   * The APNs delivery path, present only when the relay started with a readable
   * APNs key (docs/feat/mobile-push.md Design 4, C1). Absent = the relay announces
   * no `"push"` feature and refuses a `push` frame, so an unconfigured relay can
   * never accept a push it would silently drop (F4).
   */
  readonly apns?:
    | {
        readonly client: ApnsClient;
        readonly jwtSource: ApnsJwtSource;
        readonly topic: string;
      }
    | undefined;
  /**
   * Which features to announce, overriding the "everything the APNs path can do"
   * default. A DEPLOY knob: it is how the relay is rolled out in two steps (push
   * first, Live Activities once Apple's console is ready — task 18's D4a), so no
   * daemon is invited to send a frame the deployed relay would not carry. `undefined`
   * = announce every feature the APNs path enables (the usual case).
   */
  readonly features?: readonly RelayFeature[];
}

export interface RunningRelay {
  readonly url: string;
  readonly port: number;
  /** Run one sweep now (a test drives time instead of waiting for a tick). */
  sweep(): void;
  /** The core, for a test's assertions about state (never for the wire). */
  readonly core: RelayCore;
  stop(): void;
}

/** Where a request path lands — pure, so the routing table is pinned without a socket. */
export type RelayRoute =
  | { readonly kind: "health" }
  | { readonly kind: "control" }
  | { readonly kind: "accept" }
  | { readonly kind: "phone"; readonly id: string }
  | { readonly kind: "notfound" };

/** The phone route's frozen shape (an installed app dials it: never change it). */
const PHONE_PREFIX = "/d/";
const PHONE_SUFFIX = "/e2e";

/**
 * Resolve a request path to a route. `/d/<id>/e2e` is matched EXACTLY (a deeper
 * path is a 404, not a phone): the shape is frozen across relay versions because
 * an app installed today dials it (F13).
 */
export function relayRoute(pathname: string): RelayRoute {
  if (pathname === "/healthz") {
    return { kind: "health" };
  }
  if (pathname === "/v1/daemon") {
    return { kind: "control" };
  }
  if (pathname === "/v1/accept") {
    return { kind: "accept" };
  }
  if (pathname.startsWith(PHONE_PREFIX) && pathname.endsWith(PHONE_SUFFIX)) {
    const id = pathname.slice(PHONE_PREFIX.length, -PHONE_SUFFIX.length);
    if (isRelayId(id)) {
      return { kind: "phone", id };
    }
  }
  return { kind: "notfound" };
}

/**
 * The socket options, the `serve` policy verbatim (`packages/daemon/src/ws-server.ts`
 * `socketOptions`): pings on, an idle leg closed, and a leg that stops reading
 * closed at the backpressure ceiling rather than silently skipping frames — a
 * closed leg detaches the phone, which resyncs when it returns (F18).
 */
export function relaySocketOptions(options: Pick<RelayServerOptions, "idleTimeoutSec">): {
  backpressureLimit: number;
  closeOnBackpressureLimit: true;
  idleTimeout: number;
  sendPings: true;
  maxPayloadLength: number;
  perMessageDeflate: false;
} {
  return {
    backpressureLimit: RELAY_CONTROL_LIMITS.backpressureBytes,
    closeOnBackpressureLimit: true,
    idleTimeout: options.idleTimeoutSec ?? DEFAULT_RELAY_IDLE_TIMEOUT_SEC,
    sendPings: true,
    // H1: WITHOUT this, Bun allocates a frame (16 MiB by default) BEFORE any
    // handler runs, so every app-level size check below runs too late to save
    // the memory — ~32 parallel 16 MiB frames reach `MemoryMax=512M`
    // (`relay.service`) and the OOM kill drops every daemon and stream, with no
    // authentication needed. 96 KiB is above the largest legitimate frame (a
    // raw Noise message ≤ 65 535 B, +1 version byte in the handshake; a legacy
    // v1 `t1:` text frame ≤ ~87.4 Ki chars), so nothing real is cut. It bounds
    // binary messages too, whole or fragmented (docs/feat/noise-binary-carrier.md).
    maxPayloadLength: RELAY_CONTROL_LIMITS.maxFrameChars,
    // Pinned, not left to the default: a compression bomb is the one way a
    // bounded payload can still expand, and nothing here compresses.
    perMessageDeflate: false,
  };
}

/** The 8-character prefix a log line may carry (a token or id is never logged whole). */
export function logPrefix(value: string): string {
  return value.slice(0, 8);
}

/**
 * An APNs `reason`, bounded for the log (L1): Apple's real reasons are one short
 * word (`BadDeviceToken`, `ExpiredProviderToken`, …), and the outcome's own
 * reasons (`timeout`, …) have the same shape. Anything outside a 64-character
 * `[A-Za-z0-9_.:-]` word is logged as `other` — a reason is remote input, and a
 * log line must not be able to grow, or to carry a newline, at Apple's choice.
 */
export function loggableApnsReason(reason: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(reason) ? reason : "other";
}

type Role = "control" | "accept" | "phone";

interface SocketData {
  /** The core's opaque handle for this socket (it never sees a Bun socket). */
  readonly key: string;
  readonly role: Role;
  /**
   * The peer address as the relay saw it — the rate-limit key only. Untrusted by
   * definition (it is sent to the daemon as `open.ip` and used nowhere else).
   */
  readonly ip: string;
  /** The phone's target id / the accept leg's stream token, once known. */
  id?: string;
  token?: string;
  /** Closed by the relay itself, so `close` does not read it as a peer drop. */
  done?: boolean;
}

/** The bits of Bun's server socket this file touches. */
interface RelaySocket {
  readonly data: SocketData;
  send(data: DataFrame): number;
  close(code?: number, reason?: string): void;
}

/**
 * A data-leg frame, forwarded opaquely as it came: binary (E2E v2's raw Noise
 * messages) AND text (a v1 `t1:` pair until it updates) — permanently, so the
 * relay never interprets a data frame nor needs a redeploy for a channel change
 * (docs/feat/noise-binary-carrier.md §4).
 */
type DataFrame = string | Uint8Array;

/** A frame's size: characters of text, bytes of binary (what Bun's `maxPayloadLength` counts). */
const sizeOf = (frame: DataFrame): number =>
  typeof frame === "string" ? frame.length : frame.byteLength;

interface PeerAddressable {
  requestIP(req: Request): { readonly address: string } | null;
}

/** A phone's buffered pre-accept frames and their total size (`sizeOf`). */
interface Buffered {
  readonly frames: DataFrame[];
  chars: number;
}

export function startRelay(options: RelayServerOptions = {}): RunningRelay {
  // The limiter shares the relay's clock, so a test that drives time also
  // drives the log window (and the real relay uses `Date.now` throughout).
  const logLimiter = createLogLimiter(options.now === undefined ? {} : { now: options.now });
  // Every event line goes through the limiter (M4): the first ones of each kind
  // per window always pass, the rest are counted and reported by `flush` on the
  // sweep tick. Without it a refusal flood fills the journal, and journald's own
  // rate limit then drops lines without choosing — `ready` ones included.
  const onLog = options.onLog ?? (() => {});
  const log = (line: string): void => {
    if (logLimiter.admit(line)) {
      onLog(line);
    }
  };
  const core = new RelayCore({
    ...(options.now ? { now: options.now } : {}),
    ...(options.mintToken ? { mintToken: options.mintToken } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
    // `"push"` / `"liveactivity"` are announced only when the delivery path
    // exists: a daemon sends such a frame only to a relay that said so (C1).
    features: options.features ?? (options.apns === undefined ? [] : ["push", "liveactivity"]),
  });

  let counter = 0;
  const sockets = new Map<string, RelaySocket>();
  /** A phone's early frames, waiting for the daemon's accept leg. */
  const buffered = new Map<string, Buffered>();
  /** The two legs of a spliced stream, both ways. */
  const peers = new Map<string, string>();

  const send = (target: string, frame: RelayToDaemonFrame): void => {
    const socket = sockets.get(target);
    if (socket === undefined || socket.data.done) {
      return;
    }
    socket.send(JSON.stringify(frame));
  };

  const apply = (effects: readonly RelayEffect[]): void => {
    for (const effect of effects) {
      if (effect.kind === "send") {
        send(effect.target, effect.frame);
      } else {
        closeSocket(effect.target, effect.code);
      }
    }
  };

  const closeSocket = (key: string, code?: number): void => {
    const socket = sockets.get(key);
    if (socket === undefined) {
      sockets.delete(key);
      buffered.delete(key);
      return;
    }
    socket.data.done = true;
    socket.close(code);
  };

  /** Close both legs of a stream (the peer map is symmetric). */
  const closeBoth = (key: string, code?: number): void => {
    const peer = peers.get(key);
    peers.delete(key);
    if (peer !== undefined) {
      peers.delete(peer);
    }
    closeSocket(key, code);
    if (peer !== undefined) {
      closeSocket(peer, code);
    }
  };

  const splice = (a: string, b: string): void => {
    peers.set(a, b);
    peers.set(b, a);
  };

  /** Forward one frame to the other leg, or buffer it (a phone whose daemon has not accepted yet). */
  const forward = (from: string, frame: DataFrame): void => {
    const peer = peers.get(from);
    if (peer !== undefined) {
      const socket = sockets.get(peer);
      if (socket !== undefined && !socket.data.done) {
        socket.send(frame);
      }
      return;
    }
    const held = buffered.get(from);
    if (held === undefined) {
      return;
    }
    held.chars += sizeOf(frame);
    if (held.chars > RELAY_CONTROL_LIMITS.preAcceptBytes) {
      // More than a Noise message 1 before the daemon even accepted: not a peer
      // worth holding a socket for. Closing is the only honest answer.
      log(`phone-oversize-drop ${logPrefix(from)}`);
      closeSocket(from, RELAY_CLOSE_UNREGISTERED);
      buffered.delete(from);
      core.phoneClosed(from);
      return;
    }
    held.frames.push(frame);
  };

  /** Give a waiting phone its accept leg: splice, then flush what it sent early. */
  const join = (acceptKey: string, phoneKey: string): void => {
    splice(acceptKey, phoneKey);
    const held = buffered.get(phoneKey);
    buffered.delete(phoneKey);
    const accept = sockets.get(acceptKey);
    if (held === undefined || accept === undefined) {
      return;
    }
    for (const frame of held.frames) {
      accept.send(frame);
    }
  };

  const server = Bun.serve<SocketData>({
    hostname: options.host ?? DEFAULT_RELAY_HOST,
    port: options.port ?? DEFAULT_RELAY_PORT,
    fetch(req, srv) {
      const route = relayRoute(new URL(req.url).pathname);
      if (route.kind === "health") {
        // No counters: a public endpoint must not tell a stranger how big the
        // relay's registry is.
        return Response.json({ ok: true, v: RELAY_PROTOCOL_VERSION });
      }
      if (route.kind === "notfound") {
        return new Response("not found", { status: 404 });
      }
      counter += 1;
      const key = `s${counter}`;
      // H3: behind the loopback proxy the direct peer is always 127.0.0.1, so
      // the per-IP limits collapsed into ONE bucket. `clientIpOf` takes the real
      // client from `X-Forwarded-For` — only from a loopback peer, only when
      // opted in, and only the right-most untrusted hop — and `limiterKeyOf`
      // collapses an IPv6 client to its /64 (M3: 2^64 buckets was no limit).
      const ip = limiterKeyOf(
        clientIpOf({
          peer: (srv as unknown as PeerAddressable).requestIP(req)?.address ?? "",
          forwardedFor: req.headers.get("x-forwarded-for"),
          trustProxy: options.trustProxy === true,
        }),
      );
      const role: Role =
        route.kind === "phone" ? "phone" : route.kind === "accept" ? "accept" : "control";
      const data: SocketData = {
        key,
        role,
        ip,
        ...(route.kind === "phone" ? { id: route.id } : {}),
      };
      if (srv.upgrade(req, { data })) {
        return undefined;
      }
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      ...relaySocketOptions(options),
      open(ws) {
        sockets.set(ws.data.key, ws as unknown as RelaySocket);
        if (ws.data.role !== "phone") {
          // H2: a `/v1/daemon` or `/v1/accept` socket is admitted here, before
          // it has said anything, and settles when it does (`hello` / `accept`)
          // or dies at `RELAY_PREAUTH_MS`. Past `pendingPerIp` it is refused —
          // a stranger with a loop must not take the fd, nor a slot a real
          // daemon could have used.
          const admitted = core.admitPending({ socket: ws.data.key, ip: ws.data.ip });
          if (!admitted.ok) {
            log(`pending-refused ${logPrefix(ws.data.key)}`);
            closeSocket(ws.data.key, RELAY_CLOSE_REFUSED);
            return;
          }
        }
        if (ws.data.role === "phone") {
          const ip = ws.data.ip;
          const id = ws.data.id ?? "";
          buffered.set(ws.data.key, { frames: [], chars: 0 });
          const decision = core.dial({ socket: ws.data.key, ip, id });
          if (!decision.ok) {
            log(`dial-refused ${decision.reason} ${logPrefix(id)}`);
            buffered.delete(ws.data.key);
            // NOT `core.phoneClosed`: a refused dial never took a slot, so
            // returning one here would free a slot another phone holds.
            closeSocket(ws.data.key, RELAY_CLOSE_REFUSED);
            return;
          }
          if (decision.state === "held") {
            log(`dial-held ${logPrefix(id)}`);
          } else {
            // L1: the stream token's prefix is NOT logged. It correlates
            // nothing once the 10 s expiry has passed, and it is a secret-shaped
            // value in a long-lived log; the id prefix is what an operator needs.
            log(`dial-open ${logPrefix(id)}`);
          }
          apply(decision.effects);
        }
      },
      message(ws, message) {
        const key = ws.data.key;
        // Binary is forwarded as the same bytes (a view, no copy, no decode).
        const frame: DataFrame =
          typeof message === "string"
            ? message
            : new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
        if (ws.data.role === "control") {
          if (typeof frame !== "string") {
            // The control socket carries JSON text frames only: binary is not guessed at.
            log(`binary-frame ${logPrefix(key)}`);
            closeBoth(key, 1003);
            return;
          }
          onControl(ws as unknown as RelaySocket, frame);
          return;
        }
        if (ws.data.role === "accept") {
          onAcceptLeg(key, frame);
          return;
        }
        if (sizeOf(frame) > RELAY_CONTROL_LIMITS.maxFrameChars) {
          // A legit frame never reaches this (Bun's `maxPayloadLength` refuses it
          // first; a Noise frame is ≤ 65 536 B, a v1 one ~87.4 Ki chars): past
          // it, both legs go, and the phone resyncs on its next dial.
          log(`frame-oversize ${logPrefix(key)}`);
          closeBoth(key, RELAY_CLOSE_UNREGISTERED);
          return;
        }
        forward(key, frame);
      },
      close(ws) {
        const key = ws.data.key;
        sockets.delete(key);
        buffered.delete(key);
        if (ws.data.role === "control") {
          core.controlClosed(key);
          return;
        }
        const peer = peers.get(key);
        peers.delete(key);
        if (peer !== undefined) {
          peers.delete(peer);
          closeSocket(peer);
        }
        if (ws.data.role === "phone") {
          core.phoneClosed(key);
        } else if (ws.data.token !== undefined) {
          core.streamClosed(ws.data.token);
        } else {
          // An accept leg that never carried a token: it was only pre-auth.
          core.pendingClosed(key);
        }
      },
    },
  });

  /** A control socket's frame: `hello` (register), `ping` (liveness), nothing else. */
  function onControl(ws: RelaySocket, text: string): void {
    const key = ws.data.key;
    if (isInboundFrameTooLarge(text)) {
      // The DECODE guard (R1): the string is already allocated, so this bounds
      // the parse, not the memory. A daemon leg never legitimately reaches it.
      log(`control-oversize ${logPrefix(key)}`);
      closeSocket(key, 1009);
      return;
    }
    const parsed = parseFrame(text);
    if (parsed === undefined) {
      log(`control-malformed ${logPrefix(key)}`);
      closeSocket(key, 1008);
      return;
    }
    if (parsed.t === "ping") {
      const registered = core.idOfControl(key) !== undefined;
      if (!registered) {
        // M1: nothing but `hello` before `ready`. A pre-`ready` ping used to be
        // answered, which let an unauthenticated socket accumulate pongs in its
        // backpressure buffer and (with the pre-auth gap, H2) keep itself alive.
        log(`control-unexpected ${logPrefix(key)} ping`);
        closeSocket(key, 1008);
        return;
      }
      apply(core.ping({ socket: key }));
      return;
    }
    if (parsed.t === "push") {
      onPush(ws, parsed);
      return;
    }
    if (parsed.t === "liveactivity") {
      onLiveActivity(ws, parsed);
      return;
    }
    if (parsed.t !== "hello") {
      // `accept` belongs on `/v1/accept` (which carries no other frame): a frame
      // on the wrong socket is a client bug, and closing names it.
      log(`control-unexpected ${logPrefix(key)} ${parsed.t}`);
      closeSocket(key, 1008);
      return;
    }
    const decision = core.hello({
      socket: key,
      ip: ws.data.ip,
      v: parsed.v,
      secret: parsed.secret,
    });
    if (!decision.ok) {
      log(`hello-refused ${logPrefix(key)}`);
      apply(decision.effects);
      return;
    }
    log(`ready ${logPrefix(decision.id ?? "")}`);
    apply(decision.effects);
  }

  /**
   * A daemon's `push`: the core decides whether this socket may push (it must be
   * registered) and whether the caps allow it; this delivers it through the APNs
   * client and answers `push-result` with the same `n`.
   *
   * The answer goes to the socket that asked, always — including after a
   * delivery that outlived the socket (a send on a closed socket is dropped by
   * `send`, which is why a late answer cannot resurrect it). Pushes run
   * CONCURRENTLY: one slow APNs request must not delay the next, and several are
   * in flight at once by design (`n` correlates them).
   */
  function onPush(ws: RelaySocket, frame: RelayPushFrame): void {
    const key = ws.data.key;
    let payloadBytes: number;
    try {
      // The body is built HERE so the 4096-byte bound is checked before the core
      // records anything: an oversized push is refused, never truncated.
      payloadBytes = apnsPayloadBytesOf(frame.payload);
    } catch {
      log(`push-rejected ${logPrefix(key)} payload`);
      apply([core.pushResult(key, { n: frame.n, status: "rejected", reason: "payload" })]);
      return;
    }
    const decision = core.push({ socket: key, ...frame, payloadBytes });
    if (!decision.ok) {
      log(`push-refused ${logPrefix(key)} ${decision.status} ${decision.reason}`);
      apply(decision.effects);
      return;
    }
    const apns = options.apns;
    if (apns === undefined) {
      // Unreachable (the core refuses a push without the feature), kept honest.
      apply([core.pushResult(key, { n: frame.n, status: "unavailable", reason: "no-push" })]);
      return;
    }
    void apns.client.send(decision.request).then((outcome) => {
      // No key, no JWT and no payload in this line: the token is an 8-char prefix.
      // The reason is Apple's own word, BOUNDED here (`^[A-Za-z]{1,64}$`) because
      // a reason is remote input and the log is long-lived (L1): anything else
      // is logged as `other`, never at its own length.
      log(
        `push ${logPrefix(decision.request.token)} ${outcome.status}${
          outcome.reason === undefined ? "" : ` ${loggableApnsReason(outcome.reason)}`
        }`,
      );
      apply([
        core.pushResult(key, {
          n: decision.request.n,
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        }),
      ]);
    });
  }

  /**
   * A daemon's `liveactivity` frame (docs/feat/mobile-live-activity.md L4): the
   * core decides whether this socket may push an activity and at what priority;
   * this delivers it through the APNs client and answers `push-result` with the
   * same `n` — the SAME answer vocabulary as a push, so a daemon audits both the
   * same way.
   *
   * The body's size is measured HERE, before the core records anything, exactly
   * as a push's is: an oversized activity is refused, never truncated. Runs
   * concurrently with every other push for the same reason.
   */
  function onLiveActivity(ws: RelaySocket, frame: RelayLiveActivityFrame): void {
    const key = ws.data.key;
    let payloadBytes: number;
    try {
      payloadBytes = new TextEncoder().encode(liveActivityPayloadOf(frame.la, Date.now())).length;
    } catch {
      // An unbounded date or a missing content-state: refused, never sent.
      log(`liveactivity-rejected ${logPrefix(key)} payload`);
      apply([core.pushResult(key, { n: frame.n, status: "rejected", reason: "payload" })]);
      return;
    }
    const decision = core.liveActivity({ socket: key, ...frame, payloadBytes });
    if (!decision.ok) {
      log(`liveactivity-refused ${logPrefix(key)} ${decision.status} ${decision.reason}`);
      apply(decision.effects);
      return;
    }
    const apns = options.apns;
    if (apns === undefined) {
      // Unreachable (the core refuses without the feature), kept honest.
      apply([
        core.pushResult(key, { n: frame.n, status: "unavailable", reason: "no-liveactivity" }),
      ]);
      return;
    }
    void apns.client.sendLiveActivity(decision.request).then((outcome) => {
      // No token beyond 8 chars and no payload: an activity's `content-state` is
      // sealed content-adjacent bytes, so logging it would archive them (L5's
      // canary rule, as for a push).
      log(
        `liveactivity ${logPrefix(decision.request.token)} ${outcome.status}${
          outcome.reason === undefined ? "" : ` ${loggableApnsReason(outcome.reason)}`
        }`,
      );
      apply([
        core.pushResult(key, {
          n: decision.request.n,
          status: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        }),
      ]);
    });
  }

  /** The accept leg's first frame is the token; after that the socket is raw. */
  function onAcceptLeg(key: string, frame: DataFrame): void {
    if (peers.has(key)) {
      if (sizeOf(frame) > RELAY_CONTROL_LIMITS.maxFrameChars) {
        log(`frame-oversize ${logPrefix(key)}`);
        closeBoth(key, RELAY_CLOSE_UNREGISTERED);
        return;
      }
      forward(key, frame);
      return;
    }
    if (typeof frame !== "string") {
      // Before its token the accept leg carries the JSON `accept` frame only.
      log(`binary-frame ${logPrefix(key)}`);
      closeBoth(key, 1003);
      return;
    }
    const text = frame;
    if (isInboundFrameTooLarge(text)) {
      log(`accept-oversize ${logPrefix(key)}`);
      closeSocket(key, 1009);
      return;
    }
    const parsed = parseFrame(text);
    if (parsed === undefined || parsed.t !== "accept") {
      log(`accept-malformed ${logPrefix(key)}`);
      closeSocket(key, 1008);
      return;
    }
    const decision = core.accept({ socket: key, token: parsed.stream, v: parsed.v });
    if (!decision.ok) {
      // L1: `accept-refused` echoed a prefix the ATTACKER chose, on every guess.
      log(`accept-refused ${decision.reason}`);
      if (decision.reason === "expired") {
        // The stream expired unaccepted: its phone is closed `4404` too, so the
        // app retries another address instead of waiting out its idle timeout.
        apply(decision.effects);
      }
      closeSocket(key, RELAY_CLOSE_UNREGISTERED);
      return;
    }
    const socket = sockets.get(key);
    if (socket !== undefined) {
      socket.data.token = decision.token;
    }
    log(`accept ${logPrefix(decision.id)}`);
    join(key, decision.phone);
  }

  const timer = setInterval(() => {
    apply(core.sweep());
    // What the log limiter hid is never silent: one line per kind, per window.
    for (const line of logLimiter.flush()) {
      log(line);
    }
  }, options.sweepMs ?? DEFAULT_SWEEP_MS);
  // Never hold the process open for the tick alone.
  if (typeof timer === "object" && timer !== null && "unref" in timer) {
    (timer as { unref(): void }).unref();
  }

  return {
    url: `ws://${options.host ?? DEFAULT_RELAY_HOST}:${server.port}`,
    port: server.port,
    core,
    sweep() {
      apply(core.sweep());
      for (const line of logLimiter.flush()) {
        log(line);
      }
    },
    stop() {
      clearInterval(timer);
      options.apns?.client.close();
      server.stop(true);
    },
  };
}

/** Parse one control frame, or `undefined` (a malformed frame is a close, never a guess). */
function parseFrame(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = RelayDaemonFrameSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** The limits a flag may override, for `main.ts`'s `--help` and its validation. */
export const RELAY_LIMIT_FLAGS = [
  "max-dials-per-minute",
  "max-streams-per-ip",
  "max-streams-per-id",
  "max-ids",
  "max-ids-per-ip",
  "max-hellos-per-minute",
  "max-pushes-per-minute",
  "max-pushes-per-token-per-minute",
] as const;

export type RelayLimitFlag = (typeof RELAY_LIMIT_FLAGS)[number];

/** Map one limit flag onto the core's limits (pure: the parse validates, this applies). */
export function limitsFromFlags(
  flags: Partial<Record<RelayLimitFlag, number>>,
): Partial<RelayLimits> {
  const limits: { -readonly [K in keyof RelayLimits]?: number } = {};
  if (flags["max-dials-per-minute"] !== undefined) {
    limits.dialsPerMinutePerIp = flags["max-dials-per-minute"];
  }
  if (flags["max-streams-per-ip"] !== undefined) {
    limits.concurrentPerIp = flags["max-streams-per-ip"];
  }
  if (flags["max-streams-per-id"] !== undefined) {
    limits.streamsPerId = flags["max-streams-per-id"];
  }
  if (flags["max-ids"] !== undefined) {
    limits.registeredIds = flags["max-ids"];
  }
  if (flags["max-ids-per-ip"] !== undefined) {
    limits.registeredPerIp = flags["max-ids-per-ip"];
  }
  if (flags["max-hellos-per-minute"] !== undefined) {
    limits.hellosPerMinutePerIp = flags["max-hellos-per-minute"];
  }
  if (flags["max-pushes-per-minute"] !== undefined) {
    limits.pushesPerMinutePerId = flags["max-pushes-per-minute"];
  }
  if (flags["max-pushes-per-token-per-minute"] !== undefined) {
    limits.pushesPerMinutePerToken = flags["max-pushes-per-token-per-minute"];
  }
  return limits;
}
