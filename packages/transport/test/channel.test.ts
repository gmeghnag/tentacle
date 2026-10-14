import { describe, expect, test } from "bun:test";
import { createChannelPair } from "../src/channel.ts";

const tick = (): Promise<void> => new Promise((r) => queueMicrotask(r));

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
