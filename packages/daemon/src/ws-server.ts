/**
 * WebSocket binding for the daemon: a thin `Bun.serve` adapter that turns each
 * socket into a `DuplexChannel` feeding a `Connection`. Authentication (bearer
 * token, Origin allow-list) happens at the HTTP upgrade — rejected *before* the
 * socket opens. Binds loopback-only unless a token is configured.
 *
 * All the hard protocol logic lives in `Connection`/`RpcPeer`; this file only
 * bridges Bun's socket callbacks to the channel interface and enforces exposure.
 */
import { timingSafeEqual } from "node:crypto";
import { type CarrierFrame, carrierFrameOf } from "@tentacle/transport";
import { Connection, type HooksTrustPrecheck } from "./connection.ts";
import { DEFAULT_MAX_FRAME_BYTES, acceptDevice } from "./device-accept.ts";
import type { DeviceAuthority } from "./device-authority.ts";
import { type HandshakeLimitOptions, HandshakeLimiter } from "./handshake-limit.ts";
import type { SessionHost } from "./session-host.ts";

export interface WsServerOptions {
  readonly host: string;
  readonly port: number;
  readonly sessionHost: SessionHost;
  /** Bearer token required on the upgrade. Mandatory for a non-loopback bind. */
  readonly token?: string;
  /** If set, the `Origin` header must be one of these (blunts DNS-rebinding). */
  readonly allowedOrigins?: readonly string[];
  /** Serve `wss://` directly from this cert/key (PEM contents). */
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly onError?: (error: Error) => void;
  /** One line per connection open/close/auth-failure, for the operator. */
  readonly onAudit?: (line: string) => void;
  /**
   * Close a socket silent for this long (seconds, 1–960; default 60). Pings are
   * always on, so a healthy client's pong keeps it open however idle; a dead or
   * frozen peer is closed → its `Connection` detaches → the session's idle TTL
   * starts. Bun checks every 4 s: a silent peer goes at the first tick past it.
   */
  readonly idleTimeoutSec?: number;
  /** Max inbound frame size (bytes) accepted before parsing. */
  readonly maxFrameBytes?: number;
  /**
   * The host's own project-hooks answer, checked before the prompting client is
   * asked (docs/feat/serve-mcp.md S4). Every connection this server opens gets it.
   */
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
  /**
   * Bytes queued for one socket before the server CLOSES it (default 16 MiB).
   * Bun would otherwise drop frames silently and keep a frozen client's socket
   * open — a gap in its stream; closed, it detaches and resyncs on re-attach.
   * Keep it well above a session's replay ring (`ringBytes`, 4 MiB): an attach
   * sends the replay in one synchronous burst. A heuristic margin, not a
   * bound — the ring never evicts past the snapshot cut, sizes are JSON string
   * lengths (not wire bytes), and each frame adds an envelope — so a burst over
   * the limit closes even a healthy client, and one that reconnects
   * automatically would loop (to revisit with `client-reattach`).
   */
  readonly backpressureLimit?: number;
  /**
   * The device side (docs/feat/device-pairing.md 9b). ABSENT on every daemon
   * that is not a `serve` on the user's own host (a pod's stdio daemon, the
   * in-process worker), and `/e2e` is then just another path on the plain
   * route (F21). When present:
   *
   * - `/e2e` is the DEVICE route: the Noise handshake IS the authentication,
   *   so it needs no token and accepts the `Origin` a phone always sends
   *   (decision 2/3). An unregistered key reaches at most a pairing-only
   *   connection, so the Origin exemption grants a web page nothing;
   * - a non-loopback bind without a token is allowed (the plain route then
   *   answers 401 to everyone: only paired devices get in, owner Q1);
   * - the upgrade is rate limited before any crypto (F6).
   */
  readonly devices?: DeviceRouteOptions;
}

/** What the device route needs from the caller (a `serve` daemon). */
export interface DeviceRouteOptions {
  /**
   * The store-backed authority — it also carries the config dir its store lives
   * in (`authority.configDir`), so the two cannot be wired to disagree.
   */
  readonly authority: DeviceAuthority;
  /** Overrides for the handshake limiter (tests shorten the burst). */
  readonly handshakeLimit?: HandshakeLimitOptions;
  /**
   * How often a pairing-only connection checks that its window is still open
   * (`PAIRING_CHECK_MS` by default, in `device-accept.ts`). A pairing connection
   * is closed at the window's expiry, and at once when `pair` cleans the window
   * up (F16/F2).
   */
  readonly pairingCheckMs?: number;
  /**
   * This serve's public id (docs/feat/mobile-projects.md §5, Owner Q5): the
   * device route also answers `/s/<serveId>/e2e`, and a `/s/<other>/e2e` is a
   * 404 BEFORE any upgrade — a stale direct address that now lands on another
   * project's serve reads "not here", never a Noise deny the phone would show
   * as "access removed". Absent = only the bare `/e2e`.
   */
  readonly serveId?: string;
}

