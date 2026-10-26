import { describe, expect, test } from "bun:test";
import { type ExecConn, execChannel } from "../src/exec-channel.ts";
import type { IntervalTimers } from "../src/types.ts";
import {
  type FakeDuplex,
  UPGRADED,
  frame,
  response,
  scriptedDialer,
  settle,
} from "./fake-duplex.ts";

const dec = new TextDecoder();

/** A manual interval clock: `tick()` fires every live interval once (k8s `manualTimers`). */
function manualTimers() {
  const live = new Map<number, () => void>();
  let next = 0;
  const timers: IntervalTimers = {
    setInterval(fn) {
      next++;
      live.set(next, fn);
      return next;
    },
    clearInterval(handle) {
      live.delete(handle as number);
    },
  };
  return {
    timers,
    live: (): number => live.size,
    tick(): void {
      for (const fn of [...live.values()]) {
        fn();
      }
    },
  };
}

function setup() {
  const engine = scriptedDialer();
  const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
  const stderr: string[] = [];
  const clock = manualTimers();
  const channel = execChannel(
    conn,
    { container: "box", command: ["tentacle", "serve", "--stdio"] },
    { onStderr: (t) => stderr.push(t), keepalive: { timers: clock.timers } },
  );
  const messages: string[] = [];
  let closes = 0;
  channel.setOnMessage((m) => messages.push(m));
  channel.setOnClose(() => closes++);
  return { engine, channel, stderr, clock, messages, closes: () => closes };
}

/** Play exec-create (201) and answer the start hijack with `101`; return the stream connection. */
async function upgrade(engine: ReturnType<typeof scriptedDialer>): Promise<FakeDuplex> {
  const create = await engine.next();
  create.duplex.receive(response(201, '{"Id":"exec1"}'));
  const start = await engine.next();
  start.duplex.receive(UPGRADED);
  await settle();
  return start.duplex;
}

