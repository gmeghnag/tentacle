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

/**
 * An in-memory WebSocket for driving the exec channel deterministically.
 * Mimics the real lifecycle: it starts CONNECTING and must be `open()`-ed
 * before `send` succeeds — like a real `WebSocket`.
 */
class FakeWS implements WebSocketLike {
  binaryType = "";
  readonly sent: Uint8Array[] = [];
  readyState = 0; // CONNECTING
  pings = 0;
  closes = 0;
  private readonly listeners = new Map<string, Array<(ev: { data: unknown }) => void>>();

  send(data: Uint8Array): void {
    if (this.readyState !== 1) {
      throw new DOMException("The object is in an invalid state.", "InvalidStateError");
    }
    this.sent.push(data);
  }
  // A property, not a method, so a test can model a socket without `ping`.
  ping?: () => void = () => {
    this.pings++;
  };
  close(): void {
    this.closes++;
    this.readyState = 3;
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
  /** Complete the (fake) handshake: CONNECTING → OPEN. */
  open(): void {
    if (this.readyState !== 0) {
      return;
    }
    this.readyState = 1;
    this.emit("open", { data: null });
  }
  /** Simulate an inbound server message. */
  receive(bytes: Uint8Array): void {
    this.emit("message", { data: bytes });
  }
  /** Simulate the server answering a ping. */
  pong(): void {
    this.emit("pong", { data: null });
  }
}

/** A manual interval clock: `tick()` fires every live interval once. */
function manualTimers() {
  const live = new Map<number, () => void>();
  let next = 0;
  return {
    timers: {
      setInterval(fn: () => void, _ms: number): unknown {
        next++;
        live.set(next, fn);
        return next;
      },
      clearInterval(handle: unknown): void {
        live.delete(handle as number);
      },
    },
    live: (): number => live.size,
    tick(): void {
      for (const fn of [...live.values()]) {
        fn();
      }
    },
  };
}

/** The blank stdin line the heartbeat sends: channel 0, then `\n`. */
const isBlankStdin = (frame: Uint8Array): boolean =>
  frame.length === 2 && frame[0] === 0 && frame[1] === 0x0a;

describe("execChannel", () => {
  test("sends RPC frames on the stdin channel once the socket is open", () => {
    const ws = new FakeWS();
    const channel = execChannel(ws);
    ws.open();
    channel.send('{"x":1}');
    expect(ws.sent).toHaveLength(1);
    const frame = ws.sent[0] as Uint8Array;
    expect(frame[0]).toBe(0); // stdin channel
    expect(dec.decode(frame.subarray(1))).toBe('{"x":1}\n');
  });

  test("buffers frames sent while CONNECTING and flushes them in order on open", () => {
    const ws = new FakeWS();
    const channel = execChannel(ws);
    channel.send('{"id":1}');
    channel.send('{"id":2}');
    expect(ws.sent).toHaveLength(0); // not sent while CONNECTING (would throw)

    ws.open();
    expect(ws.sent).toHaveLength(2);
    expect(dec.decode((ws.sent[0] as Uint8Array).subarray(1))).toBe('{"id":1}\n');
    expect(dec.decode((ws.sent[1] as Uint8Array).subarray(1))).toBe('{"id":2}\n');
  });

  test("drops buffered frames if the socket closes before it ever opens", () => {
    const ws = new FakeWS();
    const channel = execChannel(ws);
    let closed = false;
    channel.setOnClose(() => {
      closed = true;
    });
    channel.send('{"id":1}');
    ws.close();
    expect(closed).toBe(true);
    ws.open(); // an open after a close must not resurrect the queue
    expect(ws.sent).toHaveLength(0);
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

describe("execChannel keepalive (docs/feat/pod-attach-resilience.md)", () => {
  test("from open on, each tick pings and sends one blank stdin line; nothing before open", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    execChannel(ws, { keepalive: { timers: clock.timers } });
    clock.tick();
    expect(ws.pings).toBe(0);
    expect(ws.sent).toHaveLength(0);

    ws.open();
    clock.tick();
    expect(ws.pings).toBe(1);
    expect(ws.sent).toHaveLength(1);
    expect(isBlankStdin(ws.sent[0] as Uint8Array)).toBe(true);
    clock.tick();
    expect(ws.pings).toBe(2);
    expect(ws.sent).toHaveLength(2);
  });

  test("a socket already OPEN when wrapped (no open event) still gets the heartbeat", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    ws.readyState = 1;
    execChannel(ws, { keepalive: { timers: clock.timers } });
    clock.tick();
    expect(ws.pings).toBe(1);
    expect(ws.sent).toHaveLength(1);
  });

  test("never closes a socket whose server has not answered a single ping", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    const channel = execChannel(ws, { keepalive: { timers: clock.timers, maxMissed: 2 } });
    let closed = 0;
    channel.setOnClose(() => closed++);
    ws.open();
    for (let i = 0; i < 20; i++) clock.tick();
    expect(closed).toBe(0);
    expect(ws.closes).toBe(0);
    expect(ws.pings).toBe(20);
  });

  test("a socket without ping() still gets the blank line and is never closed", () => {
    const clock = manualTimers();
    const ws = Object.assign(new FakeWS(), { ping: undefined });
    const channel = execChannel(ws, { keepalive: { timers: clock.timers } });
    let closed = 0;
    channel.setOnClose(() => closed++);
    ws.open();
    for (let i = 0; i < 10; i++) clock.tick();
    expect(closed).toBe(0);
    expect(ws.sent.filter((f) => isBlankStdin(f))).toHaveLength(10);
  });

  test("after a pong, maxMissed silent ticks close the channel once and stop the timer", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    const channel = execChannel(ws, { keepalive: { timers: clock.timers, maxMissed: 2 } });
    let closed = 0;
    channel.setOnClose(() => closed++);
    ws.open();
    clock.tick(); // ping 1
    ws.pong(); // the link is proven to answer
    clock.tick(); // judged alive; ping 2 (never answered)
    clock.tick(); // missed 1
    expect(closed).toBe(0);
    clock.tick(); // missed 2 → dead
    expect(closed).toBe(1);
    expect(ws.closes).toBe(1);
    expect(clock.live()).toBe(0);
    const sent = ws.sent.length;
    clock.tick();
    expect(ws.sent).toHaveLength(sent);
    expect(closed).toBe(1);
  });

  test("half-open: onClose fires at once even when ws.close() never completes its handshake", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    // A dead link: close() starts the closing handshake, but no close event ever comes back.
    ws.close = function (this: FakeWS): void {
      this.closes++;
      this.readyState = 2;
    };
    const channel = execChannel(ws, { keepalive: { timers: clock.timers, maxMissed: 2 } });
    let closed = 0;
    channel.setOnClose(() => closed++);
    ws.open();
    clock.tick();
    ws.pong();
    clock.tick();
    clock.tick();
    clock.tick();
    expect(ws.closes).toBe(1);
    expect(closed).toBe(1);
    expect(clock.live()).toBe(0);
  });

  test("any inbound byte resets the count: a message or a pong between ticks keeps it open", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    const channel = execChannel(ws, { keepalive: { timers: clock.timers, maxMissed: 2 } });
    let closed = 0;
    channel.setOnClose(() => closed++);
    ws.open();
    clock.tick();
    ws.pong();
    clock.tick();
    clock.tick(); // missed 1
    ws.receive(msg(1, '{"jsonrpc":"2.0"')); // a stdout message (a pong stuck behind data)
    clock.tick(); // reset
    clock.tick(); // missed 1
    ws.pong();
    clock.tick(); // reset
    clock.tick(); // missed 1
    expect(closed).toBe(0);
    expect(ws.closes).toBe(0);
  });

