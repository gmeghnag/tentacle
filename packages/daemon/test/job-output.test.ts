/**
 * docs/feat/shell-jobs-panel.md — `session/job_output` (daemon side).
 *
 * The daemon BOUNDS SIZES only: trust is the client's (`boundJobOutput`), because
 * a pod's bytes are untrusted (§7). The read is cursor-free, so the model's next
 * `shell_output` still sees everything.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type BackgroundHandle,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { BackgroundJobs } from "@tentacle/exec";
import { ToolRegistry } from "@tentacle/tools";
import { type Attachment, HostedSession } from "../src/hosted-session.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

class Quiet implements ModelProvider {
  readonly id = "q";
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  }
}

/** One controllable background handle: emit output, then finish. */
function fakeHandle(): {
  handle: BackgroundHandle;
  emitOut: (s: string) => void;
  emitErr: (s: string) => void;
  finish: (code: number | null) => void;
} {
  let outCtl!: ReadableStreamDefaultController<Uint8Array>;
  let errCtl!: ReadableStreamDefaultController<Uint8Array>;
  let resolve!: (code: number | null) => void;
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
    handle: { pid: 7, stdout, stderr, exited, kill: () => true },
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
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function hostedWith(jobs: BackgroundJobs): HostedSession {
  const agent = new Agent({ model: new Quiet(), tools: new ToolRegistry(), env: noopEnv, jobs });
  const session = new Session(agent, "s1", {});
  const attachment: Attachment = { send: () => {} };
  const hosted = new HostedSession("s1", session, new PermissionBroker(), jobs, {}, 4096);
  hosted.attach(attachment);
  return hosted;
}

function jobsWith(fake: ReturnType<typeof fakeHandle>): BackgroundJobs {
  const env: ExecutionEnvironment = { ...noopEnv, spawnBackground: () => fake.handle };
  return new BackgroundJobs(env);
}

describe("session/job_output", () => {
  test("bounds lines to ≤ 200 (capacity, not trust)", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("many");
    fake.emitOut(Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"));
    await tick();

    const result = hosted.jobOutput(job.id, { lines: 200 });
    expect(result.found).toBe(true);
    expect(result.output?.length).toBe(200);
    expect(result.output?.at(-1)).toBe("line 299");
  });

  test("a 1 MB line is a NON-EMPTY cut line, flagged truncated (the M1 rule)", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("huge");
    fake.emitOut("q".repeat(1024 * 1024));
    await tick();

    const result = hosted.jobOutput(job.id, { lines: 12, maxChars: 4096 });
    // A dropped line would leave this empty — the exact vacuous pass L3 warns of.
    expect(result.output).toHaveLength(1);
    expect(result.output?.[0]?.length).toBe(4096);
    expect(result.output?.[0]).toBe("q".repeat(4096));
    expect(result.truncated).toBe(true);
  });

  test("an unknown id is a typed refusal, never a throw", () => {
    const fake = fakeHandle();
    const hosted = hostedWith(jobsWith(fake));
    expect(hosted.jobOutput("bg-99")).toEqual({
      found: false,
      jobId: "bg-99",
      reason: "this session cannot show a job's output here",
    });
  });

  test("an exited job is readable with its exitCode", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("once");
    fake.emitOut("done\n");
    fake.finish(3);
    await tick();

    const result = hosted.jobOutput(job.id);
    expect(result.found).toBe(true);
    expect(result.status).toBe("exited");
    expect(result.exitCode).toBe(3);
    expect(result.output).toEqual(["done"]);
  });

  test("the model's read cursor is untouched by a panel read", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("chatty");
    fake.emitOut("one\ntwo\n");
    await tick();

    hosted.jobOutput(job.id);
    hosted.jobOutput(job.id);
    // The model's next `shell_output` still sees the whole output.
    expect(jobs.read(job.id)?.output).toBe("one\ntwo\n");
  });

  test("owner A: ONE array in ARRIVAL order, the stream the model reads", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("both");
    fake.emitOut("out 1\n");
    await tick();
    fake.emitErr("err 1\n");
    await tick();
    fake.emitOut("out 2\n");
    await tick();

    // Not `out 1, out 2, err 1` (stdout then stderr): the process's own order.
    const result = hosted.jobOutput(job.id);
    expect(result.output).toEqual(["out 1", "err 1", "out 2"]);
    // And the model's read is the SAME timeline, so the two can never disagree.
    const model = (jobs.read(job.id)?.output ?? "").split("\n").filter((l) => l !== "");
    expect(model).toEqual(result.output ?? []);
  });

  test("owner A: 20 stderr + 5 stdout lines all fit one 12-line window, stdout visible", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("noisy");
    for (let i = 1; i <= 20; i++) {
      fake.emitErr(`err${i}\n`);
    }
    await tick();
    for (let i = 1; i <= 5; i++) {
      fake.emitOut(`OUT${i}\n`);
    }
    await tick();

    // The reviewer's finding 2: with a per-stream `lines` budget the merged
    // window was `err9…err20` and no stdout line ever appeared. One budget over
    // one arrival-ordered stream makes the stdout the LAST 5 rows — visible.
    const result = hosted.jobOutput(job.id, { lines: 12 });
    expect(result.output).toHaveLength(12);
    expect(result.output?.slice(-5)).toEqual(["OUT1", "OUT2", "OUT3", "OUT4", "OUT5"]);
  });

  test("output stays RAW: the client, never the daemon, is the gate", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("paint");
    fake.emitOut("\u001b[2Jx\n");
    await tick();

    // A pod daemon's stripping would be UX only (§7): the escape survives here.
    expect(hosted.jobOutput(job.id).output).toEqual(["\u001b[2Jx"]);
  });

  test("a registry without tail answers a typed refusal", () => {
    const hosted = hostedWith(fakeHandlelessJobs());
    expect(hosted.jobOutput("bg-1")).toEqual({
      found: false,
      jobId: "bg-1",
      reason: "this session cannot show a job's output here",
    });
  });

  test("session/job_kill stops the job and reports it; unknown is false", async () => {
    const fake = fakeHandle();
    const jobs = jobsWith(fake);
    const hosted = hostedWith(jobs);
    const job = jobs.start("stop me");

    expect(hosted.jobKill(job.id)).toEqual({ killed: true });
    expect(hosted.jobKill("bg-99")).toEqual({ killed: false });
  });
});

/** A registry with no `tail` at all: the declared-capability case. */
function fakeHandlelessJobs(): BackgroundJobs {
  const jobs = jobsWith(fakeHandle());
  // A foreign implementation that cannot tail (the interface allows it).
  const bare = Object.create(jobs) as BackgroundJobs;
  Object.defineProperty(bare, "tail", { value: undefined });
  return bare;
}
