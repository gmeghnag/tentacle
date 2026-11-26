/**
 * One device connection's preview tunnels (docs/feat/container-apps-devices.md):
 * a TCP socket to the container's published loopback port, carried as
 * `preview/data|ack|close` notifications.
 *
 * Flow control is a credit window per direction. Towards the phone, at most
 * `PREVIEW_WINDOW_BYTES` are un-acked: the socket pauses when credit is out.
 * From the phone, bytes are acked after the socket wrote them, and more than a
 * window un-acked closes the tunnel, so nothing here grows without bound.
 *
 * HTTP/1 only: nothing reaches the upstream before the phone's first line is an
 * HTTP/1.x request line (a WebSocket upgrade is one), and an upstream that
 * speaks first is closed.
 *
 * `data` / `ack` / `close` are synchronous (no await, no lock): the peer calls
 * them in frame order, so the byte stream keeps the wire's order (AGENTS §7).
 */
import { type Socket, createConnection } from "node:net";
import {
  MAX_TUNNELS_PER_CONNECTION,
  Notification,
  PREVIEW_CHUNK_BYTES,
  PREVIEW_WINDOW_BYTES,
} from "@tentacle/protocol";

/** The longest first request line, its CRLF included. */
const MAX_REQUEST_LINE = 8 * 1024;
const DIAL_TIMEOUT_MS = 10_000;
const MAX_DATA_CHARS = Math.ceil(PREVIEW_CHUNK_BYTES / 3) * 4;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/** `METHOD SP target SP HTTP/1.x` (RFC 9112: a token, then visible ASCII). */
const REQUEST_LINE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ [\x21-\x7e]+ HTTP\/1\.[01]$/;

/** Is the start of a phone's byte stream an HTTP/1.x request line? Pure. */
export function httpRequestGate(buffer: Buffer): "pass" | "wait" | "reject" {
  const end = buffer.indexOf(0x0a);
  const length = end === -1 ? buffer.length : end + 1;
  if (length > MAX_REQUEST_LINE) return "reject";
  if (end === -1) {
    // A control byte before the line ends can never become a request line.
    return buffer.some((byte) => byte < 0x20 && byte !== 0x0d) ? "reject" : "wait";
  }
  if (end === 0 || buffer[end - 1] !== 0x0d) return "reject";
  return REQUEST_LINE.test(buffer.toString("latin1", 0, end - 1)) ? "pass" : "reject";
}

export type PreviewDial = (port: number) => Promise<Socket>;

/** Connect to `127.0.0.1:<port>`; rejects when refused or too slow. */
export function dialLoopback(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the connection timed out"));
    }, DIAL_TIMEOUT_MS);
    const failed = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.once("error", failed);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.off("error", failed);
      // Never unhandled: the tunnel reacts to `close`.
      socket.on("error", () => {});
      resolve(socket);
    });
  });
}

export type PreviewSend = (
  method: "preview/data" | "preview/ack" | "preview/close",
  params: { tunnelId: string; data?: string; bytes?: number; reason?: string },
) => void;

/** A slot held while a dial is pending, so concurrent connects respect the cap. */
export interface TunnelSlot {
  /**
   * Turn the slot into a tunnel on `socket`; `undefined` (the socket destroyed)
   * when the table was closed meanwhile or the slot was already given up.
   */
  open(socket: Socket, onClosed?: () => void): string | undefined;
  /** Give the slot back (idempotent; a no-op after `open`). */
  release(): void;
}

interface Tunnel {
  readonly socket: Socket;
  readonly onClosed: (() => void) | undefined;
  /** Upstream bytes read but not yet sent (at most one socket read). */
  pending: Buffer[];
  /** Sent to the phone, not yet acked. */
  unackedOut: number;
  /** Received from the phone, not yet acked. */
  unackedIn: number;
  /** The phone's first bytes, held until the request line passes; then `undefined`. */
  gate: Buffer | undefined;
  /** The upstream finished: close once `pending` is sent. */
  ended: boolean;
}

export class PreviewTunnels {
  private readonly tunnels = new Map<string, Tunnel>();
  private reserved = 0;
  private disposed = false;

  constructor(private readonly send: PreviewSend) {}

  /** Open tunnels. */
  get size(): number {
    return this.tunnels.size;
  }

  /** `undefined`: the connection is closing, or the cap is reached. */
  reserve(): TunnelSlot | undefined {
    if (this.disposed || this.tunnels.size + this.reserved >= MAX_TUNNELS_PER_CONNECTION) {
      return undefined;
    }
    this.reserved++;
    let held = true;
    const release = (): void => {
      if (held) {
        held = false;
        this.reserved--;
      }
    };
    return {
      release,
      open: (socket, onClosed) => {
        if (!held || this.disposed) {
          release();
          socket.destroy();
          return undefined;
        }
        release();
        return this.attach(socket, onClosed);
      },
    };
  }