describe("execChannel (docker)", () => {
  test("returns synchronously; frames sent before the 101 are queued and flushed in order after it", async () => {
    const s = setup();
    s.channel.send('{"id":1}');
    s.channel.send('{"id":2}');
    const create = await s.engine.next();
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const start = await s.engine.next();
    expect(dec.decode(await start.duplex.afterRequest())).toBe(""); // nothing before the 101
    start.duplex.receive(UPGRADED);
    await settle();
    expect(dec.decode(await start.duplex.afterRequest())).toBe('{"id":1}\n{"id":2}\n');
    s.channel.send('{"id":3}');
    expect(dec.decode(await start.duplex.afterRequest())).toBe('{"id":1}\n{"id":2}\n{"id":3}\n');
  });

  test("exec create body is exactly attach-all, no TTY, the argv; start is an Upgrade: tcp hijack", async () => {
    const s = setup();
    const create = await s.engine.next();
    expect(create.req.method).toBe("POST");
    expect(create.req.path).toBe("/v1.52/containers/box/exec");
    expect(JSON.parse(create.req.body)).toEqual({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
      Cmd: ["tentacle", "serve", "--stdio"],
    });
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const start = await s.engine.next();
    expect(start.req.path).toBe("/v1.52/exec/exec1/start");
    expect(start.req.headers.get("upgrade")).toBe("tcp");
    expect(start.req.headers.get("connection")).toBe("Upgrade");
    expect(JSON.parse(start.req.body)).toEqual({ Detach: false, Tty: false });
  });

  test("stdout frames are re-chunked on \\n (blank lines dropped); stderr → onStderr", async () => {
    const s = setup();
    const stream = await upgrade(s.engine);
    stream.receive(frame(1, '{"a":1}\n\n{"b"'));
    stream.receive(frame(2, "warn: x\n"));
    stream.receive(frame(1, ":2}\n"));
    expect(s.messages).toEqual(['{"a":1}', '{"b":2}']);
    expect(s.stderr).toEqual(["warn: x\n"]);
  });

  test("stream bytes riding in the 101's segment are not lost", async () => {
    const s = setup();
    const create = await s.engine.next();
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const start = await s.engine.next();
    const head = new TextEncoder().encode(UPGRADED);
    const f = frame(1, '{"early":true}\n');
    const both = new Uint8Array(head.length + f.length);
    both.set(head);
    both.set(f, head.length);
    start.duplex.receive(both);
    await settle();
    expect(s.messages).toEqual(['{"early":true}']);
  });

  test("exec create refused on a stopped container (Podman's 500) → onStderr names 'not running' + onClose; nothing thrown", async () => {
    const s = setup();
    const create = await s.engine.next();
    create.duplex.receive(
      response(
        500,
        '{"message":"can only create exec sessions on running containers: container state improper"}',
      ),
    );
    const inspect = await s.engine.next();
    expect(inspect.req.path).toBe("/v1.52/containers/box/json");
    inspect.duplex.receive(
      response(200, '{"Id":"box","State":{"Status":"exited","Running":false}}'),
    );
    await settle();
    expect(s.stderr.join("")).toContain('[docker] exec failed: container "box" is not running');
    expect(s.stderr.join("")).toContain("start it or use `run`");
    expect(s.closes()).toBe(1);
  });

  test("an exec start the engine never answers is bounded: onStderr + onClose, socket closed (Review F3)", async () => {
    const engine = scriptedDialer();
    const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
    const stderr: string[] = [];
    let closes = 0;
    const channel = execChannel(
      conn,
      { container: "box", command: ["cat"] },
      { onStderr: (t) => stderr.push(t), startTimeoutMs: 30 },
    );
    channel.setOnClose(() => closes++);
    const create = await engine.next();
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const start = await engine.next(); // never answered
    await Bun.sleep(120);
    expect(stderr.join("")).toContain(
      "[docker] exec failed: the engine did not answer the exec start within 30ms",
    );
    expect(closes).toBe(1);
    expect(start.duplex.closed).toBe(true);
  });

  test("a non-101 start → onStderr with the engine message + onClose", async () => {
    const s = setup();
    const create = await s.engine.next();
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const start = await s.engine.next();
    start.duplex.receive(response(500, '{"message":"OCI runtime exec failed"}'));
    await settle();
    expect(s.stderr.join("")).toContain(
      "[docker] exec failed: Docker API request failed with status 500: OCI runtime exec failed",
    );
    expect(s.closes()).toBe(1);
    expect(start.duplex.closed).toBe(true);
  });

  test("a garbled frame header → onStderr + close", async () => {
    const s = setup();
    const stream = await upgrade(s.engine);
    stream.receive('{"jsonrpc":"2.0"}\n'); // raw text, not a multiplexed frame
    expect(s.stderr.join("")).toContain("[docker] malformed docker stream header");
    expect(s.closes()).toBe(1);
    expect(stream.closed).toBe(true);
  });

  test("peer end → onClose once", async () => {
    const s = setup();
    const stream = await upgrade(s.engine);
    stream.peerEnd();
    stream.peerEnd();
    expect(s.closes()).toBe(1);
  });

  test("close(): half-close then close, onClose synchronously once, later send is a no-op", async () => {
    const s = setup();
    const stream = await upgrade(s.engine);
    const before = stream.written.length;
    s.channel.close();
    expect(s.closes()).toBe(1); // synchronous
    expect(stream.calls).toEqual(["end", "close"]);
    s.channel.close();
    s.channel.send('{"late":1}');
    expect(s.closes()).toBe(1);
    expect(stream.written.length).toBe(before);
    expect(s.clock.live()).toBe(0); // keepalive stopped
  });

  test("close() before the 101: no stdin is ever written, the late connection is closed", async () => {
    const s = setup();
    s.channel.send('{"id":1}');
    const create = await s.engine.next();
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const start = await s.engine.next();
    s.channel.close();
    expect(s.closes()).toBe(1);
    start.duplex.receive(UPGRADED);
    await settle();
    expect(dec.decode(await start.duplex.afterRequest())).toBe("");
    expect(start.duplex.closed).toBe(true);
    expect(s.stderr).toEqual([]); // our own abort is not an error
  });

  test("a keepalive tick writes exactly one blank line (only after the 101)", async () => {
    const s = setup();
    expect(s.clock.live()).toBe(0);
    const stream = await upgrade(s.engine);
    expect(s.clock.live()).toBe(1);
    s.clock.tick();
    expect(dec.decode(await stream.afterRequest())).toBe("\n");
  });

  test("a stream error after the upgrade is reported on onStderr, then onClose", async () => {
    const s = setup();
    const stream = await upgrade(s.engine);
    stream.peerEnd(new Error("ECONNRESET"));
    expect(s.stderr.join("")).toContain("[docker] exec stream failed: ECONNRESET");
    expect(s.closes()).toBe(1);
  });
});
