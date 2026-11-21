import { describe, expect, test } from "bun:test";
import {
  type CarrierFrame,
  carrierFrameOf,
  createByteCarrierPair,
  createChannelPair,
} from "../src/channel.ts";

const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r));

describe("byte carrier (docs/feat/noise-binary-carrier.md)", () => {
  test("createByteCarrierPair delivers bytes asynchronously; a close closes both", async () => {
    const [a, b] = createByteCarrierPair();
    const got: CarrierFrame[] = [];
    let closes = 0;
    b.setOnMessage((f) => got.push(f));
    b.setOnClose(() => {
      closes += 1;
    });
    a.send(Uint8Array.of(1, 2, 3));
    expect(got).toEqual([]);
    await tick();
    expect(got).toEqual([Uint8Array.of(1, 2, 3)]);
    a.close();
    a.send(Uint8Array.of(4));
    await tick();
    expect(closes).toBe(1);
    expect(got.length).toBe(1);
  });

  test("F12: carrierFrameOf keeps exactly a view's bytes (offset > 0 in a larger slab)", () => {
    const slab = new Uint8Array(16).map((_, i) => i);
    const view = Buffer.from(slab.buffer, 3, 5);
    const out = carrierFrameOf(view);
    expect(out instanceof Uint8Array && Array.from(out)).toEqual([3, 4, 5, 6, 7]);
    const ab = carrierFrameOf(Uint8Array.of(9, 8).buffer);
    expect(ab instanceof Uint8Array && Array.from(ab)).toEqual([9, 8]);
    const dv = carrierFrameOf(new DataView(slab.buffer, 14, 2));
    expect(dv instanceof Uint8Array && Array.from(dv)).toEqual([14, 15]);
    expect(carrierFrameOf("t1:AAAA")).toBe("t1:AAAA");
  });

  test("F13: anything not string/ArrayBuffer/view is null (never String(x))", () => {
    expect(carrierFrameOf(new Blob(["x"]))).toBeNull();
    expect(carrierFrameOf({ toString: () => "t1:AAAA" })).toBeNull();
    expect(carrierFrameOf(undefined)).toBeNull();
  });
});

describe("createChannelPair", () => {
  test("delivers a frame to the other end asynchronously", async () => {
    const [a, b] = createChannelPair();
    const received: string[] = [];
    b.setOnMessage((d) => received.push(d));
    a.send("hello");
    expect(received).toEqual([]); // not yet — delivery is deferred
    await tick();
    expect(received).toEqual(["hello"]);
  });

  test("closing one end closes both and fires onClose", async () => {
    const [a, b] = createChannelPair();
    let aClosed = false;
    let bClosed = false;
    a.setOnClose(() => {
      aClosed = true;
    });
    b.setOnClose(() => {
      bClosed = true;
    });
    a.close();
    await tick();
    expect(aClosed).toBe(true);
    expect(bClosed).toBe(true);
  });

  test("sends after close are dropped", async () => {
    const [a, b] = createChannelPair();
    const received: string[] = [];
    b.setOnMessage((d) => received.push(d));
    a.close();
    a.send("dropped");
    await tick();
    expect(received).toEqual([]);
  });
});
