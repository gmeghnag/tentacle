/**
 * `rawExec` — the docker/podman twin of `@tentacle/k8s`'s raw exec
 * (docs/feat/workload-shell.md D1): a long-lived exec with `Tty:false` whose
 * stdout/stderr arrive as BYTES (the stdcopy demux, never decoded) and whose
 * stdin is written raw. `end()` is the command's stdin EOF.
 */
import { describe, expect, test } from "bun:test";
import type { ExecConn } from "../src/exec-channel.ts";
import { type RawExecEnd, rawExec } from "../src/exec-raw.ts";
import {
  type FakeDuplex,
  UPGRADED,
  frame,
  response,
  scriptedDialer,
  settle,
} from "./fake-duplex.ts";

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

function collect() {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const ends: RawExecEnd[] = [];
  return {
    stdout,
    stderr,
    ends,
    handlers: {
      onStdout: (b: Uint8Array) => stdout.push(b),
      onStderr: (b: Uint8Array) => stderr.push(b),
      onEnd: (end: RawExecEnd) => ends.push(end),
    },
    out: () => concat(stdout),
    err: () => concat(stderr),
  };
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Drive the create → start-hijack handshake; returns the hijacked stream. */
async function upgrade(engine: ReturnType<typeof scriptedDialer>): Promise<FakeDuplex> {
  const create = await engine.next();
  create.duplex.receive(response(201, '{"Id":"exec1"}'));
  const start = await engine.next();
  start.duplex.receive(UPGRADED);
  await settle();
  return start.duplex;
}

describe("docker rawExec", () => {
  test("create asks for stdin+stdout+stderr with Tty:false", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    const exec = rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    exec.setOnEnd(() => {});

    const create = await engine.next();
    expect(create.req.method).toBe("POST");
    expect(create.req.path).toBe("/v1.52/containers/box/exec");
    const body = JSON.parse(create.req.body) as Record<string, unknown>;
    expect(body.Tty).toBe(false);
    expect(body.AttachStdin).toBe(true);
    expect(body.AttachStdout).toBe(true);
    expect(body.AttachStderr).toBe(true);
    expect(body.Cmd).toEqual(["sh"]);
  });

  test("stdout/stderr are demuxed to bytes: a header split across reads, NUL and split UTF-8 survive", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    const stream = await upgrade(engine);

    // One full stdout frame whose 8-byte header itself is split at byte 3.
    const whole = frame(1, new Uint8Array([0x00, 0x62]));
    stream.receive(whole.subarray(0, 3));
    await settle();
    expect(sink.out().length).toBe(0); // the header is not complete yet
    stream.receive(whole.subarray(3));
    await settle();
    expect(Array.from(sink.out())).toEqual([0x00, 0x62]);

    // "é" (C3 A9) split ACROSS two frames: a per-chunk TextDecoder would
    // decode each half to U+FFFD; a byte path passes both halves through.
    stream.receive(frame(1, new Uint8Array([0xc3])));
    stream.receive(frame(1, new Uint8Array([0xa9])));
    await settle();
    expect(Array.from(sink.out().subarray(2))).toEqual([0xc3, 0xa9]);

    stream.receive(frame(2, "a diagnostic\n"));
    await settle();
    expect(dec.decode(sink.err())).toBe("a diagnostic\n");
  });

  test("stdin bytes are written raw (no framing beyond the HTTP body) and end() is the EOF", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    const exec = rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    const stream = await upgrade(engine);

    exec.write(enc.encode("echo hi\n"));
    await settle();
    // `written[0]` is the HTTP start request itself; the rest is stdin.
    const stdin = concat(stream.written.slice(1));
    expect(dec.decode(stdin)).toBe("echo hi\n"); // byte-raw: no channel byte, no extra newline

    exec.close();
    await settle();
    // Half-close BEFORE the full close (the command's stdin EOF first).
    expect(stream.calls).toEqual(["end", "close"]);
  });

  test("the end carries the REAL ExitCode from exec inspect (7, not 0/1)", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    const stream = await upgrade(engine);

    stream.receive(frame(1, "bye\n"));
    stream.peerEnd();
    const { duplex, req } = await engine.next();
    expect(req.method).toBe("GET");
    expect(req.path).toBe("/v1.52/exec/exec1/json");
    duplex.receive(response(200, JSON.stringify({ Running: false, ExitCode: 7 })));
    await settle();

    expect(sink.ends).toHaveLength(1);
    expect(sink.ends[0]?.exitCode).toBe(7);
    expect(dec.decode(sink.out())).toBe("bye\n");
  });

  test("systemErr text is surfaced on the end as the message", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    const stream = await upgrade(engine);
    stream.receive(frame(3, "engine says no"));
    stream.peerEnd();
    const { duplex } = await engine.next();
    duplex.receive(response(200, JSON.stringify({ Running: false, ExitCode: 1 })));
    await settle();
    expect(sink.ends[0]?.message).toBe("engine says no");
  });

  test("a create 404 ends with the existing actionable error (not a throw)", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    rawExec(conn, { container: "nope", command: ["sh"] }, sink.handlers);
    const create = await engine.next();
    create.duplex.receive(response(404, JSON.stringify({ message: "No such container: nope" })));
    // `explainCreateFailure` asks the engine for a FACT (the container's state)
    // before wording the refusal.
    const inspect = await engine.next();
    expect(inspect.req.method).toBe("GET");
    inspect.duplex.receive(response(404, '{"message":"no such container"}'));
    await settle();

    expect(sink.ends).toHaveLength(1);
    expect(sink.ends[0]?.exitCode).toBeNull();
    expect(sink.ends[0]?.error?.message).toContain("nope");
  });

  test("a dropped stream ends once with the inspect exit code (or null when it never settles)", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    const stream = await upgrade(engine);
    stream.peerEnd(new Error("link lost"));
    const { duplex } = await engine.next();
    duplex.receive(response(200, JSON.stringify({ Running: false, ExitCode: 0 })));
    await settle();
    expect(sink.ends).toHaveLength(1);
    expect(sink.ends[0]?.exitCode).toBe(0);
  });

  test("close() is idempotent and end fires once", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const sink = collect();
    const exec = rawExec(conn, { container: "box", command: ["sh"] }, sink.handlers);
    const stream = await upgrade(engine);
    exec.close();
    exec.close();
    await settle();
    expect(sink.ends).toHaveLength(1);
    expect(stream.closed).toBe(true);
  });
});
