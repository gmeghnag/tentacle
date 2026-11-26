/**
 * One visitor request of a shared port, on the serve
 * (docs/feat/session-apps-container-ports.md S3): the secret gate, the
 * container re-checked, then ONE fresh loopback connection (`keepalive: false`,
 * no redirect followed) or one WebSocket, relayed under the tunnel's credit.
 */
import {
  APPS_TUNNEL_CHUNK_BYTES,
  APPS_TUNNEL_MAX_WS_BYTES,
  type TunnelFrame,
  TunnelInbox,
  TunnelOutbox,
  type TunnelRequest,
} from "@tentacle/protocol";
import type { PreviewDialTarget } from "./session-previews.ts";
import { filterResponseHeaders, shareGate, upstreamRequest } from "./share-gate.ts";

export interface ShareStreamHost {
  readonly secret: string | undefined;
  /** `https://<id>.<domain>`. */
  readonly publicOrigin: string;
  connect(): Promise<PreviewDialTarget>;
  /** `false`: the frame cannot be sent (too large, or the tunnel is gone). */
  send(frame: TunnelFrame): boolean;
  done(stream: number): void;
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}

/** The upstream WebSocket as Bun gives it. */
interface UpstreamSocket {
  binaryType: string;
  readonly protocol: string;
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
}

/** Bytes held for a slow end before the stream is given up. */
const MAX_HELD_BYTES = 4 * APPS_TUNNEL_MAX_WS_BYTES;
const encoder = new TextEncoder();
const sizeOf = (message: string | Uint8Array): number =>
  typeof message === "string" ? encoder.encode(message).length : message.length;

/** A close code a WebSocket client may send. */
const clientCode = (code: number): number =>
  code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;

export class ShareStream {
  private readonly inbox = new TunnelInbox();
  private readonly outbox = new TunnelOutbox();
  private readonly abort = new AbortController();
  private closed = false;
  private wakeSender: (() => void) | undefined;

  // the request body
  private readonly body: Uint8Array[] = [];
  private bodyEnded = false;
  private wakeBody: (() => void) | undefined;

  // the upstream WebSocket
  private socket: UpstreamSocket | undefined;
  private readonly held: (string | Uint8Array)[] = [];
  private heldBytes = 0;
  private upstreamClose: { code: number; reason: string } | undefined;

  constructor(
    readonly id: number,
    private readonly request: TunnelRequest,
    private readonly host: ShareStreamHost,
  ) {}

  async run(): Promise<void> {
    try {
      await this.serve();
    } catch {
      // Never the error's text: it may quote the request.
      this.answer(502, "the service could not be reached\n");
    }
  }

