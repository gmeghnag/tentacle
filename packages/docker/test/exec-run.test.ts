import { describe, expect, test } from "bun:test";
import type { ExecConn } from "../src/exec-channel.ts";
import { EXIT_POLL_ATTEMPTS, SEND_HIGH_WATER_BYTES, runExec } from "../src/exec-run.ts";
import type { RunExecOptions } from "../src/types.ts";
import {
  type FakeDuplex,
  UPGRADED,
  frame,
  response,
  scriptedDialer,
  settle,
} from "./fake-duplex.ts";

function start(input?: Uint8Array, options: RunExecOptions = {}, command = ["sh", "-c", "x"]) {
  const engine = scriptedDialer();
  const conn: ExecConn = { dial: engine.dial, apiPath: async () => "/v1.52" };
  const result = runExec(conn, { container: "box", command }, input, {
    timeoutMs: 2000,
    ...options,
  });
  result.catch(() => {}); // asserted per test
  return { engine, result };
}

async function upgrade(engine: ReturnType<typeof scriptedDialer>): Promise<FakeDuplex> {
  const create = await engine.next();
  create.duplex.receive(response(201, '{"Id":"exec1"}'));
  const s = await engine.next();
  s.duplex.receive(UPGRADED);
  await settle();
  return s.duplex;
}

/** Answer the next `GET /exec/exec1/json`. */
async function inspect(
  engine: ReturnType<typeof scriptedDialer>,
  running: boolean,
  exitCode: number | null,
) {
  const { duplex, req } = await engine.next();
  expect(req.method).toBe("GET");
  expect(req.path).toBe("/v1.52/exec/exec1/json");
  duplex.receive(response(200, JSON.stringify({ Running: running, ExitCode: exitCode })));
}

