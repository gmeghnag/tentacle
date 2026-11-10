/**
 * docs/feat/shell-jobs-panel.md — the `jobs` feed (daemon side).
 *
 * The daemon publishes the FULL running-jobs list on exactly two events: a job's
 * start and its exit. Nothing streams, nothing polls, and an unchanged list
 * sends nothing. The rows are the wire's truth and are never capped here, so the
 * count a relay derives from them (H1) cannot be client-bounded.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type JobTail,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import type { KnownSessionUpdateParams, SessionUpdate } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type Attachment, HostedSession } from "../src/hosted-session.ts";
import { jobCount, jobRows, sameJobs } from "../src/jobs-view.ts";

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

/** A controller whose starts and exits the test fires on demand. */
function controllableJobs(): JobController & {
  fireStart(job: BackgroundJob): void;
  fireExit(job: BackgroundJob): void;
  setList(jobs: readonly BackgroundJob[]): void;
} {
  let running: BackgroundJob[] = [];
  const starts = new Set<(job: BackgroundJob) => void>();
  const exits = new Set<(job: BackgroundJob) => void>();
  return {
    fireStart(job) {
      // A re-announced id changes nothing: the set is what the frame is about.
      if (!running.some((j) => j.id === job.id)) {
        running = [...running, job];
      }
      for (const l of starts) l(job);
    },
    fireExit(job) {
      running = running.filter((j) => j.id !== job.id);
      for (const l of exits) l(job);
    },
    setList(jobs) {
      running = [...jobs];
    },
    onStart(listener) {
      starts.add(listener);
      return () => starts.delete(listener);
    },
    onExit(listener) {
      exits.add(listener);
      return () => exits.delete(listener);
    },
    start(): BackgroundJob {
      throw new Error("unused");
    },
    read() {
      return undefined;
    },
    kill(): boolean {
      return false;
    },
    list(): readonly BackgroundJob[] {
      return running;
    },
    dispose(): void {},
  };
}

const job = (id: string, command = "watch", startedAt = 1000): BackgroundJob => ({
  id,
  command,
  startedAt,
  status: "running",
  exitCode: null,
});

function makeHosted(
  jobs: JobController,
  seed: readonly ChatMessage[] = [],
): { hosted: HostedSession; frames: SessionUpdate[] } {
  const agent = new Agent({
    model: new Quiet(),
    tools: new ToolRegistry(),
    env: noopEnv,
    jobs,
  });
  const session = new Session(agent, "s1", { messages: seed as ChatMessage[] });
  const frames: SessionUpdate[] = [];
  const attachment: Attachment = {
    send: (params: KnownSessionUpdateParams) => {
      if (params.update) frames.push(params.update as SessionUpdate);
    },
  };
  const hosted = new HostedSession("s1", session, new PermissionBroker(), jobs, {}, 4096);
  hosted.attach(attachment);
  return { hosted, frames };
}

const jobFrames = (frames: readonly SessionUpdate[]) =>
  frames.filter((f): f is Extract<SessionUpdate, { type: "jobs" }> => f.type === "jobs");

