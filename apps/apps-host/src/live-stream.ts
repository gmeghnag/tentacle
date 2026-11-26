/**
 * One visitor request (or WebSocket) as a stream of an app's tunnel
 * (docs/feat/session-apps-container-ports.md): its frames in both directions,
 * the credit window of each, and what the visitor's side reads.
 */
import {
  APPS_TUNNEL_CHUNK_BYTES,
  APPS_TUNNEL_MAX_WS_BYTES,
  type TunnelFrame,
  TunnelInbox,
  TunnelOutbox,
  type TunnelResponse,
} from "@tentacle/protocol";

/** The visitor's WebSocket, as a stream drives it. */
export interface VisitorSocket {
  send(message: string | Uint8Array): "sent" | "backpressure" | "dropped";
  close(code: number, reason: string): void;
}

/** Why a request got no response head. */
export type StreamFailure = "reset" | "timeout" | "gone" | "over_limit";

export type Head =
  | { readonly ok: true; readonly response: TunnelResponse }
  | { readonly ok: false; readonly why: StreamFailure };

export interface StreamHost {
  /** Send one frame on the tunnel. */
  send(frame: TunnelFrame): void;
  /** Count the app's bytes. `false`: over its daily budget. */
  count(bytes: number): boolean;
  /** The app is over its budget: every stream of it is reset. */
  overLimit(): void;
  /** The stream is finished: forget it. */
  done(stream: number, status: number | undefined, bytes: number): void;
  now(): number;
}

const encoder = new TextEncoder();

