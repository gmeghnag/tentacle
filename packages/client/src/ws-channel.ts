/**
 * Adapts a WebSocket (Bun's or the browser's) to the transport's
 * `DuplexChannel`. `connectWebSocket` resolves once the socket is open, so the
 * caller can immediately `initialize`.
 */
import type { DuplexChannel } from "@tentacle/transport";
import { ChannelError } from "./link-machine.ts";

interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void;
}

export class WebSocketChannel implements DuplexChannel {
  private onMessage?: (data: string) => void;
  private onClose?: () => void;
  private closed = false;

  constructor(private readonly ws: WebSocketLike) {
    ws.addEventListener("message", (event) => {
      const data = event.data;
      this.onMessage?.(typeof data === "string" ? data : String(data));
    });
    ws.addEventListener("close", () => this.fireClose());
    ws.addEventListener("error", () => this.fireClose());
  }

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
  private fireClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onClose?.();
  }
}

/**
 * Server-TLS trust for a `wss://` daemon (docs/feat/client-tls-trust.md).
 * Bun's WebSocket client verifies against the system CAs only, so a
 * self-signed / private-CA daemon needs one of these, per connection:
 * `ca` — the PEM of the CA (or the self-signed cert) that signed the daemon's
 * server cert; verification stays fully on. `rejectUnauthorized: false` —
 * skip verification; a dev-only escape hatch. This is the same per-call `tls`
 * object the k8s pod path composes (`k8s/kube-auth.ts`); the `init` of a Bun
 * `new WebSocket(url, init)` honours it. NOTE: `disableTlsCerts` does NOT
 * work on the WS client — it is a fetch-only knob.
 */
export interface TlsOptions {
  readonly ca?: string;
  readonly rejectUnauthorized?: boolean;
}

export interface ConnectOptions {
  /** Bearer token; sent as an `Authorization` header (Bun) and `?token=` fallback. */
  readonly token?: string;
  /** Trust a daemon whose cert is not in the system store (see `TlsOptions`). */
  readonly tls?: TlsOptions;
}

type OpenableSocket = WebSocketLike & {
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: (event: { code?: number }) => void): void;
};

/** The socket constructor (Bun's / the browser's), injectable for tests. */
export type WebSocketCtor = new (url: string, init?: unknown) => unknown;

/**
 * The upgrade URL and init for a token and a TLS trust: an `Authorization`
 * header (Bun supports a headers option), `?token=` for clients that cannot
 * set headers, and the `tls` object, coexisting in the same init.
 */
function socketTarget(
  url: string,
  token: string | undefined,
  tls?: TlsOptions,
): { target: string; init?: unknown } {
  let target = url;
  const init: { headers?: Record<string, string>; tls?: TlsOptions } = {};
  if (token) {
    const u = new URL(url);
    if (!u.searchParams.has("token")) {
      u.searchParams.set("token", token);
    }
    target = u.toString();
    init.headers = { Authorization: `Bearer ${token}` };
  }
  if (tls) {
    init.tls = tls;
  }
  return init.headers === undefined && init.tls === undefined ? { target } : { target, init };
}

function openSocket(
  url: string,
  token: string | undefined,
  tls: TlsOptions | undefined,
  Ctor: WebSocketCtor,
): OpenableSocket {
  const { target, init } = socketTarget(url, token, tls);
  return (init === undefined ? new Ctor(target) : new Ctor(target, init)) as OpenableSocket;
}

/** Open a WebSocket to the daemon and resolve a ready channel. */
export function connectWebSocket(
  url: string,
  options: ConnectOptions = {},
): Promise<WebSocketChannel> {
  const ws = openSocket(url, options.token, options.tls, WebSocket as unknown as WebSocketCtor);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(new WebSocketChannel(ws)));
    ws.addEventListener("error", () => reject(new Error(`failed to connect to ${url}`)));
  });
}

