/**
 * A `DuplexChannel` over a Kubernetes `exec` WebSocket (`v4.channel.k8s.io`).
 *
 * The RPC `RpcPeer` rides this unchanged: outbound frames are tunnelled as
 * stdin (channel 0), inbound frames are re-assembled off stdout (channel 1) by
 * `ExecDemux`. The URL/subprotocol builders are pure (testable without a
 * socket); `execChannel` wraps any `WebSocketLike` so it can be driven by a real
 * `WebSocket` or a fake in tests.
 *
 * The WebSocket is still CONNECTING when the first frame is issued (the pod
 * runtime handshakes synchronously right after `openExec`), and sending while
 * CONNECTING throws `InvalidStateError` — so outbound frames are buffered until
 * the socket's `open` event and flushed in order.
 *
 * Once open, a heartbeat keeps the idle exec alive and notices when it is dead
 * (`docs/feat/pod-attach-resilience.md`): each tick sends a WebSocket ping
 * (answered by the apiserver/kubelet stream) and a blank stdin line (data on
 * every hop up to the container; the daemon's `streamChannel` drops blank
 * lines). After a first pong proves the far end answers pings, `maxMissed`
 * ticks with no inbound byte close the channel — the client's drop path then
 * reconnects. Without a pong it never closes: an idle daemon sends nothing, so
 * silence alone proves nothing.
 */
import type { DuplexChannel } from "@tentacle/transport";
import { ExecDemux, encodeStdin } from "./exec-frame.ts";

/** The slice of a `WebSocket` the exec channel needs (browser/Bun shape). */
export interface WebSocketLike {
  binaryType?: string;
  /** WebSocket ready state; 0=CONNECTING, 1=OPEN. Lets us buffer until open. */
  readyState?: number;
  /**
   * Bytes queued in the socket layer but not yet handed to the OS/network.
   * Optional (not all impls expose it); the one-shot transfer uses it for
   * backpressure (`exec-run.ts`), treating `undefined` as 0 (no gating).
   */
  readonly bufferedAmount?: number;
  send(data: Uint8Array): void;
  /** WebSocket ping (Bun's client has it; optional so other impls still fit). */
  ping?(): void;
  close(): void;
  addEventListener(type: "message", handler: (event: { data: unknown }) => void): void;
  addEventListener(type: "open", handler: () => void): void;
  addEventListener(type: "pong", handler: () => void): void;
  addEventListener(type: "close", handler: () => void): void;
  addEventListener(type: "error", handler: (event: unknown) => void): void;
}

export interface ExecChannelOptions {
  /** Pod stderr (channel 2), surfaced to the local log. */
  readonly onStderr?: (text: string) => void;
  /** The exec error/status channel (3), a terminal status at the end. */
  readonly onStatus?: (text: string) => void;
  /** Heartbeat tuning (defaults below); `timers` is a test seam. */
  readonly keepalive?: KeepaliveOptions;
}

export interface KeepaliveOptions {
  /** Tick period. Well under common idle timeouts (an LB's is often 60 s). */
  readonly intervalMs?: number;
  /** Consecutive silent ticks, after a first pong, that mean the link is dead. */
  readonly maxMissed?: number;
  readonly timers?: IntervalTimers;
}

export interface IntervalTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const KEEPALIVE_INTERVAL_MS = 15_000;
export const KEEPALIVE_MAX_MISSED = 2;

const systemTimers: IntervalTimers = {
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    // The socket owns the process lifetime; the heartbeat must not extend it.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** A blank stdin line: keepalive data the daemon's line reader discards. */
const BLANK_STDIN = encodeStdin("");

/** Normalise a WebSocket message payload to bytes (we request `arraybuffer`). */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  return null;
}

