import { describe, expect, test } from "bun:test";
import {
  APPS_TUNNEL_CHUNK_BYTES,
  APPS_TUNNEL_MAX_HEADERS,
  APPS_TUNNEL_MAX_OPEN_BYTES,
  APPS_TUNNEL_MAX_WS_BYTES,
  APPS_TUNNEL_WINDOW_BYTES,
  type TunnelFrame,
  TunnelInbox,
  TunnelOutbox,
  decodeTunnelFrame,
  encodeTunnelFrame,
} from "../src/apps-tunnel.ts";

const bytes = (n: number, fill = 7): Uint8Array => new Uint8Array(n).fill(fill);

/** A raw frame, built without the encoder (what a hostile peer sends). */
function raw(type: number, stream: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, stream);
  out.set(payload, 5);
  return out;
}

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

const FRAMES: TunnelFrame[] = [
  {
    type: "open",
    stream: 1,
    request: {
      method: "GET",
      target: "/a?b=c",
      headers: [
        ["accept", "*/*"],
        ["cookie", "a=1"],
      ],
    },
  },
  {
    type: "open",
    stream: 2,
    request: { method: "GET", target: "/ws", headers: [], ws: { protocols: ["vite-hmr"] } },
  },
  { type: "head", stream: 1, response: { status: 200, headers: [["x", "y"]] } },
  { type: "head", stream: 2, response: { status: 101, headers: [], protocol: "vite-hmr" } },
  { type: "data", stream: 1, bytes: bytes(3) },
  { type: "end", stream: 1 },
  { type: "ack", stream: 4_294_967_295, bytes: 70_000 },
  { type: "reset", stream: 1, reason: "gone" },
  { type: "ws_text", stream: 2, text: "héllo" },
  { type: "ws_bin", stream: 2, bytes: bytes(5, 9) },
  { type: "ws_close", stream: 2, code: 1000, reason: "bye" },
];

describe("apps tunnel codec", () => {
  test("round-trips every frame type", () => {
    for (const frame of FRAMES) {
      const encoded = encodeTunnelFrame(frame);
      expect(encoded).toBeDefined();
      expect(decodeTunnelFrame(encoded ?? bytes(0))).toEqual(frame);
    }
  });

  test("refuses a truncated header, an unknown type and stream 0", () => {
    expect(decodeTunnelFrame(bytes(0))).toBeUndefined();
    expect(decodeTunnelFrame(new Uint8Array([4, 0, 0, 0]))).toBeUndefined();
    expect(decodeTunnelFrame(raw(0, 1, bytes(0)))).toBeUndefined();
    expect(decodeTunnelFrame(raw(10, 1, bytes(0)))).toBeUndefined();
    expect(decodeTunnelFrame(raw(4, 0, bytes(0)))).toBeUndefined();
  });

  test("refuses an oversize OPEN, from the encoder and from the wire", () => {
    const request = {
      method: "GET",
      target: `/${"a".repeat(APPS_TUNNEL_MAX_OPEN_BYTES)}`,
      headers: [],
    };
    expect(encodeTunnelFrame({ type: "open", stream: 1, request })).toBeUndefined();
    expect(decodeTunnelFrame(raw(1, 1, json(request)))).toBeUndefined();
  });

  test("refuses too many headers", () => {
    const headers = Array.from({ length: APPS_TUNNEL_MAX_HEADERS + 1 }, (_, i) => [`h${i}`, "v"]);
    expect(
      decodeTunnelFrame(raw(1, 1, json({ method: "GET", target: "/", headers }))),
    ).toBeUndefined();
    expect(decodeTunnelFrame(raw(2, 1, json({ status: 200, headers })))).toBeUndefined();
  });

  test("refuses oversize DATA and WebSocket messages", () => {
    expect(decodeTunnelFrame(raw(3, 1, bytes(APPS_TUNNEL_CHUNK_BYTES)))).toBeDefined();
    expect(decodeTunnelFrame(raw(3, 1, bytes(APPS_TUNNEL_CHUNK_BYTES + 1)))).toBeUndefined();
    expect(
      encodeTunnelFrame({ type: "data", stream: 1, bytes: bytes(APPS_TUNNEL_CHUNK_BYTES + 1) }),
    ).toBeUndefined();
    expect(decodeTunnelFrame(raw(8, 1, bytes(APPS_TUNNEL_MAX_WS_BYTES)))).toBeDefined();
    expect(decodeTunnelFrame(raw(8, 1, bytes(APPS_TUNNEL_MAX_WS_BYTES + 1)))).toBeUndefined();
    expect(decodeTunnelFrame(raw(7, 1, bytes(APPS_TUNNEL_MAX_WS_BYTES + 1, 97)))).toBeUndefined();
  });

  test("refuses malformed payloads without throwing", () => {
    for (const [type, payload] of [
      [1, bytes(4, 123)],
      [1, json({ method: "GET", target: "/" })],
      [1, json({ method: "", target: "/", headers: [] })],
      [2, json({ status: "200", headers: [] })],
      [2, json({ status: 99, headers: [] })],
      [2, json({ status: 200, headers: [["a"]] })],
      [4, bytes(1)],
      [5, bytes(3)],
      [5, bytes(4, 0)],
      [6, json({})],
      [7, new Uint8Array([0xff, 0xfe])],
      [9, json({ code: "1000", reason: "" })],
    ] as const) {
      expect(decodeTunnelFrame(raw(type, 1, payload))).toBeUndefined();
    }
  });
});

describe("apps tunnel credit", () => {
  test("DATA never exceeds the window until an ACK", () => {
    const out = new TunnelOutbox();
    const chunks = APPS_TUNNEL_WINDOW_BYTES / APPS_TUNNEL_CHUNK_BYTES;
    for (let i = 0; i < chunks; i++) {
      expect(out.take(APPS_TUNNEL_CHUNK_BYTES, "data")).toBe(true);
    }
    expect(out.take(1, "data")).toBe(false);
    expect(out.ack(APPS_TUNNEL_CHUNK_BYTES)).toBe(true);
    expect(out.take(1, "data")).toBe(true);
  });

  test("a receiver refuses an overrun", () => {
    const inbox = new TunnelInbox();
    expect(inbox.admit(APPS_TUNNEL_WINDOW_BYTES, "data")).toBe(true);
    expect(inbox.admit(1, "data")).toBe(false);
    inbox.release(10);
    expect(inbox.admit(10, "data")).toBe(true);
  });

  test("one WebSocket message may pass the window, the next waits", () => {
    const out = new TunnelOutbox();
    const inbox = new TunnelInbox();
    expect(out.take(APPS_TUNNEL_MAX_WS_BYTES, "ws")).toBe(true);
    expect(inbox.admit(APPS_TUNNEL_MAX_WS_BYTES, "ws")).toBe(true);
    expect(out.take(1, "ws")).toBe(false);
    expect(inbox.admit(1, "ws")).toBe(false);
  });

  test("an ACK for more than is in flight is an error", () => {
    const out = new TunnelOutbox();
    out.take(5, "data");
    expect(out.ack(6)).toBe(false);
  });
});