/** The device route's path: a phone dials `<address>/e2e`. */
export const DEVICE_ROUTE = "/e2e";

/**
 * Which way the device route takes `pathname` (pure, so the 404 rule is tested
 * without a socket): `device` = this serve's route (`/e2e`, or `/s/<mine>/e2e`),
 * `elsewhere` = a serve-scoped path naming ANOTHER serve (404, no upgrade),
 * `none` = not a device path at all (the plain route decides).
 */
export function deviceRouteOf(
  pathname: string,
  serveId: string | undefined,
): "device" | "elsewhere" | "none" {
  if (pathname === DEVICE_ROUTE) {
    return "device";
  }
  const scoped = /^\/s\/([^/]+)\/e2e$/.exec(pathname);
  if (scoped === null) {
    return "none";
  }
  return serveId !== undefined && scoped[1] === serveId ? "device" : "elsewhere";
}
/** The bits of Bun's server socket the route touches (its `data` is our `SocketData`). */
interface WsSocket {
  readonly data: SocketData;
}

/** Bun's `Server` as far as the route needs it (the peer address for the limiter). */
interface PeerAddressable {
  requestIP(req: Request): { readonly address: string } | null;
}

// Conservative per-connection defaults; a never-answering or abusive client is
// bounded without getting in a real client's way. All overridable per server.
export const DEFAULT_WS_IDLE_TIMEOUT_SEC = 60;
const DEFAULT_BACKPRESSURE_LIMIT = 16 * 1024 * 1024; // Bun's own default

/**
 * The socket-level options handed to `Bun.serve`'s `websocket` — pure, so the
 * keepalive/backpressure contract is pinned without a real socket.
 */
export function socketOptions(
  options: Pick<WsServerOptions, "backpressureLimit" | "idleTimeoutSec">,
): {
  backpressureLimit: number;
  closeOnBackpressureLimit: true;
  idleTimeout: number;
  sendPings: true;
} {
  return {
    // A client that stops reading (a frozen phone) must not get a silent gap
    // (Bun drops past the limit) nor stall the others (`send` never blocks):
    // close it → `Connection.close()` detaches → it resyncs when it returns.
    backpressureLimit: options.backpressureLimit ?? DEFAULT_BACKPRESSURE_LIMIT,
    closeOnBackpressureLimit: true,
    // Explicit, not Bun's defaults (120 s, pings on): pings are what keep an
    // idle healthy client attached — with them off it would be closed too.
    idleTimeout: options.idleTimeoutSec ?? DEFAULT_WS_IDLE_TIMEOUT_SEC,
    sendPings: true,
  };
}

export interface RunningServer {
  readonly url: string;
  readonly port: number;
  /**
   * The `/e2e` route's handshake limiter — the SAME instance the device route
   * charges (docs/feat/mobile-relay.md F7), so a relay stream and a direct
   * handshake share one `maxConcurrent`. `undefined` when the device route is off
   * (no relaying daemon then either).
   */
  readonly limiter?: HandshakeLimiter;
  stop(): void;
}

type WsChannel = WsEnd<string, string>;
type WsByteCarrier = WsEnd<CarrierFrame, Uint8Array>;