/** Wrap an exec WebSocket as the duplex channel an `RpcPeer` rides. */
export function execChannel(ws: WebSocketLike, options: ExecChannelOptions = {}): DuplexChannel {
  let onMessage: ((data: string) => void) | undefined;
  let onClose: (() => void) | undefined;
  let closed = false;
  // The WebSocket is async: it is CONNECTING until the HTTP upgrade completes.
  // `send` while CONNECTING throws InvalidStateError ("The object is in an
  // invalid state."), which would kill the `initialize` handshake — the caller
  // (the pod runtime) issues the first frame synchronously in the same turn the
  // socket is constructed. Queue outbound frames until the socket is open.
  const queue: Uint8Array[] = [];
  let opened = ws.readyState === 1;

  const timers = options.keepalive?.timers ?? systemTimers;
  const intervalMs = options.keepalive?.intervalMs ?? KEEPALIVE_INTERVAL_MS;
  const maxMissed = options.keepalive?.maxMissed ?? KEEPALIVE_MAX_MISSED;
  let heartbeat: unknown = null;
  let pongSeen = false;
  let inbound = false; // any byte since the previous tick
  let missed = 0;

  const flush = (): void => {
    while (queue.length > 0 && !closed) {
      const frame = queue.shift();
      if (frame !== undefined) {
        ws.send(frame);
      }
    }
    if (closed) {
      queue.length = 0; // dropped — the channel is dead
    }
  };

  const fireClose = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    queue.length = 0;
    if (heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
    onClose?.();
  };

  const tick = (): void => {
    if (closed) {
      return;
    }
    // Judge the previous tick's probe, then send the next one. Counting ticks
    // (not wall time) means a laptop waking from sleep judges the pre-sleep
    // ping, normally answered, instead of the sleep itself.
    missed = inbound || !pongSeen ? 0 : missed + 1;
    inbound = false;
    if (missed >= maxMissed) {
      try {
        ws.close();
      } catch {
        // already closing / closed
      }
      fireClose();
      return;
    }
    // Separately guarded: a throwing ping must not cost the blank line. A throw
    // means the socket is going away; its own close/error event follows.
    try {
      ws.ping?.();
    } catch {}
    try {
      ws.send(BLANK_STDIN);
    } catch {}
  };

  const startHeartbeat = (): void => {
    if (heartbeat === null && !closed) {
      heartbeat = timers.setInterval(tick, intervalMs);
    }
  };

  const demux = new ExecDemux({
    onFrame: (frame) => onMessage?.(frame),
    ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    ...(options.onStatus ? { onError: options.onStatus } : {}),
  });

  try {
    ws.binaryType = "arraybuffer";
  } catch {
    // Some implementations set this read-only post-connect; the handler copes
    // with either an ArrayBuffer or a view regardless.
  }
  ws.addEventListener("message", (event) => {
    inbound = true;
    const bytes = toBytes(event.data);
    if (bytes) {
      demux.push(bytes);
    }
  });
  ws.addEventListener("open", () => {
    opened = true;
    flush();
    startHeartbeat();
  });
  ws.addEventListener("pong", () => {
    pongSeen = true;
    inbound = true;
  });
  ws.addEventListener("close", fireClose);
  ws.addEventListener("error", fireClose);
  if (opened) {
    startHeartbeat(); // already OPEN: no `open` event will come
  }

  return {
    send(data: string): void {
      if (closed) {
        return;
      }
      const frame = encodeStdin(data);
      if (opened) {
        ws.send(frame);
      } else {
        queue.push(frame);
      }
    },
    close(): void {
      try {
        ws.close();
      } catch {
        // already closing / closed
      }
      fireClose();
    },
    setOnMessage(handler: (data: string) => void): void {
      onMessage = handler;
    },
    setOnClose(handler: () => void): void {
      onClose = handler;
    },
  };
}

export interface ExecTarget {
  /** Pod name. */
  readonly pod: string;
  /** Container name (optional; the API picks the only/default container). */
  readonly container?: string;
  /** The command to run — one array element per argv token. */
  readonly command: readonly string[];
}

/** Build the `exec` subresource WebSocket URL (https→wss, http→ws). */
export function buildExecUrl(server: string, namespace: string, target: ExecTarget): string {
  const base = server.replace(/^http/, "ws").replace(/\/+$/, "");
  const params = new URLSearchParams();
  if (target.container) {
    params.set("container", target.container);
  }
  params.set("stdin", "true");
  params.set("stdout", "true");
  params.set("stderr", "true");
  for (const token of target.command) {
    params.append("command", token);
  }
  const ns = encodeURIComponent(namespace);
  const pod = encodeURIComponent(target.pod);
  return `${base}/api/v1/namespaces/${ns}/pods/${pod}/exec?${params.toString()}`;
}

/** URL-safe base64 without padding (ASCII input; k8s tokens are ASCII). */
function base64url(token: string): string {
  return btoa(token).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * WebSocket subprotocols for an exec: the channel protocol, plus — when a bearer
 * token is given — the standard subprotocol that carries it (browsers/WS cannot
 * set an Authorization header, so the apiserver accepts it this way).
 */
export function execSubprotocols(token?: string): string[] {
  const protocols = ["v4.channel.k8s.io"];
  if (token) {
    protocols.push(`base64url.bearer.authorization.k8s.io.${base64url(token)}`);
  }
  return protocols;
}
