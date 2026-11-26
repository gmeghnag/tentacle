/**
 * The apps tunnel (docs/feat/session-apps-container-ports.md): the one outbound
 * WebSocket a `serve` dials to the apps host for one live app, and what flows on
 * it. The shared truth of both ends. Pure: bytes in, values out.
 *
 * Each binary WebSocket message is `[u8 type][u32 BE stream][payload]`. Only the
 * host opens streams. A frame that does not decode, a window overrun or an
 * unknown stream closes the whole tunnel.
 */
import { z } from "zod";
import { PREVIEW_CHUNK_BYTES, PREVIEW_WINDOW_BYTES } from "./preview.ts";

export interface TunnelRequest {
  readonly method: string;
  /** The request target as the visitor sent it (path and query). */
  readonly target: string;
  readonly headers: [string, string][];
  /** A WebSocket handshake: the subprotocols the visitor offered. */
  readonly ws?: { readonly protocols: string[] } | undefined;
}

export interface TunnelResponse {
  /** 101 answers a WebSocket handshake. */
  readonly status: number;
  readonly headers: [string, string][];
  /** The subprotocol chosen by the upstream (101 only). */
  readonly protocol?: string | undefined;
}

export type TunnelFrame =
  | { readonly type: "open"; readonly stream: number; readonly request: TunnelRequest }
  | { readonly type: "head"; readonly stream: number; readonly response: TunnelResponse }
  | { readonly type: "data"; readonly stream: number; readonly bytes: Uint8Array }
  | { readonly type: "end"; readonly stream: number }
  | { readonly type: "ack"; readonly stream: number; readonly bytes: number }
  | { readonly type: "reset"; readonly stream: number; readonly reason: string }
  | { readonly type: "ws_text"; readonly stream: number; readonly text: string }
  | { readonly type: "ws_bin"; readonly stream: number; readonly bytes: Uint8Array }
  | {
      readonly type: "ws_close";
      readonly stream: number;
      readonly code: number;
      readonly reason: string;
    };

/** The largest raw payload of one DATA frame. */
export const APPS_TUNNEL_CHUNK_BYTES = PREVIEW_CHUNK_BYTES;
/** Un-acked bytes allowed in flight, per direction per stream. */
export const APPS_TUNNEL_WINDOW_BYTES = PREVIEW_WINDOW_BYTES;
export const APPS_TUNNEL_MAX_WS_BYTES = 1024 * 1024;
export const APPS_TUNNEL_MAX_OPEN_BYTES = 16 * 1024;
export const APPS_TUNNEL_MAX_HEAD_BYTES = 32 * 1024;
export const APPS_TUNNEL_MAX_HEADERS = 100;
export const APPS_TUNNEL_MAX_REASON = 500;
/** `[u8 type][u32 BE stream]`. */
const HEADER_BYTES = 5;
/** The largest binary message of the tunnel. */
export const APPS_TUNNEL_MAX_FRAME_BYTES = HEADER_BYTES + APPS_TUNNEL_MAX_WS_BYTES;
/** How often each end checks that the other still answers. */
export const APPS_TUNNEL_PING_MS = 30_000;

/**
 * WebSocket close codes of the tunnel itself. `refused`: the host accepted the
 * signed upgrade only to say why it will not serve it (the reason is an
 * `AppsErrorCode`). `ended`: the host ended a running tunnel (same reasons).
 */
export const APPS_TUNNEL_CLOSE = {
  normal: 1000,
  protocol: 1008,
  refused: 4001,
  replaced: 4002,
  ended: 4003,
} as const;

const TYPE = {
  open: 1,
  head: 2,
  data: 3,
  end: 4,
  ack: 5,
  reset: 6,
  ws_text: 7,
  ws_bin: 8,
  ws_close: 9,
} as const;
const TYPES = Object.keys(TYPE) as (keyof typeof TYPE)[];

const HeadersSchema = z
  .array(z.tuple([z.string().min(1), z.string()]))
  .max(APPS_TUNNEL_MAX_HEADERS);
const RequestSchema = z.object({
  method: z.string().min(1).max(32),
  target: z.string().min(1),
  headers: HeadersSchema,
  ws: z.object({ protocols: z.array(z.string()).max(32) }).optional(),
});
const ResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  headers: HeadersSchema,
  protocol: z.string().max(256).optional(),
});
const ResetSchema = z.object({ reason: z.string().max(APPS_TUNNEL_MAX_REASON) });
const CloseSchema = z.object({
  code: z.number().int().min(1000).max(4999),
  reason: z.string().max(APPS_TUNNEL_MAX_REASON),
});

const encoder = new TextEncoder();
const empty = new Uint8Array(0);

