/**
 * `rawExec` — the raw-byte exec the `workload_shell` tool rides
 * (docs/feat/workload-shell.md D1). Unlike `execChannel` (a text `DuplexChannel`
 * for an RPC peer), here stdout/stderr arrive as BYTES, stdin is written raw
 * (a single channel byte, no newline), and there is no line reassembly — so a
 * split multi-byte UTF-8 sequence or a NUL survives untouched.
 */
import { describe, expect, test } from "bun:test";
import type { WebSocketLike } from "../src/exec-channel.ts";
import { rawExec } from "../src/exec-raw.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function frame(channel: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const out = new Uint8Array(body.length + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
}

/** An in-memory WebSocket, driven deterministically (CONNECTING until `open()`). */
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
  ping?: () => void = () => {
    this.pings++;
  };
  close(): void {
    this.closes++;
    if (this.readyState === 3) {
      return;
    }
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
  open(): void {
    if (this.readyState !== 0) {
      return;
    }
    this.readyState = 1;
    this.emit("open", { data: null });
  }
  receive(bytes: Uint8Array): void {
    this.emit("message", { data: bytes });
  }
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
      tick(): void {
        for (const fn of [...live.values()]) {
          fn();
        }
      },
      get live(): number {
        return live.size;
      },
    },
  };
}

/** Collect what a raw exec delivers, in order. */
function collect() {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const ends: Array<{ exitCode: number | null; message?: string; error?: Error }> = [];
  return {
    stdout,
    stderr,
    ends,
    handlers: {
      onStdout: (b: Uint8Array) => stdout.push(b),
      onStderr: (b: Uint8Array) => stderr.push(b),
      onEnd: (end: { exitCode: number | null; message?: string; error?: Error }) => ends.push(end),
    },
    /** Everything stdout delivered, concatenated (the byte-exact comparison). */
    out(): Uint8Array {
      return concat(stdout);
    },
    err(): Uint8Array {
      return concat(stderr);
    },
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

describe("k8s rawExec", () => {
  test("writes are queued while CONNECTING and flushed in order on open", () => {
    const ws = new FakeWS();
    const sink = collect();
    const exec = rawExec(ws, sink.handlers);

    exec.write(enc.encode("first\n"));
    exec.write(enc.encode("second\n"));
    expect(ws.sent).toHaveLength(0); // still CONNECTING: nothing thrown, nothing sent

    ws.open();
    expect(ws.sent).toHaveLength(2);
    expect(dec.decode(ws.sent[0] as Uint8Array)).toBe("\u0000first\n");
    expect(dec.decode(ws.sent[1] as Uint8Array)).toBe("\u0000second\n");
  });

  test("stdin frames are [0, ...bytes] with NO appended newline (raw, not RPC framing)", () => {
    const ws = new FakeWS();
    ws.open();
    const exec = rawExec(ws, collect().handlers);
    // Bytes that are NOT newline-terminated, and one that contains a newline.
    exec.write(enc.encode("no-newline"));
    expect(ws.sent).toHaveLength(1);
    const sent = ws.sent[0] as Uint8Array;
    expect(sent[0]).toBe(0);
    expect(sent.length).toBe(1 + "no-newline".length);
    expect(dec.decode(sent.subarray(1))).toBe("no-newline");
  });

  test("stdout/stderr arrive as unmodified bytes: split UTF-8 and NUL survive", () => {
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    rawExec(ws, sink.handlers);

    // "é" is C3 A9 — split it across two messages, as a network read can.
    const eAcute = enc.encode("é");
    ws.receive(frame(1, eAcute.subarray(0, 1)));
    ws.receive(frame(1, eAcute.subarray(1)));
    // A NUL in the middle of stdout.
    ws.receive(frame(1, new Uint8Array([0x61, 0x00, 0x62])));
    ws.receive(frame(2, "a diagnostic\n"));

    // Byte-exact: a decoder-per-chunk would have produced U+FFFD twice here.
    expect(Array.from(sink.out())).toEqual([0xc3, 0xa9, 0x61, 0x00, 0x62]);
    expect(dec.decode(sink.err())).toBe("a diagnostic\n");
  });

  test("a channel-3 Failure status ends the stream with exitCode 1 and its message", () => {
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    rawExec(ws, sink.handlers);

    ws.receive(
      frame(
        3,
        JSON.stringify({
          status: "Failure",
          reason: "InternalError",
          message:
            'exec failed: container_linux.go: exec: "/bin/sh": stat /bin/sh: no such file or directory',
          details: { causes: [{ reason: "InternalError", message: "executable file not found" }] },
        }),
      ),
    );

    expect(sink.ends).toHaveLength(1);
    expect(sink.ends[0]?.exitCode).toBe(1);
    expect(sink.ends[0]?.message).toBe("executable file not found");
  });

  test("a Success status ends the stream with exitCode 0", () => {
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    rawExec(ws, sink.handlers);
    ws.receive(frame(3, JSON.stringify({ status: "Success" })));
    expect(sink.ends).toEqual([{ exitCode: 0 }]);
  });

  test("a close with no status ends once with exitCode null and an error", () => {
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    rawExec(ws, sink.handlers);

    ws.close();
    expect(sink.ends).toHaveLength(1);
    expect(sink.ends[0]?.exitCode).toBeNull();
    expect(sink.ends[0]?.error).toBeInstanceOf(Error);
  });

  test("end fires once: a status then a socket close delivers only the status", () => {
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    const exec = rawExec(ws, sink.handlers);
    ws.receive(frame(3, JSON.stringify({ status: "Success" })));
    exec.close(); // also closes the socket
    ws.close();
    expect(sink.ends).toHaveLength(1);
    expect(sink.ends[0]?.exitCode).toBe(0);
  });

  test("a late onEnd handler still gets the end that already happened", () => {
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    const exec = rawExec(ws, sink.handlers);
    ws.receive(frame(3, JSON.stringify({ status: "Success" })));
    expect(sink.ends).toHaveLength(1);

    const late: Array<{ exitCode: number | null }> = [];
    exec.setOnEnd((end) => late.push(end));
    expect(late).toHaveLength(1);
    expect(late[0]?.exitCode).toBe(0);
  });

  test("keepalive pings while idle; 2 silent ticks after a first pong close the stream", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    rawExec(ws, { ...sink.handlers, keepalive: { timers: clock.timers } });

    clock.timers.tick();
    expect(ws.pings).toBe(1); // the probe goes out

    ws.pong(); // the far end answers: silence is now meaningful
    clock.timers.tick();
    expect(ws.pings).toBe(2); // inbound since the last tick → missed 0

    clock.timers.tick(); // silent tick 1
    clock.timers.tick(); // silent tick 2 → dead
    expect(ws.closes).toBe(1);
    expect(sink.ends).toHaveLength(1);
    expect(clock.timers.live).toBe(0); // the heartbeat is stopped
  });

  test("without a pong it never closes: an idle peer sends nothing, so silence proves nothing", () => {
    const clock = manualTimers();
    const ws = new FakeWS();
    ws.open();
    const sink = collect();
    rawExec(ws, { ...sink.handlers, keepalive: { timers: clock.timers } });
    for (let i = 0; i < 10; i++) {
      clock.timers.tick();
    }
    expect(ws.closes).toBe(0);
    expect(sink.ends).toHaveLength(0);
  });

  test("close() is idempotent", () => {
    const ws = new FakeWS();
    ws.open();
    const exec = rawExec(ws, collect().handlers);
    exec.close();
    exec.close();
    expect(ws.closes).toBe(1);
  });
});