describe("the jobs feed", () => {
  test("a start publishes exactly ONE frame with the bounded row", () => {
    const jobs = controllableJobs();
    const { frames } = makeHosted(jobs);
    // A pod's command is untrusted: one line, control chars gone, ≤ 200 cells.
    const command = `watch ${"\u001b[2J".repeat(2)}${"y".repeat(300)}\nsecond`;
    jobs.fireStart(job("bg-1", command));

    const published = jobFrames(frames);
    expect(published).toHaveLength(1);
    const rows = published[0]?.jobs ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("bg-1");
    expect(rows[0]?.command.length).toBeLessThanOrEqual(200);
    expect(rows[0]?.command).not.toContain("\u001b");
    expect(rows[0]?.command).not.toContain("\n");
    expect(rows[0]?.status).toBe("running");
  });

  test("an exit publishes the list without the row, before the exit notice", () => {
    const jobs = controllableJobs();
    const { frames } = makeHosted(jobs);
    jobs.fireStart(job("bg-1"));
    frames.length = 0;

    jobs.fireExit({ ...job("bg-1"), status: "exited", exitCode: 0 });

    // The list first, then `background_exit` — a row never outlives its death.
    expect(frames.map((f) => f.type)).toEqual(["jobs", "background_exit"]);
    expect(jobFrames(frames)[0]?.jobs).toEqual([]);
  });

  test("an unchanged list emits nothing (sameJobs)", () => {
    const jobs = controllableJobs();
    const { frames } = makeHosted(jobs);
    jobs.fireStart(job("bg-1"));
    expect(jobFrames(frames)).toHaveLength(1);

    // The same list again: a start that changes nothing frames nothing.
    jobs.fireStart(job("bg-1"));
    expect(jobFrames(frames)).toHaveLength(1);
  });

  test("the snapshot's first page carries the list, and /clear's barrier too", () => {
    const jobs = controllableJobs();
    // Two committed messages, so a later page has a real cursor to pass.
    const seed: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
    ];
    const { hosted, frames } = makeHosted(jobs, seed);
    jobs.fireStart(job("bg-1"));

    expect(hosted.snapshotPage().jobs?.map((r) => r.id)).toEqual(["bg-1"]);
    // A later page does not repeat it (first page only).
    const first = hosted.snapshotPage(undefined, 1);
    expect(first.cursor).toBeDefined();
    expect(hosted.snapshotPage(first.cursor).jobs).toBeUndefined();

    // `/clear` keeps jobs (docs/feat/clear-keeps-jobs.md): the barrier's cut
    // carries them, so the list survives.
    hosted.clear();
    const replaced = frames.find((f) => f.type === "history_replaced");
    expect(replaced?.type).toBe("history_replaced");
    expect(hosted.snapshotPage().jobs?.map((r) => r.id)).toEqual(["bg-1"]);
  });

  test("H1: the frame's rows are never capped, and startedAt is the registry's own", () => {
    const jobs = controllableJobs();
    const { frames } = makeHosted(jobs);
    // 40 jobs: the daemon's frame carries all of them (the CLIENT keeps ≤ 32).
    const many = Array.from({ length: 40 }, (_, i) => job(`bg-${i + 1}`));
    jobs.setList(many);
    jobs.fireStart(job("bg-41"));

    const rows = jobFrames(frames)[0]?.jobs ?? [];
    expect(rows).toHaveLength(41);
    expect(rows).toHaveLength(jobCount(jobs.list()));
    // A relative assertion only (L1): this clock is the registry's (in a pod,
    // the pod's `Date.now()`), never the host's injected `now`.
    expect(rows[0]?.startedAt).toBe(jobs.list()[0]?.startedAt ?? -1);
    expect(rows[0]?.startedAt ?? 0).toBeGreaterThan(0);
  });

  test("a closing session does not frame the kills its dispose performs", () => {
    const killed: BackgroundJob[] = [];
    const listeners = new Set<(job: BackgroundJob) => void>();
    const job1 = job("bg-1");
    const jobs: JobController = {
      start(): BackgroundJob {
        throw new Error("unused");
      },
      read() {
        return undefined;
      },
      kill(): boolean {
        return false;
      },
      list: () => [job1],
      onStart: () => () => {},
      onExit(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      dispose() {
        const dead = { ...job1, status: "killed" as const };
        killed.push(dead);
        for (const l of listeners) l(dead);
      },
    };
    const { hosted, frames } = makeHosted(jobs);
    frames.length = 0;
    hosted.close();
    expect(killed).toHaveLength(1);
    // The exit fired, but the session is going away: no frame.
    expect(jobFrames(frames)).toHaveLength(0);
  });
});

describe("jobs-view", () => {
  test("jobRows keeps running jobs only, one line, bounded", () => {
    const rows = jobRows([
      job("bg-1", "a\nb\u001b[0m", 5),
      { ...job("bg-2"), status: "exited" },
      { ...job("bg-3"), status: "killed" },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["bg-1"]);
    expect(rows[0]?.command).not.toContain("\n");
    expect(rows[0]?.command).not.toContain("\u001b");
    expect(rows[0]?.startedAt).toBe(5);
  });

  test("jobCount counts running jobs; sameJobs compares member by member", () => {
    const jobs: BackgroundJob[] = [job("bg-1"), { ...job("bg-2"), status: "exited" }];
    expect(jobCount(jobs)).toBe(1);
    const a = jobRows(jobs);
    expect(sameJobs(a, jobRows(jobs))).toBe(true);
    expect(sameJobs(a, [])).toBe(false);
    const first = a[0];
    if (first === undefined) throw new Error("no row");
    expect(sameJobs(a, [{ ...first, command: "other" }])).toBe(false);
    expect(sameJobs(a, [{ ...first, startedAt: 99 }])).toBe(false);
  });
});

// A `JobTail` is never produced here (the output path is its own test), but the
// interface member must exist on a controller that tails: pin the shape.
test("a controller may omit tail (a typed refusal, never a guess)", () => {
  const controller: JobController = controllableJobs();
  expect(controller.tail).toBeUndefined();
  const tail: JobTail | undefined = controller.tail?.("bg-1");
  expect(tail).toBeUndefined();
});
