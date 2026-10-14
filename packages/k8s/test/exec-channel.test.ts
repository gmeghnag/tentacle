import { describe, expect, test } from "bun:test";
import { KubeClient } from "../src/client.ts";
import {
  type WebSocketLike,
  buildExecUrl,
  execChannel,
  execSubprotocols,
} from "../src/exec-channel.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function msg(channel: number, text: string): Uint8Array {
  const body = enc.encode(text);
  const out = new Uint8Array(body.length + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
}

/** An in-memory WebSocket for driving the exec channel deterministically. */
class FakeWS implements WebSocketLike {
  binaryType = "";
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Array<(ev: { data: unknown }) => void>>();

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.emit("close", { data: null });
  }
  addEventListener(type: string, handler: (ev: { data: unknown }) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(handler);
    this.listeners.set(type, arr);
  }
  private emit(type: string, ev: { data: unknown }): void {
    for (const h of this.listeners.get(type) ?? []) {
      h(ev);
    }
  }
  /** Simulate an inbound server message. */
  receive(bytes: Uint8Array): void {
    this.emit("message", { data: bytes });
  }
}

describe("execChannel", () => {
  test("sends RPC frames on the stdin channel", () => {
    const ws = new FakeWS();
    const channel = execChannel(ws);
    channel.send('{"x":1}');
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0] as Uint8Array;
    expect(frame[0]).toBe(0); // stdin channel
    expect(dec.decode(frame.subarray(1))).toBe('{"x":1}\n');
  });

  test("delivers inbound stdout frames, reassembled across messages", () => {
    const ws = new FakeWS();
    const channel = execChannel(ws);
    const got: string[] = [];
    channel.setOnMessage((m) => got.push(m));

    ws.receive(msg(1, '{"y":'));
    expect(got).toEqual([]);
    ws.receive(msg(1, "2}\n"));
    expect(got).toEqual(['{"y":2}']);
  });

  test("surfaces stderr and fires onClose when the socket closes", () => {
    const ws = new FakeWS();
    const stderr: string[] = [];
    const channel = execChannel(ws, { onStderr: (s) => stderr.push(s) });
    let closed = false;
    channel.setOnClose(() => {
      closed = true;
    });

    ws.receive(msg(2, "container warning"));
    expect(stderr).toEqual(["container warning"]);

    ws.close();
    expect(closed).toBe(true);
  });
});

describe("buildExecUrl", () => {
  test("maps https→wss and encodes command + stream flags", () => {
    const url = buildExecUrl("https://api.cluster:6443", "dev", {
      pod: "agent-1",
      container: "main",
      command: ["agent-harness", "serve", "--stdio"],
    });
    expect(url.startsWith("wss://api.cluster:6443/api/v1/namespaces/dev/pods/agent-1/exec?")).toBe(
      true,
    );
    expect(url).toContain("container=main");
    expect(url).toContain("stdin=true");
    expect(url).toContain("stdout=true");
    expect(url).toContain("stderr=true");
    expect(url).toContain("command=agent-harness");
    expect(url).toContain("command=serve");
    expect(url).toContain("command=--stdio");
  });

  test("maps http→ws", () => {
    const url = buildExecUrl("http://localhost:8080", "default", { pod: "p", command: ["sh"] });
    expect(url.startsWith("ws://localhost:8080/")).toBe(true);
  });
});

describe("execSubprotocols", () => {
  test("is the channel protocol alone without a token", () => {
    expect(execSubprotocols()).toEqual(["v4.channel.k8s.io"]);
  });
  test("appends the bearer-token subprotocol when a token is given", () => {
    const protocols = execSubprotocols("abc.def");
    expect(protocols[0]).toBe("v4.channel.k8s.io");
    expect(protocols[1]).toMatch(/^base64url\.bearer\.authorization\.k8s\.io\./);
  });
});

describe("KubeClient.openExec", () => {
  test("builds the exec URL + subprotocols and returns a working channel", () => {
    let seenUrl = "";
    let seenProtocols: string[] = [];
    const ws = new FakeWS();
    const client = new KubeClient({
      server: "https://api:6443",
      namespace: "dev",
      token: "tok",
      makeWebSocket: (url, protocols) => {
        seenUrl = url;
        seenProtocols = protocols;
        return ws;
      },
    });

    const channel = client.openExec({ pod: "p1", command: ["agent-harness", "serve", "--stdio"] });
    expect(seenUrl).toContain("wss://api:6443/api/v1/namespaces/dev/pods/p1/exec?");
    expect(seenProtocols[0]).toBe("v4.channel.k8s.io");
    expect(seenProtocols).toHaveLength(2); // includes the bearer subprotocol

    channel.send('{"ping":1}');
    expect((ws.sent[0] as Uint8Array)[0]).toBe(0);
  });
});
