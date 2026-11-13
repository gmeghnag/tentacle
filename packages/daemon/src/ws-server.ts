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
import type { DuplexChannel } from "@tentacle/transport";
import { type AuthorizeVerdict, noiseResponder, systemRandom } from "@tentacle/transport/noise";
import { Connection, type ConnectionPrincipal } from "./connection.ts";
import type { DeviceAllow, DeviceAuthority, DeviceClose } from "./device-authority.ts";
import { touchSeen } from "./device-store.ts";
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
}

/** The device route's path: a phone dials `<address>/e2e`. */
export const DEVICE_ROUTE = "/e2e";
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
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB
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
  stop(): void;
}

interface SocketData {
  channel: WsChannel | null;
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

/** A `DuplexChannel` backed by one Bun server WebSocket. */
class WsChannel implements DuplexChannel {
  private onMessage?: (data: string) => void;
  private onClose?: () => void;
  private closed = false;
  constructor(private readonly ws: { send(data: string): number; close(): void }) {}

  send(data: string): void {
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
  setOnMessage(handler: (data: string) => void): void {
    this.onMessage = handler;
  }
  setOnClose(handler: () => void): void {
    this.onClose = handler;
  }
  /** Feed an inbound frame (called by the server's `message` handler). */
  deliver(data: string): void {
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
      if (devices && new URL(req.url).pathname === DEVICE_ROUTE) {
        return deviceUpgrade(req, srv);
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
        const channel = new WsChannel(ws);
        ws.data.channel = channel;
        if (devices && ws.data.route === "device") {
          openDevice(ws, channel, devices);
          return;
        }
        connections.set(
          ws,
          new Connection(channel, options.sessionHost, options.onError, {
            maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
          }),
        );
        options.onAudit?.("connection-open");
      },
      message(ws, message) {
        ws.data.channel?.deliver(typeof message === "string" ? message : message.toString());
      },
      close(ws) {
        // A pending handshake ends its limiter slot exactly once (a denied or
        // timed-out responder never reaches a `Connection`).
        pending.get(ws)?.();
        pending.delete(ws);
        ws.data.release?.();
        ws.data.channel?.fireClose();
        connections.get(ws)?.close();
        options.onAudit?.("connection-close");
      },
    },
  });

  /**
   * A `/e2e` socket: run the responder, and only once it RESOLVES build the
   * (unchanged) `Connection` on the resolved channel. Registers it under the
   * device id so a revoke can close it, and records "last seen" here — never in
   * `authorize`, which a replay reaches (F4/P2).
   */
  function openDevice(ws: WsSocket, channel: WsChannel, route: DeviceRouteOptions): void {
    const authority = route.authority;
    const identity = authority.staticKey();
    if (identity === undefined) {
      // No usable identity (an unreadable store, F14/F26): nothing can be
      // authenticated, so the socket is closed rather than left half-open — and
      // its limiter slot goes back HERE: `finish` is not registered yet, and
      // this socket will never reach the `close` handler's `pending` lookup, so
      // returning without `limiter.end()` would leak a slot per dial and 429
      // every device until a restart (production `maxConcurrent` is 32).
      options.onAudit?.("e2e-no-identity");
      limiter?.end();
      channel.close();
      pending.get(ws)?.();
      pending.delete(ws);
      return;
    }
    let settled = false;
    // Every outcome ends the limiter slot EXACTLY once: an unanswered socket
    // must not hold the concurrent cap forever.
    const finish = (): void => {
      if (settled) return;
      settled = true;
      pending.delete(ws);
      limiter?.end();
    };
    pending.set(ws, finish);
    // The verdict of the handshake that actually completed: `authorize` runs on
    // every message 1 and a revoke could land between the two calls, so the
    // decision is captured rather than asked for again.
    let admitted: DeviceAllow | undefined;
    noiseResponder(channel, {
      staticKey: identity,
      random: systemRandom,
      authorize: (remoteStatic) => {
        const verdict = authority.authorize(remoteStatic);
        if (verdict !== false) admitted = verdict;
        return verdict as AuthorizeVerdict;
      },
      onViolation: (error) => options.onAudit?.(`e2e-violation ${error.kind}`),
    }).then(
      (secure) => {
        finish();
        const verdict = admitted;
        if (verdict === undefined) {
          // Resolved with no allow recorded: only a bug here could do that.
          channel.close();
          return;
        }
        const principal: ConnectionPrincipal =
          verdict.kind === "device" ? { kind: "device", id: verdict.id } : { kind: "pairing" };
        // Built on the RESOLVED secure channel, exactly as the plain route
        // builds it on the raw socket: `Connection` is unchanged and never
        // learns there was a handshake (§7 one session path).
        const connection = new Connection(secure, options.sessionHost, options.onError, {
          maxFrameBytes: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
          principal,
        });
        connections.set(ws, connection);
        // ONE handle for this connection: the authority holds it for a revoke,
        // and every teardown path unregisters this same object, so a revoke's
        // later `unregister` can never touch a different socket.
        const handle: DeviceClose = {
          close: () => {
            connection.close();
            channel.close();
          },
        };
        if (verdict.kind === "device") {
          authority.register(verdict.id, handle);
          touchSeen(authority.configDir, verdict.id);
          options.onAudit?.(`device-open ${verdict.id.slice(0, 8)}`);
        } else {
          options.onAudit?.("pairing-open");
        }
        // The socket closed between the confirm and this point (F22): the
        // wrapper's `close` already fired and will never call back, so the
        // connection must be closed here or it would stay attached forever.
        if (channel.isClosed()) {
          handle.close();
          if (verdict.kind === "device") authority.unregister(verdict.id, handle);
          return;
        }
        ws.data.release = () => {
          if (verdict.kind === "device") authority.unregister(verdict.id, handle);
        };
      },
      (error: { kind?: string }) => {
        finish();
        options.onAudit?.(
          error.kind === "denied" ? "device-denied" : `e2e-violation ${String(error.kind)}`,
        );
      },
    );
  }

  const scheme = options.tls ? "wss" : "ws";
  return {
    url: `${scheme}://${options.host}:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}
