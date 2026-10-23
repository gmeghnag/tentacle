/**
 * The React Native WebSocket constructor shim (docs/feat/mobile-spike.md): RN's
 * constructor is `(url, protocols, options)`, the client's factory calls
 * `new Ctor(url, init)`. No RN import: `FakeRN` mimics RN's shape (it extends
 * `EventTarget` and records its constructor arguments).
 */
import { describe, expect, test } from "bun:test";
import { ChannelError, webSocketChannelFactory } from "@tentacle/client";
import { rnWebSocketCtor } from "../src/rn-websocket.ts";

class FakeRN extends EventTarget {
  static last: FakeRN | undefined;
  readonly args: readonly unknown[];
  readonly sent: string[] = [];
  closed = 0;
  constructor(...args: unknown[]) {
    super();
    this.args = args;
    FakeRN.last = this;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed += 1;
  }
}

function lastSocket(): FakeRN {
  const ws = FakeRN.last;
  if (ws === undefined) {
    throw new Error("no socket was constructed");
  }
  return ws;
}

function closeEvent(code: number): Event {
  return Object.assign(new Event("close"), { code });
}

describe("rnWebSocketCtor", () => {
  test("calls RN as (url, undefined, init): no protocols, the headers under the 3rd argument", () => {
    const Ctor = rnWebSocketCtor(FakeRN);
    new Ctor("ws://h:1/", { headers: { Authorization: "Bearer t" } });
    expect(lastSocket().args).toEqual([
      "ws://h:1/",
      undefined,
      { headers: { Authorization: "Bearer t" } },
    ]);
  });

  test("through the real factory: ?token= on the URL, headers to RN's options, events reach the channel", async () => {
    FakeRN.last = undefined;
    const dial = webSocketChannelFactory(
      "ws://h:1/",
      { token: "t" },
      { WebSocket: rnWebSocketCtor(FakeRN) },
    );
    const pending = dial();
    const ws = lastSocket();
    expect(ws.args).toEqual([
      "ws://h:1/?token=t",
      undefined,
      { headers: { Authorization: "Bearer t" } },
    ]);
    ws.dispatchEvent(new Event("open"));
    const channel = await pending;

    const received: string[] = [];
    let closes = 0;
    channel.setOnMessage((data) => received.push(data));
    channel.setOnClose(() => {
      closes += 1;
    });
    ws.dispatchEvent(new MessageEvent("message", { data: '{"jsonrpc":"2.0"}' }));
    expect(received).toEqual(['{"jsonrpc":"2.0"}']);

    channel.send("frame");
    expect(ws.sent).toEqual(["frame"]);

    ws.dispatchEvent(closeEvent(1000));
    ws.dispatchEvent(new Event("error"));
    expect(closes).toBe(1);
  });

  test("a close 1006 before open rejects with an unreachable ChannelError (today's RN classification)", async () => {
    FakeRN.last = undefined;
    const dial = webSocketChannelFactory(
      "ws://h:1/",
      { token: "t" },
      { WebSocket: rnWebSocketCtor(FakeRN) },
    );
    const pending = dial();
    lastSocket().dispatchEvent(closeEvent(1006));
    let error: unknown;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ChannelError);
    if (error instanceof ChannelError) {
      expect(error.kind).toBe("unreachable");
      expect(error.closeCode).toBe(1006);
    }
  });
});
