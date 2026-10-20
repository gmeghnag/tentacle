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

export interface ConnectOptions {
  /** Bearer token; sent as an `Authorization` header (Bun) and `?token=` fallback. */
  readonly token?: string;
}

type OpenableSocket = WebSocketLike & {
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "close", cb: (event: { code?: number }) => void): void;
};

/** The socket constructor (Bun's / the browser's), injectable for tests. */
export type WebSocketCtor = new (url: string, init?: unknown) => unknown;

/**
 * The upgrade URL and init for a token: an `Authorization` header (Bun supports
 * a headers option) and, for clients that cannot set headers, `?token=`.
 */
function socketTarget(url: string, token: string | undefined): { target: string; init?: unknown } {
  if (!token) {
    return { target: url };
  }
  const u = new URL(url);
  if (!u.searchParams.has("token")) {
    u.searchParams.set("token", token);
  }
  return { target: u.toString(), init: { headers: { Authorization: `Bearer ${token}` } } };
}

function openSocket(url: string, token: string | undefined, Ctor: WebSocketCtor): OpenableSocket {
  const { target, init } = socketTarget(url, token);
  return (init === undefined ? new Ctor(target) : new Ctor(target, init)) as OpenableSocket;
}

/** Open a WebSocket to the daemon and resolve a ready channel. */
export function connectWebSocket(
  url: string,
  options: ConnectOptions = {},
): Promise<WebSocketChannel> {
  const ws = openSocket(url, options.token, WebSocket as unknown as WebSocketCtor);
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
 * failed — never terminal on a guess.
 */
export function classifyUpgradeFailure(
  closeCode: number,
  probeStatus: number | null,
): ChannelError {
  if (closeCode === 1002) {
    if (probeStatus === 401) {
      return new ChannelError("unauthorized", "the daemon answered 401 to the token");
    }
    return new ChannelError(
      "rejected",
      probeStatus === null
        ? "the daemon refused the upgrade"
        : `the daemon refused the upgrade (HTTP ${probeStatus})`,
    );
  }
  return new ChannelError("unreachable", `cannot reach the daemon (close ${closeCode})`);
}

export interface ChannelFactoryDeps {
  readonly WebSocket?: WebSocketCtor;
  readonly fetch?: (
    url: string,
    init: { headers: Record<string, string> },
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
      const res = await doFetch(target.replace(/^ws/, "http"), {
        headers: options.token ? { Authorization: `Bearer ${options.token}` } : {},
      });
      return res.status;
    } catch {
      return null;
    }
  };
  return () =>
    new Promise((resolve, reject) => {
      let opened = false;
      const ws = openSocket(url, options.token, Ctor);
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