/** A WebSocket close code a server may send. */
export function sendableCode(code: number): number {
  const reserved = code === 1004 || code === 1005 || code === 1006 || code === 1015;
  return (code >= 1000 && code <= 1014 && !reserved) || (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

/** A close reason fits a WebSocket close frame (123 bytes). */
export function closeReason(reason: string): string {
  let out = reason.slice(0, 123);
  while (encoder.encode(out).length > 123) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Visitor messages held while the window is full, before the stream is reset. */
const MAX_QUEUED_BYTES = 2 * APPS_TUNNEL_MAX_WS_BYTES;

export class LiveStream {
  /** The response head, or why there is none. */
  readonly head: Promise<Head>;
  private resolveHead: (head: Head) => void = () => {};
  private response: TunnelResponse | undefined;
  private readonly inbox = new TunnelInbox();
  private readonly outbox = new TunnelOutbox();
  private closed = false;
  private requestEnded: boolean;
  lastActivity: number;

  // the response body
  private readonly chunks: Uint8Array[] = [];
  private responseEnded = false;
  private failed: StreamFailure | undefined;
  private wakeReader: (() => void) | undefined;
  /** Waiting for credit to send request bytes. */
  private wakeWriter: (() => void) | undefined;

  // the WebSocket
  private visitor: VisitorSocket | undefined;
  private readonly toVisitor: (string | Uint8Array)[] = [];
  private readonly toTunnel: (string | Uint8Array)[] = [];
  private queued = 0;
  /** Inbound bytes not acked until the visitor's socket drains. */
  private unacked = 0;
  private pendingClose: { code: number; reason: string } | undefined;

  constructor(
    readonly id: number,
    readonly websocket: boolean,
    private readonly host: StreamHost,
  ) {
    this.requestEnded = websocket;
    this.lastActivity = host.now();
    this.head = new Promise((resolve) => {
      this.resolveHead = resolve;
    });
  }

  // ── frames from the publisher ──────────────────────────────────────────────

  /** `false`: the frame breaks the protocol (the whole tunnel closes). */
  receive(frame: TunnelFrame): boolean {
    this.lastActivity = this.host.now();
    switch (frame.type) {
      case "head":
        return this.onHead(frame.response);
      case "data": {
        if (this.response === undefined || this.websocket || this.responseEnded) return false;
        if (!this.inbox.admit(frame.bytes.length, "data")) return false;
        if (!this.counted(frame.bytes.length)) return true;
        this.chunks.push(frame.bytes);
        this.wake();
        return true;
      }
      case "end": {
        if (this.response === undefined || this.websocket || this.responseEnded) return false;
        this.responseEnded = true;
        // The answer is whole: an upload still running has nothing left to say.
        if (!this.requestEnded) {
          this.host.send({ type: "reset", stream: this.id, reason: "answered" });
        }
        this.finish();
        return true;
      }
      case "ack": {
        if (!this.outbox.ack(frame.bytes)) return false;
        this.wakeWriter?.();
        this.flushToTunnel();
        return true;
      }
      case "reset":
        this.fail("reset");
        return true;
      case "ws_text":
      case "ws_bin": {
        if (!this.websocket || this.response === undefined) return false;
        const message = frame.type === "ws_text" ? frame.text : frame.bytes;
        const size = sizeOf(message);
        if (!this.inbox.admit(size, "ws")) return false;
        if (!this.counted(size)) return true;
        if (this.visitor === undefined) {
          this.toVisitor.push(message);
        } else {
          this.deliver(message);
        }
        return true;
      }
      case "ws_close": {
        if (!this.websocket || this.response === undefined) return false;
        this.pendingClose = { code: frame.code, reason: frame.reason };
        if (this.visitor !== undefined) {
          this.closeVisitor();
        }
        return true;
      }
      default:
        return false;
    }
  }

  private onHead(response: TunnelResponse): boolean {
    if (this.response !== undefined) return false;
    this.response = response;
    this.resolveHead({ ok: true, response });
    return true;
  }

  /** The stream's bytes, both ways (logged when it ends). */
  private total = 0;

  private counted(bytes: number): boolean {
    this.total += bytes;
    if (this.host.count(bytes)) return true;
    this.host.overLimit();
    return false;
  }

  // ── the HTTP response body ─────────────────────────────────────────────────

  /** What the visitor reads. A chunk is acked as it is taken. */
  body(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.chunks.length === 0 && !this.responseEnded && this.failed === undefined) {
          await new Promise<void>((resolve) => {
            this.wakeReader = resolve;
          });
        }
        if (this.failed !== undefined) {
          controller.error(new Error(this.failed));
          return;
        }
        const chunk = this.chunks.shift();
        if (chunk === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        this.inbox.release(chunk.length);
        if (!this.closed && chunk.length > 0) {
          this.host.send({ type: "ack", stream: this.id, bytes: chunk.length });
        }
      },
      cancel: () => this.reset("the visitor left"),
    });
  }

  private wake(): void {
    const wake = this.wakeReader;
    this.wakeReader = undefined;
    wake?.();
  }

  // ── the request body ───────────────────────────────────────────────────────

  /** Send request bytes, waiting for credit. `false`: the stream is over. */
  async sendData(bytes: Uint8Array): Promise<boolean> {
    for (let at = 0; at < bytes.length; at += APPS_TUNNEL_CHUNK_BYTES) {
      const chunk = bytes.subarray(at, at + APPS_TUNNEL_CHUNK_BYTES);
      while (!this.closed && !this.outbox.take(chunk.length, "data")) {
        await new Promise<void>((resolve) => {
          this.wakeWriter = resolve;
        });
      }
      if (this.closed || !this.counted(chunk.length)) return false;
      this.lastActivity = this.host.now();
      this.host.send({ type: "data", stream: this.id, bytes: chunk });
    }
    return true;
  }

  endRequest(): void {
    if (this.closed || this.requestEnded) return;
    this.requestEnded = true;
    this.host.send({ type: "end", stream: this.id });
  }

  // ── the visitor's WebSocket ────────────────────────────────────────────────

  bind(visitor: VisitorSocket): void {
    this.visitor = visitor;
    if (this.failed !== undefined) {
      visitor.close(1011, "the connection was lost");
      return;
    }
    for (const message of this.toVisitor.splice(0)) {
      this.deliver(message);
    }
    if (this.pendingClose !== undefined) {
      this.closeVisitor();
    }
  }

  private deliver(message: string | Uint8Array): void {
    const sent = this.visitor?.send(message);
    if (sent === "dropped") {
      this.reset("the visitor cannot keep up");
      return;
    }
    this.unacked += sizeOf(message);
    if (sent === "sent") {
      this.drained();
    }
  }

  /** The visitor's socket took what was sent: credit the publisher. */
  drained(): void {
    const bytes = this.unacked;
    if (bytes === 0 || this.closed) return;
    this.unacked = 0;
    this.inbox.release(bytes);
    this.host.send({ type: "ack", stream: this.id, bytes });
  }

  private closeVisitor(): void {
    const close = this.pendingClose;
    if (close === undefined) return;
    this.finish();
    this.visitor?.close(sendableCode(close.code), closeReason(close.reason));
  }

  /** A message of the visitor's WebSocket. */
  fromVisitor(message: string | Uint8Array): void {
    if (this.closed) return;
    this.lastActivity = this.host.now();
    const size = sizeOf(message);
    if (size > APPS_TUNNEL_MAX_WS_BYTES || this.queued + size > MAX_QUEUED_BYTES) {
      this.reset("too much data");
      this.visitor?.close(1009, "too much data");
      return;
    }
    this.queued += size;
    this.toTunnel.push(message);
    this.flushToTunnel();
  }

  private flushToTunnel(): void {
    for (;;) {
      const message = this.toTunnel[0];
      if (message === undefined || this.closed) return;
      const size = sizeOf(message);
      // An empty message costs nothing and is never held back.
      if (size > 0 && !this.outbox.take(size, "ws")) return;
      this.toTunnel.shift();
      this.queued -= size;
      if (!this.counted(size)) return;
      this.host.send(
        typeof message === "string"
          ? { type: "ws_text", stream: this.id, text: message }
          : { type: "ws_bin", stream: this.id, bytes: message },
      );
    }
  }

  visitorClosed(code: number, reason: string): void {
    this.visitor = undefined;
    if (this.closed) return;
    this.host.send({
      type: "ws_close",
      stream: this.id,
      code: sendableCode(code),
      reason: closeReason(reason),
    });
    this.finish();
  }

  // ── the end ────────────────────────────────────────────────────────────────

  /** The host's side gives up: tell the publisher. */
  reset(reason: string, why: StreamFailure = "gone"): void {
    if (this.closed) return;
    this.host.send({ type: "reset", stream: this.id, reason });
    this.fail(why);
  }

  /** The stream failed (a reset, the tunnel gone): everything waiting is woken. */
  fail(why: StreamFailure): void {
    if (this.closed) return;
    this.failed = why;
    this.chunks.length = 0;
    this.finish();
    this.visitor?.close(1011, "the connection was lost");
    this.visitor = undefined;
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.resolveHead({ ok: false, why: this.failed ?? "reset" });
    this.wake();
    this.wakeWriter?.();
    this.host.done(this.id, this.response?.status, this.total);
  }
}

function sizeOf(message: string | Uint8Array): number {
  return typeof message === "string" ? encoder.encode(message).length : message.length;
}
