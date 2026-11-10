import { describe, expect, test } from "bun:test";
import type { BackgroundHandle, ExecutionEnvironment } from "@tentacle/core";
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
  let done = false;
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
      // Like the real handle: true only while there is something to signal.
      kill: () => {
        wasKilled = true;
        return !done;
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
      done = true;
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

  test("fires onStart once, before any output, and the listener already sees the job", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const seen: string[] = [];
    const lists: number[] = [];
    jobs.onStart((job) => {
      seen.push(`${job.id}:${job.status}`);
      lists.push(jobs.list().length);
    });

    const job = jobs.start("watch");
    expect(seen).toEqual([`${job.id}:running`]);
    // The job is in the registry by the time the listener runs.
    expect(lists).toEqual([1]);
    // It fires once, on start — never again.
    fake.emitOut("x\n");
    fake.finish(0);
    await tick();
    expect(seen).toEqual([`${job.id}:running`]);
  });

  test("a throwing onStart listener cannot fail the start", () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    jobs.onStart(() => {
      throw new Error("broken sink");
    });
    expect(() => jobs.start("watch")).not.toThrow();
  });

  test("tail returns the last lines and leaves the model's read cursor alone", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("serve");
    fake.emitOut("line 1\nline 2\nline 3\n");
    await tick();

    const tail = jobs.tail(job.id, { lines: 2 });
    expect(tail?.stdout).toEqual(["line 2", "line 3"]);
    expect(tail?.truncated).toBe(true);
    expect(tail?.job.id).toBe(job.id);

    // The tail stole nothing: the model's next `shell_output` sees it all.
    expect(jobs.read(job.id)?.stdout).toBe("line 1\nline 2\nline 3\n");
  });

  test("tail after a buffer flood reports truncated and still returns the last lines", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("flood");
    fake.emitOut(`${"x".repeat(300 * 1024)}\nEND\n`);
    await tick();

    const tail = jobs.tail(job.id, { lines: 5, maxChars: 4096 });
    expect(tail?.truncated).toBe(true);
    expect(tail?.stdout.at(-1)).toBe("END");
  });

  test("tail of an exited job works; of an unknown id is undefined", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("once");
    fake.emitOut("done\n");
    fake.finish(0);
    await tick();

    expect(jobs.tail(job.id)?.stdout).toEqual(["done"]);
    expect(jobs.tail(job.id)?.job.status).toBe("exited");
    expect(jobs.tail("bg-99")).toBeUndefined();
  });

  test("tail splits on newline, keeps a progress bar's last frame (the M1 rule)", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("curl");

    // A carriage-return progress bar overwrites itself: one line, last frame.
    fake.emitOut("10%\r50%\r90%");
    await tick();
    expect(jobs.tail(job.id)?.stdout).toEqual(["90%"]);

    // A complete line arrives: the bar becomes a line of its own.
    fake.emitOut("\n100%\n");
    await tick();
    expect(jobs.tail(job.id)?.stdout).toEqual(["90%", "100%"]);
  });

  test("tail of one huge line with no newline is a non-empty, cut line", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("dd");

    fake.emitOut("z".repeat(1024 * 1024));
    await tick();
    const tail = jobs.tail(job.id, { lines: 12, maxChars: 4096 });
    // Not an empty drawer: the line's tail end survives, flagged as cut.
    expect(tail?.stdout).toHaveLength(1);
    expect(tail?.stdout[0]?.length).toBe(4096);
    expect(tail?.stdout[0]).toBe("z".repeat(4096));
    expect(tail?.truncated).toBe(true);
  });

  test("tail keeps the line still being written and the head partial only when a line remains", async () => {
    const running = fakeHandle();
    const jobs = new BackgroundJobs(envWith(running.handle));
    const job = jobs.start("ab");

    // "a" is complete; "b" is the line being written — still the job's output.
    running.emitOut("a\nb");
    await tick();
    expect(jobs.tail(job.id)?.stdout).toEqual(["a", "b"]);

    // A head partial (cut by maxChars) is dropped when a complete line remains.
    running.emitOut("complete tail\n");
    await tick();
    const cut = jobs.tail(job.id, { lines: 12, maxChars: 8 });
    expect(cut?.stdout).toEqual(["te tail"]);
    expect(cut?.truncated).toBe(true);

    // A blank interior line is a real line and is preserved as "".
    const blank = fakeHandle();
    const blankJobs = new BackgroundJobs(envWith(blank.handle));
    const second = blankJobs.start("blank");
    blank.emitOut("a\n\nb\n");
    await tick();
    expect(blankJobs.tail(second.id)?.stdout).toEqual(["a", "", "b"]);
  });

  test("tail returns raw lines: sanitising is the client's job", async () => {
    const fake = fakeHandle();
    const jobs = new BackgroundJobs(envWith(fake.handle));
    const job = jobs.start("paint");
    fake.emitOut("\u001b[2Jx\n");
    await tick();

    // The escape survives exec untouched (a pod's bytes are untrusted: the
    // client, never exec, is the gate).
    expect(jobs.tail(job.id)?.stdout).toEqual(["\u001b[2Jx"]);
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
