/**
 * T-C1: the Noise channel's raw WebSocket carrier (docs/feat/noise-binary-carrier.md
 * §6). A dumb adapter: `binaryType` pinned before any message, every frame handed
 * up exactly as the socket gave it (bytes over the right window, or a text frame
 * for the Noise layer to diagnose), anything else closes — never `String(x)`.
 */
import { describe, expect, test } from "bun:test";
import type { CarrierFrame } from "@tentacle/transport";
import { WebSocketCarrier, webSocketCarrierFactory } from "../src/ws-channel.ts";

type Listener = (event: { data?: unknown; code?: number }) => void;

class FakeSocket {
  binaryType = "nodebuffer";
  /** What `binaryType` was when the first message was dispatched. */
  binaryTypeAtFirstMessage: string | undefined;
  readonly sent: (string | Uint8Array)[] = [];
  closed = 0;
  private readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
  emit(type: string, event: { data?: unknown; code?: number } = {}): void {
    if (type === "message" && this.binaryTypeAtFirstMessage === undefined) {
      this.binaryTypeAtFirstMessage = this.binaryType;
    }
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

function carrier() {
  const ws = new FakeSocket();
  const c = new WebSocketCarrier(ws);
  const got: CarrierFrame[] = [];
  let closes = 0;
  c.setOnMessage((f) => got.push(f));
  c.setOnClose(() => {
    closes += 1;
  });
  return { ws, c, got, closes: () => closes };
}

describe("WebSocketCarrier (T-C1)", () => {
  test("binaryType is `arraybuffer` before the first message", () => {
    const { ws } = carrier();
    ws.emit("message", { data: new ArrayBuffer(1) });
    expect(ws.binaryTypeAtFirstMessage).toBe("arraybuffer");
  });

  test("an ArrayBuffer, a view at offset 3 and a string are delivered as received", () => {
    const { ws, got } = carrier();
    ws.emit("message", { data: Uint8Array.of(1, 2, 3).buffer });
    const slab = new Uint8Array(12).map((_, i) => i * 10);
    ws.emit("message", { data: new Uint8Array(slab.buffer, 3, 4) });
    ws.emit("message", { data: "t1:AAAA" });
    expect(got.map((f) => (typeof f === "string" ? f : Array.from(f)))).toEqual([
      [1, 2, 3],
      [30, 40, 50, 60],
      "t1:AAAA",
    ]);
  });

  test("a Blob-like frame closes the carrier at once, never stringified", () => {
    const { ws, got, closes } = carrier();
    ws.emit("message", { data: { toString: () => "t1:AAAA", size: 7 } });
    expect(got).toEqual([]);
    expect(ws.closed).toBe(1);
    expect(closes()).toBe(1);
    // Nothing after the close is delivered.
    ws.emit("message", { data: Uint8Array.of(9).buffer });
    expect(got).toEqual([]);
  });

  test("send writes the bytes; a closed carrier sends nothing", () => {
    const { ws, c } = carrier();
    c.send(Uint8Array.of(2, 7));
    ws.emit("close");
    c.send(Uint8Array.of(3));
    expect(ws.sent).toEqual([Uint8Array.of(2, 7)]);
  });

  test("webSocketCarrierFactory resolves a carrier on open, through the injected constructor", async () => {
    let made: FakeSocket | undefined;
    const Ctor = class extends FakeSocket {
      constructor() {
        super();
        made = this;
        queueMicrotask(() => this.emit("open"));
      }
    };
    const c = await webSocketCarrierFactory("ws://h:1/e2e", {}, { WebSocket: Ctor })();
    expect(c).toBeInstanceOf(WebSocketCarrier);
    expect(made?.binaryType).toBe("arraybuffer");
  });
});
