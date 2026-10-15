import { describe, expect, test } from "bun:test";
import type { WebSocketLike } from "../src/exec-channel.ts";
import { type RunExecOptions, parseKubeStatus, runExecOverWebSocket } from "../src/exec-run.ts";

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
 * An in-memory WebSocket for driving the one-shot exec deterministically.
 * Mimics the real lifecycle: starts CONNECTING and must be `open()`-ed before
 * `send` succeeds. `close()` fires the close event (a terminal, no-status end).
 */
class FakeWS implements WebSocketLike {
  binaryType = "";
  readonly sent: Uint8Array[] = [];
  readyState = 0; // CONNECTING
  private readonly listeners = new Map<string, Array<(ev: { data: unknown }) => void>>();

  send(data: Uint8Array): void {
    if (this.readyState !== 1) {
      throw new DOMException("The object is in an invalid state.", "InvalidStateError");
    }
    this.sent.push(data);
  }
  close(): void {
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
  /** Simulate an inbound server message (raw bytes, as the socket delivers). */
  receive(bytes: Uint8Array): void {
    this.emit("message", { data: bytes });
  }
}

describe("parseKubeStatus", () => {
  test("Success → exit 0, no message", () => {
    expect(parseKubeStatus('{"metadata":{},"status":"Success"}')).toEqual({ exitCode: 0 });
  });
  test("Failure with a cause → exit 1 + the cause message", () => {
    const parsed = parseKubeStatus(
      '{"status":"Failure","message":"exit code 1","details":{"causes":[{"message":"Exec format error"}]},"reason":"BadRequest"}',
    );
    expect(parsed).toEqual({ exitCode: 1, message: "Exec format error" });
  });
  test("Failure without causes → falls back to the top-level message", () => {
    expect(parseKubeStatus('{"status":"Failure","message":"boom"}')).toEqual({
      exitCode: 1,
      message: "boom",
    });
  });
  test("a fragment / non-Status JSON → null (keep accumulating)", () => {
    expect(parseKubeStatus("{")).toBeNull();
    expect(parseKubeStatus('{"foo":"bar"}')).toBeNull();
    expect(parseKubeStatus('{"sta')).toBeNull();
  });
});

describe("runExecOverWebSocket — resolve on exit", () => {
  test("Success status resolves with exit 0 and captured stdout", async () => {
    const ws = new FakeWS();
    let seenUrl = "";
    let seenProtocols: string[] = [];
    const promise = runExecOverWebSocket(
      (url, protocols) => {
        seenUrl = url;
        seenProtocols = protocols;
        return ws;
      },
      "wss://api/pods/p/exec?command=uname",
      ["v4.channel.k8s.io"],
    );
    expect(seenUrl).toBe("wss://api/pods/p/exec?command=uname");
    expect(seenProtocols).toEqual(["v4.channel.k8s.io"]);
    ws.open();
    ws.receive(msg(1, "x86_64\n"));
    ws.receive(msg(3, '{"status":"Success"}'));
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("x86_64\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe('{"status":"Success"}');
  });

  test("Failure status resolves with exit 1 and captured stderr", async () => {
    const ws = new FakeWS();
    const promise = runExecOverWebSocket(() => ws, "wss://api/exec", ["v4.channel.k8s.io"]);
    ws.open();
    ws.receive(msg(2, "/bin/sh: agent-harness: not found\n"));
    ws.receive(msg(3, '{"status":"Failure","message":"exit code 127"}'));
    const result = await promise;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("/bin/sh: agent-harness: not found\n");
  });

  test("reassembles stdout across multiple messages", async () => {
    const ws = new FakeWS();
    const promise = runExecOverWebSocket(() => ws, "wss://api/exec", ["v4.channel.k8s.io"]);
    ws.open();
    ws.receive(msg(1, "hello "));
    ws.receive(msg(1, "world"));
    ws.receive(msg(3, '{"status":"Success"}'));
    const result = await promise;
    expect(result.stdout).toBe("hello world");
  });
});

describe("runExecOverWebSocket — input on the stdin channel", () => {
  test("streams raw bytes on channel 0, chunked, and reports progress", async () => {
    const ws = new FakeWS();
    const total = 600_000; // > 256KB so it spans multiple chunks
    const input = new Uint8Array(total).fill(0xab);
    const progress: number[] = [];
    const options: RunExecOptions = { onProgress: (n) => progress.push(n) };

    const promise = runExecOverWebSocket(
      () => ws,
      "wss://api/exec",
      ["v4.channel.k8s.io"],
      input,
      options,
    );
    ws.open();

    // Every sent frame starts with the channel-0 byte; reassembled they equal
    // the original input.
    expect(ws.sent.length).toBeGreaterThan(1);
    for (const frame of ws.sent) {
      expect(frame[0]).toBe(0);
    }
    const reassembled = new Uint8Array(total);
    let off = 0;
    for (const frame of ws.sent) {
      reassembled.set(frame.subarray(1), off);
      off += frame.length - 1;
    }
    expect(off).toBe(total);
    for (let i = 0; i < total; i += 10_000) {
      expect(reassembled[i]).toBe(0xab);
    }

    // Progress is a monotonically increasing running byte count ending at total.
    expect(progress.length).toBeGreaterThan(1);
    expect(progress[progress.length - 1]).toBe(total);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]).toBeGreaterThan(progress[i - 1] as number);
    }

    ws.receive(msg(3, '{"status":"Success"}'));
    const result = await promise;
    expect(result.exitCode).toBe(0);
  });

  test("buffers stdin while CONNECTING and flushes in order on open", async () => {
    const ws = new FakeWS();
    const input = new Uint8Array(512 * 1024 + 123).fill(0x5a); // spans 3 chunks
    const promise = runExecOverWebSocket(() => ws, "wss://api/exec", ["v4.channel.k8s.io"], input);
    expect(ws.sent.length).toBe(0); // nothing sent while CONNECTING
    ws.open();
    expect(ws.sent.length).toBeGreaterThan(1);
    ws.receive(msg(3, '{"status":"Success"}'));
    await promise;
  });
});

describe("runExecOverWebSocket — terminal failures", () => {
  test("rejects on timeout when no status arrives", async () => {
    const ws = new FakeWS();
    const promise = runExecOverWebSocket(
      () => ws,
      "wss://api/exec",
      ["v4.channel.k8s.io"],
      undefined,
      { timeoutMs: 50 },
    );
    ws.open();
    await expect(promise).rejects.toThrow(/timed out after 50ms/);
  });

  test("rejects when the socket closes without a status", async () => {
    const ws = new FakeWS();
    const promise = runExecOverWebSocket(() => ws, "wss://api/exec", ["v4.channel.k8s.io"]);
    ws.open();
    ws.receive(msg(1, "partial output "));
    ws.close(); // no status on channel 3
    await expect(promise).rejects.toThrow(/closed before the command reported a status/);
  });

  test("rejects when the socket never opens and closes", async () => {
    const ws = new FakeWS();
    const promise = runExecOverWebSocket(() => ws, "wss://api/exec", ["v4.channel.k8s.io"]);
    // The socket closes while still CONNECTING.
    ws.close();
    await expect(promise).rejects.toThrow(/closed before the command reported a status/);
  });

  test("an abort signal rejects with AbortError", async () => {
    const ws = new FakeWS();
    const controller = new AbortController();
    const promise = runExecOverWebSocket(
      () => ws,
      "wss://api/exec",
      ["v4.channel.k8s.io"],
      undefined,
      { signal: controller.signal },
    );
    ws.open();
    controller.abort();
    await expect(promise).rejects.toThrow(/aborted/);
  });
});