interface SocketData {
  /** The plain route's text channel. */
  channel: WsChannel | null;
  /** The device route's byte carrier (the Noise responder's input). */
  carrier?: WsByteCarrier;
  /**
   * Which route upgraded this socket. Set at the upgrade, never inferred in
   * `open`: both routes reach the same Bun server, and a plain client must
   * keep getting today's `Connection` (a device route on a loopback bind must
   * not change how the local CLI connects).
   */
  route?: "plain" | "device";
  /** The device route's teardown (unregister from the authority's live map). */
  release?: () => void;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Constant-time token comparison that also resists length leaks. */
export function tokensMatch(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Whether a connection's `Origin` is allowed. A browser always sends `Origin`;
 * native clients (the CLI's `WebSocket`) send none. With an allow-list, the
 * origin must be present and listed. WITHOUT one, any `Origin` is rejected — so
 * a web page cannot drive the daemon via a cross-site WebSocket (WS is exempt
 * from CORS), the CSRF / DNS-rebinding risk — while headerless native clients
 * still connect. This holds even on a loopback bind.
 */
export function originAllowed(origin: string | null, allowed?: readonly string[]): boolean {
  if (allowed && allowed.length > 0) {
    return origin !== null && allowed.includes(origin);
  }
  return origin === null;
}

function extractToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length);
  }
  try {
    return new URL(req.url).searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * One Bun server WebSocket as a channel: `WsEnd<string, string>` is the plain
 * route's text `DuplexChannel`; `WsEnd<CarrierFrame, Uint8Array>` the device
 * route's `ByteCarrier` (E2E v2: binary frames, docs/feat/noise-binary-carrier.md).
 */
class WsEnd<In, Out extends string | Uint8Array> {
  private onMessage?: (data: In) => void;
  private onClose?: () => void;
  private closed = false;
  constructor(private readonly ws: { send(data: Out): number; close(): void }) {}

  send(data: Out): void {
    if (!this.closed) {
      this.ws.send(data);
    }
  }
  close(): void {
    if (this.closed) {
      return;
    }
    this.ws.close();
  }
  setOnMessage(handler: (data: In) => void): void {
    this.onMessage = handler;
  }
  setOnClose(handler: () => void): void {
    this.onClose = handler;
  }
  /** Feed an inbound frame (called by the server's `message` handler). */
  deliver(data: In): void {
    this.onMessage?.(data);
  }
  /** Was this socket closed by either side (a `Connection` built after it is an orphan)? */
  isClosed(): boolean {
    return this.closed;
  }
  /** Signal close (called by the server's `close` handler). */
  fireClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose?.();
  }
}

/**
 * Start the WebSocket daemon. Refuses a non-loopback bind without a token.
 * Returns a handle with the resolved URL and a `stop()`.
 */
export function startWsServer(options: WsServerOptions): RunningServer {
  // A non-loopback bind is allowed when the device route is on: the plain route
  // then admits nobody without the token (it is 401'd below), and a paired
  // device authenticates by its own key. Without that route, today's rule stands.
  if (!isLoopbackHost(options.host) && !options.token && !options.devices) {
    throw new Error(
      `refusing to bind ${options.host} without a token: a non-loopback listener requires --token (remote code execution risk)`,
    );
  }

  const authorize = (req: Request): boolean => {
    // A NON-LOOPBACK listener with the device route on and no token admits
    // nobody on the plain route: only a paired device gets in (owner Q1).
    // Answering 401 (rather than 426) is also what tells an OLD app to update
    // (F23: it has no `/e2e`). A loopback bind keeps today's rule exactly: the
    // local CLI connects over it, and tightening that would break every
    // existing local client for a gain it does not need (the loopback path is
    // not reachable from the network).
    if (devices && !options.token && !isLoopbackHost(options.host)) {
      return false;
    }
    if (options.token) {
      const provided = extractToken(req);
      if (!provided || !tokensMatch(provided, options.token)) {
        return false;
      }
    }
    // Default-deny any browser `Origin` (WS is exempt from CORS, so a visited
    // web page could otherwise drive a loopback daemon — CSRF / DNS-rebinding).
    // Native clients send no Origin and stay allowed; see `originAllowed`.
    if (!originAllowed(req.headers.get("origin"), options.allowedOrigins)) {
      return false;
    }
    return true;
  };

  const connections = new WeakMap<object, Connection>();
  // A pending device handshake, before it becomes a `Connection` (P2: nothing is
  // built or recorded until the responder RESOLVES, so a replayed message 1
  // leaves no trace).
  const pending = new WeakMap<object, () => void>();
  const devices = options.devices;
  const limiter = devices ? new HandshakeLimiter(devices.handshakeLimit) : undefined;

  /**
   * The device route's upgrade: rate limit, then upgrade. No token, no Origin
   * check — the Noise handshake authenticates, and an unregistered key gets at
   * most a pairing-only connection, so a web page gains nothing by reaching here.
   */
  const deviceUpgrade = (
    req: Request,
    srv: PeerAddressable & { upgrade(req: Request, o: { data: SocketData }): boolean },
  ): Response | undefined => {
    if (!devices || !limiter) {
      return undefined;
    }
    const address = srv.requestIP(req)?.address ?? "";
    if (!limiter.begin(address)) {
      options.onAudit?.(`e2e-rate-limited ${address}`);
      return new Response("too many handshakes", { status: 429 });
    }
    if (srv.upgrade(req, { data: { channel: null, route: "device" } })) {
      return undefined;
    }
    // Not a websocket after all: the handshake it was charged for never ran.
    limiter.end();
    return new Response("expected a websocket upgrade", { status: 426 });
  };

  const server = Bun.serve<SocketData>({
    hostname: options.host,
    port: options.port,
    ...(options.tls ? { tls: { cert: options.tls.cert, key: options.tls.key } } : {}),
    fetch(req, srv) {
      if (devices) {
        const route = deviceRouteOf(new URL(req.url).pathname, devices.serveId);
        if (route === "device") {
          return deviceUpgrade(req, srv);
        }
        if (route === "elsewhere") {
          // Before the limiter and before any crypto (P8): "not this serve".
          return new Response("no such serve here", { status: 404 });
        }
      }
      if (!authorize(req)) {
        options.onAudit?.(`auth-failure ${new URL(req.url).pathname}`);
        return new Response("unauthorized", { status: 401 });
      }
      if (srv.upgrade(req, { data: { channel: null, route: "plain" } })) {
        return undefined;
      }
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      ...socketOptions(options),
      open(ws) {
        if (devices && ws.data.route === "device") {
          const carrier: WsByteCarrier = new WsEnd(ws);
          ws.data.carrier = carrier;
          openDevice(ws, carrier, devices);
          return;
        }
        const channel: WsChannel = new WsEnd(ws);
        ws.data.channel = channel;
        connections.set(
          ws,
          new Connection(channel, options.sessionHost, options.onError, {
            maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
            ...(options.hooksTrustPrecheck
              ? { hooksTrustPrecheck: options.hooksTrustPrecheck }
              : {}),
          }),
        );
        options.onAudit?.("connection-open");
      },
      message(ws, message) {
        const carrier = ws.data.carrier;
        if (carrier) {
          // As received: bytes (a view over Bun's buffer) or a text frame, which
          // the Noise layer diagnoses (a v1 app) — never stringified here.
          const frame = carrierFrameOf(message);
          if (frame === null) carrier.close();
          else carrier.deliver(frame);
          return;
        }
        ws.data.channel?.deliver(typeof message === "string" ? message : message.toString());
      },
      close(ws) {
        // A pending handshake ends its limiter slot exactly once (a denied or
        // timed-out responder never reaches a `Connection`).
        pending.get(ws)?.();
        pending.delete(ws);
        ws.data.release?.();
        ws.data.channel?.fireClose();
        ws.data.carrier?.fireClose();
        connections.get(ws)?.close();
        options.onAudit?.("connection-close");
      },
    },
  });

  /**
   * A `/e2e` socket: the device path itself lives in `acceptDevice`
   * (docs/feat/mobile-relay.md R3), so the SAME code serves this route and the
   * mobile relay's accept leg. What stays here is exactly what is Bun-socket
   * specific: the pending map the `close` handler drains (a slot ends once,
   * however the handshake ends) and the `connections` map this file's `close`
   * handler closes.
   */
  function openDevice(ws: WsSocket, channel: WsByteCarrier, route: DeviceRouteOptions): void {
    // ONE once-guard for the slot: a socket that closes mid-handshake ends it at
    // the close, and the responder's own reject (the close reaching it) must not
    // end it a second time — `HandshakeLimiter.end` would then count a handshake
    // that is still running as finished, admitting more than `maxConcurrent`.
    let ended = false;
    const endSlot = (): void => {
      if (ended) return;
      ended = true;
      pending.delete(ws);
      limiter?.end();
    };
    // Registered BEFORE the handshake starts: a socket that closes mid-handshake
    // must still end its slot, and `acceptDevice`'s no-identity path settles
    // synchronously (it never starts one).
    let release: () => void = () => {};
    pending.set(ws, () => {
      release();
      endSlot();
    });
    const accepted = acceptDevice(channel, {
      authority: route.authority,
      sessionHost: options.sessionHost,
      isClosed: () => channel.isClosed(),
      ...(options.onError ? { onError: options.onError } : {}),
      ...(options.onAudit ? { onAudit: options.onAudit } : {}),
      ...(options.maxFrameBytes !== undefined ? { maxFrameBytes: options.maxFrameBytes } : {}),
      ...(options.hooksTrustPrecheck ? { hooksTrustPrecheck: options.hooksTrustPrecheck } : {}),
      ...(route.pairingCheckMs !== undefined ? { pairingCheckMs: route.pairingCheckMs } : {}),
      onSettled: endSlot,
      onConnection: (connection) => connections.set(ws, connection),
    });
    release = accepted.release;
    ws.data.release = accepted.release;
  }

  const scheme = options.tls ? "wss" : "ws";
  return {
    url: `${scheme}://${options.host}:${server.port}`,
    port: server.port,
    ...(limiter ? { limiter } : {}),
    stop: () => server.stop(true),
  };
}