function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function parsed<T>(bytes: Uint8Array, schema: z.ZodType<T>): T | undefined {
  const text = utf8(bytes);
  if (text === undefined) return undefined;
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/** The most payload a frame type may carry. */
function maxPayload(type: keyof typeof TYPE): number {
  switch (type) {
    case "open":
      return APPS_TUNNEL_MAX_OPEN_BYTES;
    case "head":
      return APPS_TUNNEL_MAX_HEAD_BYTES;
    case "data":
      return APPS_TUNNEL_CHUNK_BYTES;
    case "ws_text":
    case "ws_bin":
      return APPS_TUNNEL_MAX_WS_BYTES;
    case "end":
      return 0;
    case "ack":
      return 4;
    default:
      // reset / ws_close: a reason of `APPS_TUNNEL_MAX_REASON` characters, escaped.
      return 8 * APPS_TUNNEL_MAX_REASON;
  }
}

function payloadOf(frame: TunnelFrame): Uint8Array {
  switch (frame.type) {
    case "open":
      return encoder.encode(JSON.stringify(frame.request));
    case "head":
      return encoder.encode(JSON.stringify(frame.response));
    case "data":
    case "ws_bin":
      return frame.bytes;
    case "ws_text":
      return encoder.encode(frame.text);
    case "ack": {
      const out = new Uint8Array(4);
      new DataView(out.buffer).setUint32(0, frame.bytes);
      return out;
    }
    case "reset":
      return encoder.encode(
        JSON.stringify({ reason: frame.reason.slice(0, APPS_TUNNEL_MAX_REASON) }),
      );
    case "ws_close":
      return encoder.encode(
        JSON.stringify({ code: frame.code, reason: frame.reason.slice(0, APPS_TUNNEL_MAX_REASON) }),
      );
    default:
      return empty;
  }
}

/** `undefined`: the frame is too large or has too many headers (it is not sent). */
export function encodeTunnelFrame(frame: TunnelFrame): Uint8Array | undefined {
  const headers =
    frame.type === "open"
      ? frame.request.headers
      : frame.type === "head"
        ? frame.response.headers
        : undefined;
  if (headers !== undefined && headers.length > APPS_TUNNEL_MAX_HEADERS) return undefined;
  const payload = payloadOf(frame);
  if (payload.length > maxPayload(frame.type)) return undefined;
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  out[0] = TYPE[frame.type];
  new DataView(out.buffer).setUint32(1, frame.stream);
  out.set(payload, HEADER_BYTES);
  return out;
}

/** `undefined`: not a frame of this wire. Never throws. */
export function decodeTunnelFrame(message: Uint8Array): TunnelFrame | undefined {
  if (message.length < HEADER_BYTES) return undefined;
  const type = TYPES.find((name) => TYPE[name] === message[0]);
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  const stream = view.getUint32(1);
  const payload = message.subarray(HEADER_BYTES);
  if (type === undefined || stream === 0 || payload.length > maxPayload(type)) return undefined;
  switch (type) {
    case "open": {
      const request = parsed(payload, RequestSchema);
      return request === undefined ? undefined : { type, stream, request };
    }
    case "head": {
      const response = parsed(payload, ResponseSchema);
      return response === undefined ? undefined : { type, stream, response };
    }
    case "data":
    case "ws_bin":
      // A copy: the caller may keep it past this message's buffer.
      return { type, stream, bytes: new Uint8Array(payload) };
    case "ws_text": {
      const text = utf8(payload);
      return text === undefined ? undefined : { type, stream, text };
    }
    case "end":
      return { type, stream };
    case "ack": {
      if (payload.length !== 4) return undefined;
      const bytes = view.getUint32(HEADER_BYTES);
      return bytes === 0 ? undefined : { type, stream, bytes };
    }
    case "reset": {
      const reset = parsed(payload, ResetSchema);
      return reset === undefined ? undefined : { type, stream, reason: reset.reason };
    }
    case "ws_close": {
      const close = parsed(payload, CloseSchema);
      return close === undefined ? undefined : { type, stream, ...close };
    }
  }
}

/**
 * What a frame costs against the window: DATA fits inside it; a WebSocket
 * message (up to `APPS_TUNNEL_MAX_WS_BYTES`) needs only a window not yet full,
 * so one may pass it.
 */
export type TunnelCost = "data" | "ws";

const fits = (held: number, bytes: number, cost: TunnelCost): boolean =>
  cost === "ws" ? held < APPS_TUNNEL_WINDOW_BYTES : held + bytes <= APPS_TUNNEL_WINDOW_BYTES;

/** The sending side of one stream direction. */
export class TunnelOutbox {
  private held = 0;

  /** `true`: the bytes are now in flight and may be sent. */
  take(bytes: number, cost: TunnelCost): boolean {
    if (!fits(this.held, bytes, cost)) return false;
    this.held += bytes;
    return true;
  }

  /** `false`: the peer acked more than was sent. */
  ack(bytes: number): boolean {
    if (bytes > this.held) return false;
    this.held -= bytes;
    return true;
  }
}

/** The receiving side of one stream direction. */
export class TunnelInbox {
  private held = 0;

  /** `false`: the peer overran the window. */
  admit(bytes: number, cost: TunnelCost): boolean {
    if (!fits(this.held, bytes, cost)) return false;
    this.held += bytes;
    return true;
  }

  /** The bytes were consumed (and acked). */
  release(bytes: number): void {
    this.held = Math.max(0, this.held - bytes);
  }
}
