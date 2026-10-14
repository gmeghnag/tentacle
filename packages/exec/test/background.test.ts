import { describe, expect, test } from "bun:test";
import type { BackgroundHandle, ExecutionEnvironment } from "@agent-harness/core";
import { BackgroundJobs } from "../src/background.ts";

/** A controllable in-memory background handle for tests. */
function fakeHandle(): {
  handle: BackgroundHandle;
  emitOut: (s: string) => void;
  emitErr: (s: string) => void;
  finish: (code: number | null) => void;
  killed: () => boolean;
} {
  let outCtl!: ReadableStreamDefaultController<Uint8Array>;
  let errCtl!: ReadableStreamDefaultController<Uint8Array>;
  let resolve!: (code: number | null) => void;
  let wasKilled = false;
  const enc = new TextEncoder();
  const stdout = new ReadableStream<Uint8Array>({
    start: (c) => {
      outCtl = c;
    },
  });
  const stderr = new ReadableStream<Uint8Array>({
    start: (c) => {
      errCtl = c;
    },
  });
  const exited = new Promise<number | null>((r) => {
    resolve = r;
  });
  return {
    handle: {
      pid: 4242,
      stdout,
      stderr,
      exited,
      kill: () => {
        wasKilled = true;
      },
    },
    emitOut: (s) => outCtl.enqueue(enc.encode(s)),
    emitErr: (s) => errCtl.enqueue(enc.encode(s)),
    finish: (code) => {
      try {
        outCtl.close();
        errCtl.close();
      } catch {
        // already closed
      }
      resolve(code);
    },
    killed: () => wasKilled,
  };
}

function envWith(handle: BackgroundHandle): ExecutionEnvironment {
  return {
    id: "fake",
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: () => Promise.resolve(""),
    writeFile: () => Promise.resolve(),
    spawnBackground: () => handle,
  };
}

/** Let queued stream/microtasks drain. */
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("BackgroundJobs", () => {
  test("captures output incrementally and reports status/exit on finish", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));

    const started = jobs.start("serve");
    expect(started.status).toBe("running");
    expect(started.pid).toBe(4242);
    expect(jobs.list()).toHaveLength(1);

    fake.emitOut("hello\n");
    await tick();
    const first = jobs.read(started.id);
    expect(first?.stdout).toBe("hello\n");

    // A second read returns only what is new.
    expect(jobs.read(started.id)?.stdout).toBe("");

    fake.emitOut("more\n");
    fake.emitErr("warn\n");
    await tick();
    const second = jobs.read(started.id);
    expect(second?.stdout).toBe("more\n");
    expect(second?.stderr).toBe("warn\n");

    fake.finish(0);
    await tick();
    const done = jobs.read(started.id);
    expect(done?.job.status).toBe("exited");
    expect(done?.job.exitCode).toBe(0);
  });

  test("fires onExit with the final snapshot", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const exits: string[] = [];
    jobs.onExit((job) => exits.push(`${job.id}:${job.status}:${job.exitCode}`));

    const job = jobs.start("build");
    fake.finish(2);
    await tick();
    expect(exits).toEqual([`${job.id}:exited:2`]);
  });

  test("kill marks the job killed and invokes the handle", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("sleep 999");

    expect(jobs.kill(job.id)).toBe(true);
    expect(fake.killed()).toBe(true);
    // A signal-killed process reports a null exit code.
    fake.finish(null);
    await tick();
    expect(jobs.read(job.id)?.job.status).toBe("killed");

    // Killing an already-finished job is a no-op.
    expect(jobs.kill(job.id)).toBe(false);
  });

  test("read of an unknown job is undefined", () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    expect(jobs.read("nope")).toBeUndefined();
  });

  test("start throws when the environment cannot spawn in the background", () => {
    const env: ExecutionEnvironment = {
      id: "no-bg",
      exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
      readFile: () => Promise.resolve(""),
      writeFile: () => Promise.resolve(),
    };
    const jobs = new BackgroundJobs(env);
    expect(() => jobs.start("x")).toThrow("background execution is not supported");
  });
});
