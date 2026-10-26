/**
 * Test fakes for `@tentacle/docker` (not a `*.test.ts`: not discovered).
 *
 * `FakeDuplex` mirrors k8s's `FakeWS` (`packages/k8s/test/exec-channel.test.ts`):
 * it records what the client wrote, exposes `ended`/`closed`, a settable
 * `buffered`, and driver methods — `receive(bytes)` (engine → client),
 * `peerEnd(error?)`, `drain()`. `scriptedDialer()` hands out one `FakeDuplex`
 * per dial, in order, so a test plays the engine: `await engine.next()` → the
 * parsed request → reply with raw response bytes.
 */
import type { ByteDuplex, Dialer } from "../src/byte-duplex.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface SeenRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
  /** The exact request bytes (for byte-identity checks). */
  readonly raw: Uint8Array;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Parse a complete request out of `bytes`, or `undefined` if not all there yet. */
function parseRequest(bytes: Uint8Array): SeenRequest | undefined {
  const text = dec.decode(bytes);
  const end = text.indexOf("\r\n\r\n");
  if (end === -1) {
    return undefined;
  }
  const [line = "", ...rest] = text.slice(0, end).split("\r\n");
  const [method = "", path = ""] = line.split(" ");
  const headers = new Map<string, string>();
  for (const h of rest) {
    const i = h.indexOf(":");
    headers.set(h.slice(0, i).trim().toLowerCase(), h.slice(i + 1).trim());
  }
  const length = Number(headers.get("content-length") ?? "0");
  const headBytes = enc.encode(text.slice(0, end + 4)).length;
  if (bytes.length < headBytes + length) {
    return undefined;
  }
  return {
    method,
    path,
    headers,
    body: dec.decode(bytes.subarray(headBytes, headBytes + length)),
    raw: bytes.subarray(0, headBytes + length),
  };
}

export class FakeDuplex implements ByteDuplex {
  readonly written: Uint8Array[] = [];
  ended = false;
  closed = false;
  /** Settable: what the client sees as queued-not-yet-sent bytes. */
  buffered = 0;
  /** Order of `end`/`close` calls, for "half-close then close" assertions. */
  readonly calls: string[] = [];
  private onData: ((b: Uint8Array) => void) | undefined;
  private onDrain: (() => void) | undefined;
  private onEnd: ((e?: Error) => void) | undefined;
  private held: Uint8Array[] = [];
  private finished = false;
  private finishError: Error | undefined;
  private requestWaiters: Array<() => void> = [];

  write(bytes: Uint8Array): void {
    if (this.closed || this.ended) {
      return;
    }
    this.written.push(new Uint8Array(bytes));
    for (const w of this.requestWaiters.splice(0)) {
      w();
    }
  }
  setOnData(fn: (b: Uint8Array) => void): void {
    this.onData = fn;
    for (const b of this.held.splice(0)) {
      fn(b);
    }
  }
  setOnDrain(fn: () => void): void {
    this.onDrain = fn;
  }
  setOnEnd(fn: (e?: Error) => void): void {
    this.onEnd = fn;
    if (this.finished) {
      fn(this.finishError);
    }
  }
  end(): void {
    this.calls.push("end");
    this.ended = true;
  }
  close(): void {
    this.calls.push("close");
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.fire();
  }

  // ── drivers (the engine side) ──
  /** All bytes the client wrote, as one buffer. */
  bytes(): Uint8Array {
    return concat(this.written);
  }
  /** Text the client wrote after the request (e.g. exec stdin), as a string. */
  text(): string {
    return dec.decode(this.bytes());
  }
  /** Resolve once a complete request has been written. */
  async request(): Promise<SeenRequest> {
    for (;;) {
      const parsed = parseRequest(this.bytes());
      if (parsed) {
        return parsed;
      }
      await new Promise<void>((resolve) => this.requestWaiters.push(resolve));
    }
  }
  /** Bytes written after the request (stdin of a hijacked exec). */
  async afterRequest(): Promise<Uint8Array> {
    const req = await this.request();
    return this.bytes().subarray(req.raw.length);
  }
  receive(data: Uint8Array | string): void {
    const bytes = typeof data === "string" ? enc.encode(data) : data;
    if (this.closed) {
      return;
    }
    if (this.onData) {
      this.onData(bytes);
    } else {
      this.held.push(bytes);
    }
  }
  peerEnd(error?: Error): void {
    this.fire(error);
  }
  drain(): void {
    this.buffered = 0;
    this.onDrain?.();
  }
  private fire(error?: Error): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.finishError = error;
    this.onEnd?.(error);
  }
}

export interface ScriptedEngine {
  readonly dial: Dialer;
  readonly dials: FakeDuplex[];
  /** The next dialed connection, once its request is complete. */
  next(): Promise<{ duplex: FakeDuplex; req: SeenRequest }>;
}

export function scriptedDialer(): ScriptedEngine {
  const dials: FakeDuplex[] = [];
  let taken = 0;
  let waiters: Array<() => void> = [];
  const dial: Dialer = async (signal) => {
    if (signal?.aborted) {
      throw new DOMException("aborted", "AbortError");
    }
    const d = new FakeDuplex();
    dials.push(d);
    const w = waiters;
    waiters = [];
    for (const fn of w) {
      fn();
    }
    return d;
  };
  return {
    dial,
    dials,
    async next() {
      const index = taken++;
      while (dials.length <= index) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      const duplex = dials[index] as FakeDuplex;
      return { duplex, req: await duplex.request() };
    },
  };
}

/** A raw HTTP response (Content-Length framed). */
export function response(status: number, body = "", headers: Record<string, string> = {}): string {
  const reason =
    {
      101: "UPGRADED",
      200: "OK",
      201: "Created",
      204: "No Content",
      304: "Not Modified",
      404: "Not Found",
      409: "Conflict",
      500: "Internal Server Error",
    }[status] ?? "X";
  const lines = [`HTTP/1.1 ${status} ${reason}`];
  for (const [k, v] of Object.entries(headers)) {
    lines.push(`${k}: ${v}`);
  }
  if (status !== 101 && status !== 204 && status !== 304) {
    if (body !== "") {
      lines.push("Content-Type: application/json");
    }
    lines.push(`Content-Length: ${enc.encode(body).length}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n${body}`;
}

export const UPGRADED = response(101, "", {
  "Content-Type": "application/vnd.docker.multiplexed-stream",
  Connection: "Upgrade",
  Upgrade: "tcp",
});

/** One multiplexed stream frame `[stream,0,0,0,size32be] + payload`. */
export function frame(stream: number, payload: Uint8Array | string): Uint8Array {
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const out = new Uint8Array(8 + body.length);
  out[0] = stream;
  new DataView(out.buffer).setUint32(4, body.length);
  out.set(body, 8);
  return out;
}

/** Let pending microtasks/promise chains run. */
export async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}
