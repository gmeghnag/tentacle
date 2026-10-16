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
  /** Auto-deny a permission request a client leaves unanswered this long (ms). */
  readonly permissionTimeoutMs?: number;
  /** Max live sessions per connection before `session/new` is refused. */
  readonly maxSessions?: number;
  /** Max inbound frame size (bytes) accepted before parsing. */
  readonly maxFrameBytes?: number;
}

// Conservative per-connection defaults; a never-answering or abusive client is
// bounded without getting in a real client's way. All overridable per server.
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60 * 1000; // 5 min to answer a prompt
const DEFAULT_MAX_SESSIONS = 64;
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB

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
      open(ws) {
        const channel = new WsChannel(ws);
        ws.data.channel = channel;
        connections.set(
          ws,
          new Connection(channel, options.sessionHost, options.onError, {
            permissionTimeoutMs: options.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
            maxSessions: options.maxSessions ?? DEFAULT_MAX_SESSIONS,
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
