/**
 * Adapts a WebSocket (Bun's or the browser's) to the transport's
 * `DuplexChannel`. `connectWebSocket` resolves once the socket is open, so the
 * caller can immediately `initialize`.
 */
import type { DuplexChannel } from "@tentacle/transport";

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

/** Open a WebSocket to the daemon and resolve a ready channel. */
export function connectWebSocket(
  url: string,
  options: ConnectOptions = {},
): Promise<WebSocketChannel> {
  // Token goes in the Authorization header (Bun supports a headers option) and,
  // as a fallback for clients that cannot set headers, also as a query param.
  let target = url;
  if (options.token) {
    const u = new URL(url);
    if (!u.searchParams.has("token")) {
      u.searchParams.set("token", options.token);
    }
    target = u.toString();
  }
  const init = options.token
    ? { headers: { Authorization: `Bearer ${options.token}` } }
    : undefined;
  const ws = new WebSocket(target, init as unknown as string[]) as unknown as WebSocketLike & {
    addEventListener(type: "open", cb: () => void): void;
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(new WebSocketChannel(ws)));
    ws.addEventListener("error", () => reject(new Error(`failed to connect to ${url}`)));
  });
}