/**
 * Classify an upgrade that closed before `open`. On Bun every non-101 answer
 * (401, a proxy's 502, …) is close 1002 and an unreachable host 1006
 * (docs/feat/client-reattach-frontends.md, Experiment Q8), so a 1002 is told
 * apart by `probeStatus`: the HTTP status of a plain GET to the same URL (the
 * daemon answers 401 to a bad token, 426 to a good one), `null` when the probe
 * failed — never terminal on a guess. A 1015 is a failed TLS handshake.
 */
export function classifyUpgradeFailure(
  closeCode: number,
  probeStatus: number | null,
): ChannelError {
  if (closeCode === 1002) {
    if (probeStatus === 401) {
      return new ChannelError("unauthorized", "the daemon answered 401 to the token", closeCode);
    }
    return new ChannelError(
      "rejected",
      probeStatus === null
        ? "the daemon refused the upgrade"
        : `the daemon refused the upgrade (HTTP ${probeStatus})`,
      closeCode,
    );
  }
  if (closeCode === 1015) {
    // Bun closes a `wss://` upgrade whose TLS handshake failed with 1015: an
    // untrusted cert (self-signed / private CA / wrong CA), or a daemon that
    // does not serve TLS at all (docs/feat/client-tls-trust.md). Still
    // transient: a redial may meet a rotated cert.
    return new ChannelError(
      "unreachable",
      "TLS handshake failed (close 1015): the daemon's certificate is not trusted, or it does not serve TLS",
      closeCode,
    );
  }
  return new ChannelError("unreachable", `cannot reach the daemon (close ${closeCode})`, closeCode);
}

export interface ChannelFactoryDeps {
  readonly WebSocket?: WebSocketCtor;
  /**
   * The classifying GET (see `webSocketChannelFactory`): `init` carries the
   * token header AND the TLS trust, because the probe must complete the
   * handshake to read the daemon's 401 (a `wss://` GET fails its own handshake
   * without `tls`, which would misclassify a bad token as `rejected`).
   */
  readonly fetch?: (
    url: string,
    init: { headers: Record<string, string>; tls?: TlsOptions },
  ) => Promise<{
    readonly status: number;
  }>;
}

/**
 * A `RemoteClient` channel factory for a daemon's WebSocket URL: each call
 * dials once and resolves an open channel, or rejects with a `ChannelError`
 * (`unauthorized` is terminal, see `classifyUpgradeFailure`).
 */
export function webSocketChannelFactory(
  url: string,
  options: ConnectOptions = {},
  deps: ChannelFactoryDeps = {},
): () => Promise<WebSocketChannel> {
  const Ctor = deps.WebSocket ?? (WebSocket as unknown as WebSocketCtor);
  const probe = async (): Promise<number | null> => {
    const { target } = socketTarget(url, options.token);
    const doFetch = deps.fetch ?? fetch;
    try {
      // The probe must complete the TLS handshake to read the daemon's 401, so
      // it carries the same `tls` trust as the socket (without it a `wss://`
      // GET fails its own handshake → a bad token would be misclassified).
      const res = await doFetch(target.replace(/^ws/, "http"), {
        headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
        ...(options.tls ? { tls: options.tls } : {}),
      });
      return res.status;
    } catch {
      return null;
    }
  };
  return () =>
    new Promise((resolve, reject) => {
      let opened = false;
      const ws = openSocket(url, options.token, options.tls, Ctor);
      ws.addEventListener("open", () => {
        opened = true;
        resolve(new WebSocketChannel(ws));
      });
      ws.addEventListener("close", (event) => {
        if (opened) {
          return; // the channel's own close path
        }
        const code = typeof event.code === "number" ? event.code : 1006;
        if (code !== 1002) {
          reject(classifyUpgradeFailure(code, null));
          return;
        }
        void probe().then((status) => reject(classifyUpgradeFailure(code, status)));
      });
    });
}
