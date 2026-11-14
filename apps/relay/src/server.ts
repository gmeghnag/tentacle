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
  type RelayToDaemonFrame,
  isInboundFrameTooLarge,
  isRelayId,
} from "@tentacle/protocol";
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
} {
  return {
    backpressureLimit: RELAY_CONTROL_LIMITS.backpressureBytes,
    closeOnBackpressureLimit: true,
    idleTimeout: options.idleTimeoutSec ?? DEFAULT_RELAY_IDLE_TIMEOUT_SEC,
    sendPings: true,
  };
}

/** The 8-character prefix a log line may carry (a token or id is never logged whole). */
export function logPrefix(value: string): string {
  return value.slice(0, 8);
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
  send(data: string): number;
  close(code?: number, reason?: string): void;
}

interface PeerAddressable {
  requestIP(req: Request): { readonly address: string } | null;
}

/** A buffered pre-accept phone frame and its size in characters. */
interface Buffered {
  readonly frames: string[];
  chars: number;
}

export function startRelay(options: RelayServerOptions = {}): RunningRelay {
  const log = options.onLog ?? (() => {});
  const core = new RelayCore({
    ...(options.now ? { now: options.now } : {}),
    ...(options.mintToken ? { mintToken: options.mintToken } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
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
  const forward = (from: string, text: string): void => {
    const peer = peers.get(from);
    if (peer !== undefined) {
      const socket = sockets.get(peer);
      if (socket !== undefined && !socket.data.done) {
        socket.send(text);
      }
      return;
    }
    const held = buffered.get(from);
    if (held === undefined) {
      return;
    }
    held.chars += text.length;
    if (held.chars > RELAY_CONTROL_LIMITS.preAcceptBytes) {
      // More than a Noise message 1 before the daemon even accepted: not a peer
      // worth holding a socket for. Closing is the only honest answer.
      log(`phone-oversize-drop ${logPrefix(from)}`);
      closeSocket(from, RELAY_CLOSE_UNREGISTERED);
      buffered.delete(from);
      core.phoneClosed(from);
      return;
    }
    held.frames.push(text);
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
      const ip = (srv as unknown as PeerAddressable).requestIP(req)?.address ?? "";
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
            log(`dial-open ${logPrefix(id)} ${logPrefix(decision.stream)}`);
          }
          apply(decision.effects);
        }
      },
      message(ws, message) {
        const key = ws.data.key;
        const text = typeof message === "string" ? message : undefined;
        if (text === undefined) {
          // Text only: the Noise channel's frames are `t1:` + base64 text, so a
          // binary frame is not ours and is not guessed at.
          log(`binary-frame ${logPrefix(key)}`);
          closeBoth(key, 1003);
          return;
        }
        if (ws.data.role === "control") {
          onControl(ws as unknown as RelaySocket, text);
          return;
        }
        if (ws.data.role === "accept") {
          onAcceptLeg(key, text);
          return;
        }
        if (text.length > RELAY_CONTROL_LIMITS.maxFrameChars) {
          // A legit frame never reaches this (the Noise cap is ~87.4 Ki chars):
          // past it, both legs go, and the phone resyncs on its next dial.
          log(`frame-oversize ${logPrefix(key)}`);
          closeBoth(key, RELAY_CLOSE_UNREGISTERED);
          return;
        }
        forward(key, text);
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
      send(key, { t: "pong" });
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

  /** The accept leg's first frame is the token; after that the socket is raw. */
  function onAcceptLeg(key: string, text: string): void {
    if (peers.has(key)) {
      if (text.length > RELAY_CONTROL_LIMITS.maxFrameChars) {
        log(`frame-oversize ${logPrefix(key)}`);
        closeBoth(key, RELAY_CLOSE_UNREGISTERED);
        return;
      }
      forward(key, text);
      return;
    }
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
      log(`accept-refused ${decision.reason} ${logPrefix(parsed.stream)}`);
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
    log(`accept ${logPrefix(decision.token)} ${logPrefix(decision.id)}`);
    join(key, decision.phone);
  }

  const timer = setInterval(() => {
    apply(core.sweep());
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
    },
    stop() {
      clearInterval(timer);
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
  "max-hellos-per-minute",
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
  if (flags["max-hellos-per-minute"] !== undefined) {
    limits.hellosPerMinutePerIp = flags["max-hellos-per-minute"];
  }
  return limits;
}