  test("a local or remote close clears the timer; later ticks send nothing", () => {
    for (const how of ["local", "remote"] as const) {
      const clock = manualTimers();
      const ws = new FakeWS();
      const channel = execChannel(ws, { keepalive: { timers: clock.timers } });
      ws.open();
      clock.tick();
      expect(clock.live()).toBe(1);
      if (how === "local") channel.close();
      else ws.close();
      expect(clock.live()).toBe(0);
      const sent = ws.sent.length;
      const pings = ws.pings;
      clock.tick();
      expect(ws.sent).toHaveLength(sent);
      expect(ws.pings).toBe(pings);
    }
  });

  test("a ping or send that throws is swallowed (the socket's own events close it)", () => {
    const clock = manualTimers();
    const ws = Object.assign(new FakeWS(), {
      ping: (): void => {
        throw new Error("socket going away");
      },
    });
    const channel = execChannel(ws, { keepalive: { timers: clock.timers } });
    let closed = 0;
    channel.setOnClose(() => closed++);
    ws.open();
    clock.tick();
    // A throwing ping must not cost the blank line: it is the keepalive on its own.
    expect(ws.sent.filter((f) => isBlankStdin(f))).toHaveLength(1);
    ws.readyState = 2; // CLOSING: the fake's send throws too
    expect(() => clock.tick()).not.toThrow();
    expect(closed).toBe(0);
  });
});

describe("buildExecUrl", () => {
  test("maps https→wss and encodes command + stream flags", () => {
    const url = buildExecUrl("https://api.cluster:6443", "dev", {
      pod: "agent-1",
      container: "main",
      command: ["tentacle", "serve", "--stdio"],
    });
    expect(url.startsWith("wss://api.cluster:6443/api/v1/namespaces/dev/pods/agent-1/exec?")).toBe(
      true,
    );
    expect(url).toContain("container=main");
    expect(url).toContain("stdin=true");
    expect(url).toContain("stdout=true");
    expect(url).toContain("stderr=true");
    expect(url).toContain("command=tentacle");
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

    const channel = client.openExec({ pod: "p1", command: ["tentacle", "serve", "--stdio"] });
    expect(seenUrl).toContain("wss://api:6443/api/v1/namespaces/dev/pods/p1/exec?");
    expect(seenProtocols[0]).toBe("v4.channel.k8s.io");
    expect(seenProtocols).toHaveLength(2); // includes the bearer subprotocol

    // The channel is usable immediately (the pod runtime issues the first frame
    // right away); the frame goes out once the (fake) socket opens.
    channel.send('{"ping":1}');
    expect(ws.sent).toHaveLength(0);
    ws.open();
    expect((ws.sent[0] as Uint8Array)[0]).toBe(0);
  });

  test("passes the keepalive options through to the channel", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    const client = new KubeClient({
      server: "https://api:6443",
      namespace: "dev",
      makeWebSocket: () => ws,
    });
    client.openExec({ pod: "p1", command: ["cat"] }, { keepalive: { timers: clock.timers } });
    ws.open();
    clock.tick();
    expect(ws.pings).toBe(1);
  });
});
