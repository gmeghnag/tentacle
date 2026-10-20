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
import { Connection } from "./connection.ts";
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
  if (!isLoopbackHost(options.host) && !options.token) {
    throw new Error(
      `refusing to bind ${options.host} without a token: a non-loopback listener requires --token (remote code execution risk)`,
    );
  }

  const authorize = (req: Request): boolean => {
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

  const server = Bun.serve<SocketData>({
    hostname: options.host,
    port: options.port,
    ...(options.tls ? { tls: { cert: options.tls.cert, key: options.tls.key } } : {}),
    fetch(req, srv) {
      if (!authorize(req)) {
        options.onAudit?.(`auth-failure ${new URL(req.url).pathname}`);
        return new Response("unauthorized", { status: 401 });
      }
      if (srv.upgrade(req, { data: { channel: null } })) {
        return undefined;
      }
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      ...socketOptions(options),
      open(ws) {
        const channel = new WsChannel(ws);
        ws.data.channel = channel;
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
        ws.data.channel?.fireClose();
        connections.get(ws)?.close();
        options.onAudit?.("connection-close");
      },
    },
  });

  const scheme = options.tls ? "wss" : "ws";
  return {
    url: `${scheme}://${options.host}:${server.port}`,
    port: server.port,
    stop: () => server.stop(true),
  };
}