  private async serve(): Promise<void> {
    const gate = shareGate(this.request, this.host.secret);
    if (gate.kind === "respond") {
      this.reply(gate.status, gate.headers, gate.body);
      return;
    }
    const target = await this.host.connect();
    if (this.closed) return;
    if (!target.ok) {
      this.answer(502, "the service is not there\n");
      return;
    }
    const upstream = upstreamRequest(
      { ...this.request, headers: gate.headers },
      { hostPort: target.hostPort, publicOrigin: this.host.publicOrigin },
    );
    if (upstream === undefined) {
      this.answer(400, "bad request\n");
      return;
    }
    if (this.request.ws !== undefined) {
      this.openSocket(upstream.url, upstream.headers, this.request.ws.protocols);
      return;
    }
    const { method } = this.request;
    const bodyless = method === "GET" || method === "HEAD";
    const response = await this.host.fetch(upstream.url, {
      method,
      headers: upstream.headers,
      ...(bodyless ? {} : { body: this.requestBody(), duplex: "half" }),
      // One connection per request (so the port is the one just checked), and a
      // redirect is the visitor's to follow, never ours.
      keepalive: false,
      redirect: "manual",
      // The bytes as the service sent them: its Content-Encoding stays true.
      decompress: false,
      signal: this.abort.signal,
    } as RequestInit);
    if (this.closed) {
      void response.body?.cancel();
      return;
    }
    const headers: [string, string][] = [];
    response.headers.forEach((value, name) => {
      if (name !== "set-cookie") headers.push([name, value]);
    });
    for (const cookie of response.headers.getSetCookie()) {
      headers.push(["set-cookie", cookie]);
    }
    const head: TunnelFrame = {
      type: "head",
      stream: this.id,
      response: { status: response.status, headers: filterResponseHeaders(headers) },
    };
    if (!this.host.send(head)) {
      void response.body?.cancel();
      this.answer(502, "the service answered with too many headers\n");
      return;
    }
    if (response.body !== null && method !== "HEAD") {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        if (!(await this.sendData(chunk))) return;
      }
    }
    this.host.send({ type: "end", stream: this.id });
    this.finish();
  }

  /** A whole answer made here. */
  private reply(status: number, headers: [string, string][], body: string): void {
    if (this.closed) return;
    this.host.send({ type: "head", stream: this.id, response: { status, headers } });
    // A refused handshake has a status only.
    if (this.request.ws === undefined) {
      if (body !== "") {
        this.host.send({ type: "data", stream: this.id, bytes: encoder.encode(body) });
      }
      this.host.send({ type: "end", stream: this.id });
    }
    this.finish();
  }

  private answer(status: number, body: string): void {
    this.reply(status, [["content-type", "text/plain; charset=utf-8"]], body);
  }

  private async sendData(bytes: Uint8Array): Promise<boolean> {
    for (let at = 0; at < bytes.length; at += APPS_TUNNEL_CHUNK_BYTES) {
      const chunk = bytes.subarray(at, at + APPS_TUNNEL_CHUNK_BYTES);
      while (!this.closed && !this.outbox.take(chunk.length, "data")) {
        await new Promise<void>((resolve) => {
          this.wakeSender = resolve;
        });
      }
      if (this.closed) return false;
      this.host.send({ type: "data", stream: this.id, bytes: chunk });
    }
    return true;
  }

  /** The visitor's upload: a chunk is acked as the upstream takes it. */
  private requestBody(): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.body.length === 0 && !this.bodyEnded && !this.closed) {
          await new Promise<void>((resolve) => {
            this.wakeBody = resolve;
          });
        }
        const chunk = this.body.shift();
        if (chunk === undefined) {
          if (this.bodyEnded) controller.close();
          else controller.error(new Error("the request was cut short"));
          return;
        }
        controller.enqueue(chunk);
        this.ack(chunk.length);
      },
    });
  }

  private ack(bytes: number): void {
    this.inbox.release(bytes);
    if (!this.closed && bytes > 0) this.host.send({ type: "ack", stream: this.id, bytes });
  }

  private openSocket(url: string, headers: [string, string][], protocols: string[]): void {
    const Socket = WebSocket as unknown as new (
      url: string,
      options: { headers: Record<string, string>; protocols?: string[] },
    ) => UpstreamSocket;
    const socket = new Socket(url.replace(/^http/, "ws"), {
      headers: Object.fromEntries(headers),
      ...(protocols.length > 0 ? { protocols } : {}),
    });
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    let open = false;
    socket.onopen = () => {
      open = true;
      this.host.send({
        type: "head",
        stream: this.id,
        response: {
          status: 101,
          headers: [],
          ...(socket.protocol === "" ? {} : { protocol: socket.protocol }),
        },
      });
    };
    socket.onmessage = (event) => {
      if (this.closed) return;
      const message =
        typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const size = sizeOf(message);
      if (size > APPS_TUNNEL_MAX_WS_BYTES || this.heldBytes + size > MAX_HELD_BYTES) {
        this.reset("too much data");
        return;
      }
      this.held.push(message);
      this.heldBytes += size;
      this.flush();
    };
    socket.onclose = (event) => {
      if (this.closed) return;
      if (!open) {
        this.answer(502, "");
        return;
      }
      this.upstreamClose = { code: event.code, reason: event.reason };
      this.flush();
    };
  }

  /** Send what the window allows; then the upstream's close, if it closed. */
  private flush(): void {
    for (;;) {
      if (this.closed) return;
      const message = this.held[0];
      if (message === undefined) break;
      const size = sizeOf(message);
      if (size > 0 && !this.outbox.take(size, "ws")) return;
      this.held.shift();
      this.heldBytes -= size;
      this.host.send(
        typeof message === "string"
          ? { type: "ws_text", stream: this.id, text: message }
          : { type: "ws_bin", stream: this.id, bytes: message },
      );
    }
    const close = this.upstreamClose;
    if (close === undefined) return;
    this.host.send({
      type: "ws_close",
      stream: this.id,
      code: close.code >= 1000 && close.code <= 4999 ? close.code : 1000,
      reason: close.reason.slice(0, 120),
    });
    this.finish();
  }

  /** A frame of the host. `false`: it breaks the protocol (the tunnel closes). */
  receive(frame: TunnelFrame): boolean {
    switch (frame.type) {
      case "data": {
        if (this.request.ws !== undefined || this.bodyEnded) return false;
        if (!this.inbox.admit(frame.bytes.length, "data")) return false;
        const { method } = this.request;
        if (method === "GET" || method === "HEAD") {
          this.ack(frame.bytes.length);
        } else {
          this.body.push(frame.bytes);
          this.wakeBody?.();
        }
        return true;
      }
      case "end":
        if (this.request.ws !== undefined || this.bodyEnded) return false;
        this.bodyEnded = true;
        this.wakeBody?.();
        return true;
      case "ack":
        if (!this.outbox.ack(frame.bytes)) return false;
        this.wakeSender?.();
        this.flush();
        return true;
      case "reset":
        this.finish();
        return true;
      case "ws_text":
      case "ws_bin": {
        const socket = this.socket;
        if (this.request.ws === undefined || socket === undefined) return false;
        const message = frame.type === "ws_text" ? frame.text : frame.bytes;
        const size = sizeOf(message);
        if (!this.inbox.admit(size, "ws")) return false;
        if (socket.bufferedAmount > MAX_HELD_BYTES) {
          this.reset("the service cannot keep up");
          return true;
        }
        socket.send(message);
        this.ack(size);
        return true;
      }
      case "ws_close":
        if (this.request.ws === undefined) return false;
        this.socket?.close(clientCode(frame.code), frame.reason.slice(0, 120));
        this.socket = undefined;
        this.finish();
        return true;
      default:
        return false;
    }
  }

  /** This side gives up: tell the host. */
  private reset(reason: string): void {
    if (this.closed) return;
    this.host.send({ type: "reset", stream: this.id, reason });
    this.finish();
  }

  /** Over: the upstream is closed and everything waiting is woken. Idempotent. */
  finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.wakeSender?.();
    this.wakeBody?.();
    this.socket?.close(1000);
    this.socket = undefined;
    // A request still running upstream is cut; a finished one ignores this.
    this.abort.abort();
    this.host.done(this.id);
  }
}