  /** The phone's bytes. */
  data(tunnelId: string, data: string): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) {
      this.notify(Notification.PreviewClose, { tunnelId, reason: "unknown-tunnel" });
      return;
    }
    if (data.length > MAX_DATA_CHARS) {
      this.close(tunnelId, "chunk", true);
      return;
    }
    if (!BASE64.test(data)) {
      this.close(tunnelId, "bad-data", true);
      return;
    }
    const bytes = Buffer.from(data, "base64");
    if (bytes.length > PREVIEW_CHUNK_BYTES) {
      this.close(tunnelId, "chunk", true);
      return;
    }
    if (bytes.length === 0) return;
    tunnel.unackedIn += bytes.length;
    if (tunnel.unackedIn > PREVIEW_WINDOW_BYTES) {
      this.close(tunnelId, "window", true);
      return;
    }
    if (tunnel.gate === undefined) {
      this.write(tunnelId, tunnel, bytes);
      return;
    }
    const held = Buffer.concat([tunnel.gate, bytes]);
    const verdict = httpRequestGate(held);
    if (verdict === "reject") {
      this.close(tunnelId, "not-http", true);
    } else if (verdict === "wait") {
      tunnel.gate = held;
    } else {
      tunnel.gate = undefined;
      this.write(tunnelId, tunnel, held);
    }
  }

  /** The phone consumed `bytes`: credit back, never more than was sent. */
  ack(tunnelId: string, bytes: number): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return;
    tunnel.unackedOut -= Math.min(bytes, tunnel.unackedOut);
    this.pump(tunnelId, tunnel);
  }

  /** End one tunnel (idempotent). `notify`: tell the phone. */
  close(tunnelId: string, reason: string, notify: boolean): void {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return;
    this.tunnels.delete(tunnelId);
    tunnel.pending = [];
    tunnel.socket.destroy();
    if (notify) this.notify(Notification.PreviewClose, { tunnelId, reason });
    tunnel.onClosed?.();
  }

  /** The connection is gone: every socket destroyed, nothing sent, no new slot. */
  closeAll(): void {
    this.disposed = true;
    for (const tunnelId of [...this.tunnels.keys()]) {
      this.close(tunnelId, "connection", false);
    }
  }

  private attach(socket: Socket, onClosed: (() => void) | undefined): string {
    const tunnelId = crypto.randomUUID();
    const tunnel: Tunnel = {
      socket,
      onClosed,
      pending: [],
      unackedOut: 0,
      unackedIn: 0,
      gate: Buffer.alloc(0),
      ended: false,
    };
    this.tunnels.set(tunnelId, tunnel);
    socket.on("data", (chunk: Buffer) => {
      if (!this.tunnels.has(tunnelId)) return;
      if (tunnel.gate !== undefined) {
        this.close(tunnelId, "not-http", true);
        return;
      }
      tunnel.pending.push(chunk);
      this.pump(tunnelId, tunnel);
    });
    socket.on("end", () => {
      tunnel.ended = true;
      this.pump(tunnelId, tunnel);
    });
    socket.on("close", (hadError: boolean) => {
      if (hadError) {
        this.close(tunnelId, "upstream-error", true);
        return;
      }
      tunnel.ended = true;
      this.pump(tunnelId, tunnel);
    });
    // Closed between the dial and here: no event will follow.
    if (socket.destroyed) {
      queueMicrotask(() => this.close(tunnelId, "end", true));
    }
    return tunnelId;
  }

  private write(tunnelId: string, tunnel: Tunnel, bytes: Buffer): void {
    tunnel.socket.write(bytes, (error) => {
      // A failed write ends in the socket's `close`.
      if (error || !this.tunnels.has(tunnelId)) return;
      tunnel.unackedIn -= bytes.length;
      this.notify(Notification.PreviewAck, { tunnelId, bytes: bytes.length });
    });
  }

  /** Send what the credit allows, then pause or resume the upstream. */
  private pump(tunnelId: string, tunnel: Tunnel): void {
    if (!this.tunnels.has(tunnelId)) return;
    let head = tunnel.pending[0];
    while (head !== undefined && tunnel.unackedOut < PREVIEW_WINDOW_BYTES) {
      const size = Math.min(
        head.length,
        PREVIEW_CHUNK_BYTES,
        PREVIEW_WINDOW_BYTES - tunnel.unackedOut,
      );
      tunnel.unackedOut += size;
      if (size === head.length) {
        tunnel.pending.shift();
      } else {
        tunnel.pending[0] = head.subarray(size);
      }
      this.notify(Notification.PreviewData, {
        tunnelId,
        data: head.subarray(0, size).toString("base64"),
      });
      head = tunnel.pending[0];
    }
    if (tunnel.pending.length > 0 || tunnel.unackedOut >= PREVIEW_WINDOW_BYTES) {
      tunnel.socket.pause();
    } else if (tunnel.ended) {
      this.close(tunnelId, "end", true);
    } else {
      tunnel.socket.resume();
    }
  }

  private notify(...[method, params]: Parameters<PreviewSend>): void {
    try {
      this.send(method, params);
    } catch {
      // A closing channel: the connection's teardown closes every tunnel.
    }
  }
}