describe("runExec (docker)", () => {
  test("resolves with the REAL exit code from exec inspect (7, not 0/1), stdout and stderr", async () => {
    const { engine, result } = start();
    const stream = await upgrade(engine);
    stream.receive(frame(1, "out\n"));
    stream.receive(frame(2, "e\n"));
    stream.peerEnd();
    await inspect(engine, false, 7);
    expect(await result).toEqual({ exitCode: 7, stdout: "out\n", stderr: "e\n" });
    expect(stream.closed).toBe(true);
  });

  test("no input: stdin is half-closed right after the upgrade", async () => {
    const { engine } = start();
    const stream = await upgrade(engine);
    expect(stream.calls).toEqual(["end"]);
  });

  test("input: ≤256 KiB chunks, pauses at the high-water mark, resumes on drain, end() once after the last chunk", async () => {
    const size = 6 * 1024 * 1024 + 123;
    const input = new Uint8Array(size).fill(7);
    const progress: number[] = [];
    const { engine, result } = start(input, { onProgress: (n) => progress.push(n) });
    const create = await engine.next();
    create.duplex.receive(response(201, '{"Id":"exec1"}'));
    const s = await engine.next();
    const stream = s.duplex;
    const headLen = s.req.raw.length;
    // Model a connection whose queue fills: every write adds to `buffered`.
    const write = stream.write.bind(stream);
    stream.write = (b: Uint8Array) => {
      write(b);
      stream.buffered += b.length;
    };
    stream.receive(UPGRADED);
    await settle();

    const sent = (): number => stream.bytes().length - headLen;
    expect(sent()).toBe(SEND_HIGH_WATER_BYTES); // paused exactly at the mark
    expect(stream.calls).toEqual([]); // not ended yet
    for (const w of stream.written.slice(1)) {
      expect(w.length).toBeLessThanOrEqual(256 * 1024);
    }
    stream.drain();
    expect(sent()).toBe(size);
    expect(stream.calls).toEqual(["end"]);
    expect(progress[progress.length - 1]).toBe(size);
    expect(progress.every((n, i) => i === 0 || n > (progress[i - 1] as number))).toBe(true);

    stream.peerEnd();
    await inspect(engine, false, 0);
    expect((await result).exitCode).toBe(0);
    expect(stream.calls.filter((c) => c === "end")).toHaveLength(1);
  });

  test("stream closed but the exec still Running: bounded re-poll, then exitCode null + status", async () => {
    const { engine, result } = start();
    const stream = await upgrade(engine);
    stream.peerEnd();
    for (let i = 0; i <= EXIT_POLL_ATTEMPTS; i++) {
      await inspect(engine, true, null);
    }
    const r = await result;
    expect(r.exitCode).toBeNull();
    expect(r.status).toBe("exec still running after its stream closed");
  });

  test("the race resolves when a re-poll sees the exit", async () => {
    const { engine, result } = start();
    const stream = await upgrade(engine);
    stream.peerEnd();
    await inspect(engine, true, null);
    await inspect(engine, false, 3);
    expect((await result).exitCode).toBe(3);
  });

  test("timeout → reject and the connection is closed", async () => {
    const { engine, result } = start(undefined, { timeoutMs: 30 });
    const stream = await upgrade(engine);
    await expect(result).rejects.toThrow("exec timed out after 30ms");
    expect(stream.closed).toBe(true);
  });

  test("abort → AbortError and the connection is closed", async () => {
    const ac = new AbortController();
    const { engine, result } = start(undefined, { signal: ac.signal });
    const stream = await upgrade(engine);
    ac.abort();
    await expect(result).rejects.toThrow("aborted");
    expect(stream.closed).toBe(true);
  });

  test("the stream ends mid-frame → reject (truncated output is not trustworthy)", async () => {
    const { engine, result } = start();
    const stream = await upgrade(engine);
    stream.receive(frame(1, "abcdef").subarray(0, 10));
    stream.peerEnd();
    await expect(result).rejects.toThrow("exec stream ended mid-frame");
  });

  test("a malformed header → reject", async () => {
    const { engine, result } = start();
    const stream = await upgrade(engine);
    stream.receive("not a frame at all");
    await expect(result).rejects.toThrow("malformed docker stream header");
  });

  test("systemErr text lands in status", async () => {
    const { engine, result } = start();
    const stream = await upgrade(engine);
    stream.receive(frame(3, "engine trouble\n"));
    stream.peerEnd();
    await inspect(engine, false, 1);
    expect((await result).status).toBe("engine trouble");
  });

  test("a binary that cannot start (no shell in the image) → a plain status naming it", async () => {
    const { engine, result } = start(undefined, {}, ["sh", "-c", "uname -m"]);
    const stream = await upgrade(engine);
    stream.receive(
      frame(
        1,
        'OCI runtime exec failed: exec failed: unable to start container process: exec: "sh": executable file not found in $PATH: unknown\r\n',
      ),
    );
    stream.peerEnd();
    await inspect(engine, false, 127);
    const r = await result;
    expect(r.exitCode).toBe(127);
    expect(r.status).toMatch(
      /^command "sh" could not be started in container "box" \(exit 127\): OCI runtime exec failed/,
    );
  });

  /**
   * Exec create on a stopped container: Docker says 409, Podman 500 with
   * different text. The client decides from the container's state (an inspect),
   * never from the error text, so both engines give the same message.
   */
  async function failCreate(status: number, engineMessage: string, state: string | null) {
    const { engine, result } = start();
    const create = await engine.next();
    create.duplex.receive(response(status, JSON.stringify({ message: engineMessage })));
    const inspect = await engine.next();
    expect(inspect.req.method).toBe("GET");
    expect(inspect.req.path).toBe("/v1.52/containers/box/json");
    inspect.duplex.receive(
      state === null
        ? response(404, '{"message":"No such container: box"}')
        : response(
            200,
            JSON.stringify({ Id: "box", State: { Status: state, Running: state === "running" } }),
          ),
    );
    return result.then(
      () => undefined,
      (e: Error) => e.message,
    );
  }

  const notRunning = 'container "box" is not running (state: exited) — start it or use `run`';

  test("Docker: 409 on create + container exited → the clear 'not running' error", async () => {
    expect(await failCreate(409, "container abc is not running", "exited")).toBe(notRunning);
  });

  test("Podman: 500 'container state improper' + container exited → the SAME error", async () => {
    const podman = "can only create exec sessions on running containers: container state improper";
    expect(await failCreate(500, podman, "exited")).toBe(notRunning);
  });

  test("create fails but the container IS running → the raw engine error surfaces", async () => {
    expect(await failCreate(500, "OCI runtime boom", "running")).toBe(
      "Docker API request failed with status 500: OCI runtime boom",
    );
  });

  test("create fails and the container is gone → 'not found'", async () => {
    expect(await failCreate(404, "No such container: box", null)).toBe(
      'container "box" not found (No such container: box)',
    );
  });

  test("a non-JSON inspect answer never replaces the engine's create error (Review F5)", async () => {
    const { engine, result } = start();
    (await engine.next()).duplex.receive(response(500, '{"message":"OCI runtime boom"}'));
    (await engine.next()).duplex.receive(
      "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 9\r\n\r\n<html>hi!",
    );
    await expect(result).rejects.toThrow(
      "Docker API request failed with status 500: OCI runtime boom",
    );
  });
});
