/**
 * docs/feat/shell-jobs-panel.md — the client half of the jobs panel.
 *
 * The daemon may be a pod, so the CLIENT is the gate (AGENTS §7): a row's count
 * and labels are bounded here, and `boundJobOutput` is the only place a job's
 * bytes become safe to paint. The hostile-input cases live HERE, not in the
 * daemon's test — a daemon-side strip would be UX only.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type JobTail,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import {
  type JobOutputResult,
  type JobRow,
  JsonRpcErrorCode,
  Method,
  Notification,
  PROTOCOL_VERSION,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  JOB_LINE_MAX,
  MAX_JOB_LINES,
  MAX_JOB_ROWS,
  boundJobOutput,
  boundJobs,
  jobsFromSnapshot,
  sanitizeJobText,
} from "../src/jobs.ts";
import { RemoteClient, type SessionJobsNotice } from "../src/remote-client.ts";

const noopEnv = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
} as unknown as ExecutionEnvironment;

/** Control characters (C0, DEL, C1) and the invisible format classes. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting them is the point
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const FORMAT = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/;

const quiet: ModelProvider = {
  id: "quiet",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  },
};

/** A registry whose list and tail the test sets; start/kill wired to real state. */
class FakeJobs implements JobController {
  running: BackgroundJob[] = [];
  killed: string[] = [];
  tails = new Map<string, JobTail>();
  private readonly startListeners = new Set<(job: BackgroundJob) => void>();
  private readonly exitListeners = new Set<(job: BackgroundJob) => void>();
  add(job: BackgroundJob): void {
    this.running = [...this.running, job];
    for (const l of this.startListeners) l(job);
  }
  remove(id: string): void {
    const job = this.running.find((j) => j.id === id);
    this.running = this.running.filter((j) => j.id !== id);
    if (job) {
      const dead = { ...job, status: "exited" as const, exitCode: 0 };
      for (const l of this.exitListeners) l(dead);
    }
  }
  onStart(listener: (job: BackgroundJob) => void): () => void {
    this.startListeners.add(listener);
    return () => this.startListeners.delete(listener);
  }
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read() {
    return undefined;
  }
  kill(id: string): boolean {
    this.killed.push(id);
    return this.running.some((j) => j.id === id);
  }
  list(): readonly BackgroundJob[] {
    return this.running;
  }
  tail(id: string): JobTail | undefined {
    return this.tails.get(id);
  }
  dispose(): void {}
}

const jobRow = (i: number, extra: Partial<JobRow> = {}): JobRow => ({
  id: `bg-${i}`,
  command: `watch ${i}`,
  startedAt: i,
  status: "running",
  ...extra,
});

const tick = (ms = 15): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("boundJobs: the row list is the client's (≤ 32, one line, bounded)", () => {
  test("at most 32 rows, kept in launch order", () => {
    const many = Array.from({ length: 40 }, (_, i) => jobRow(i + 1));
    const bounded = boundJobs(many);
    expect(bounded).toHaveLength(MAX_JOB_ROWS);
    expect(bounded[0]?.id).toBe("bg-1");
    expect(bounded.at(-1)?.id).toBe("bg-32");
    // A hostile 10 000 rows cost a slice, not 10 000 mappings.
    expect(boundJobs(Array.from({ length: 10_000 }, (_, i) => jobRow(i + 1)))).toHaveLength(32);
  });

  test("every string is one line, a command cut at 200 with an ellipsis", () => {
    const [clean] = boundJobs([
      jobRow(1, {
        id: "bg-1\n",
        command: `a\nb\u001b[31m\u0000c${"z".repeat(500)}`,
        status: "running\n",
      }),
    ]);
    expect(clean?.id).toBe("bg-1");
    expect(clean?.status).toBe("running");
    expect(clean?.command.includes("\n")).toBe(false);
    expect(clean?.command.includes("\u001b")).toBe(false);
    expect(clean?.command.length).toBeLessThanOrEqual(200);
    expect(clean?.command.endsWith("…")).toBe(true);
    // The numbers are kept as they came.
    expect(clean?.startedAt).toBe(1);
  });

  test("a snapshot's list goes through the same bounding; absent stays undefined", () => {
    expect(jobsFromSnapshot(Array.from({ length: 40 }, (_, i) => jobRow(i + 1)))).toHaveLength(32);
    expect(jobsFromSnapshot(undefined)).toBeUndefined();
    expect(jobsFromSnapshot([])).toEqual([]);
  });
});

describe("boundJobOutput: THE sanitising gate (M2)", () => {
  test("a hostile daemon's bytes never reach the terminal", () => {
    const hostile: JobOutputResult = {
      found: true,
      jobId: "bg-1",
      command: `run\u001b[2J${"c".repeat(400)}`,
      // A CSI through C1, a terminal wipe, a bidi override, a zero-width space.
      output: ["\u001b[2Jcleared", "\u009b31mred", "\u202eevil", "zero\u200bwidth"],
    };
    const clean = boundJobOutput(hostile);
    for (const line of clean.output ?? []) {
      expect(CONTROL.test(line)).toBe(false);
      expect(FORMAT.test(line)).toBe(false);
    }
    // The text itself survives as TEXT: nothing is silently dropped.
    expect(clean.output?.[0]).toBe(" [2Jcleared");
    // The C1 CSI opener became ONE space: `[31m` can no longer be a sequence.
    expect(clean.output?.[1]).toBe(" 31mred");
    expect(clean.output?.[2]).toBe("evil");
    expect(clean.output?.[3]).toBe("zerowidth");
    expect(clean.command === undefined ? "" : clean.command).not.toContain("\u001b");
    expect((clean.command ?? "").length).toBeLessThanOrEqual(200);
  });

  test("the array is capped BEFORE mapping, and each line at 512", () => {
    const huge = Array.from({ length: 300 }, (_, i) => `line ${i}`);
    const clean = boundJobOutput({ found: true, jobId: "bg-1", output: huge });
    expect(clean.output).toHaveLength(MAX_JOB_LINES);
    expect(clean.output?.at(-1)).toBe("line 199");

    const one = boundJobOutput({ found: true, jobId: "bg-1", output: ["q".repeat(1024 * 1024)] });
    expect(one.output).toHaveLength(1);
    expect(one.output?.[0]?.length).toBe(JOB_LINE_MAX);
  });

  test("a refusal's reason is sanitized too (it is painted as a notice)", () => {
    const clean = boundJobOutput({
      found: false,
      jobId: "bg-1\n",
      reason: "no\u001b[2Jt a job",
    });
    expect(clean.found).toBe(false);
    expect(clean.jobId).toBe("bg-1");
    expect(clean.reason).toBe("no [2Jt a job");
  });

  test("a tab stays one space, so cell widths match the terminal", () => {
    expect(sanitizeJobText("a\tb")).toBe("a b");
    expect(sanitizeJobText("a\tb").length).toBe(3);
  });
});

describe("an older daemon: typed refusals, never a throw", () => {
  test("both methods answer MethodNotFound ⇒ {found:false} / {killed:false}", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    let seq = 0;
    const notify = (update: unknown): void => {
      peer.notify(Notification.SessionUpdate, { sessionId: "s1", seq: ++seq, update });
    };
    const peer = new RpcPeer(daemonCh, {
      onRequest: async (method: string) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        // An older daemon knows neither method.
        throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    // Attached and LIVE: an unopened session drops every frame by design.
    const session = client.newSession(undefined, "s1", undefined, { attach: {} });
    await session.open();

    // A frame from a newer daemon is understood even so.
    notify({ type: "jobs", jobs: [{ id: "bg-1", command: "w", startedAt: 1, status: "running" }] });
    await tick();
    expect(session.jobs?.map((r) => r.id)).toEqual(["bg-1"]);

    const read = await session.jobOutput("bg-1");
    expect(read.found).toBe(false);
    expect(read.reason).toContain("older version");
    expect(await session.killJob("bg-1")).toEqual({ killed: false });

    client.close();
  });
});

describe("a hostile daemon's `jobs` frame is bounded like any other", () => {
  test("a 300-row list with control chars: 32 rows, one line each, the count unbounded", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    let seq = 0;
    const peer = new RpcPeer(daemonCh, {
      onRequest: async (method: string) => {
        if (method === Method.Initialize) {
          return {
            protocolVersion: PROTOCOL_VERSION,
            agentCapabilities: { tools: true, permissions: true },
          };
        }
        if (method === Method.Open) {
          return { sessionId: "s1", epoch: "e", created: true, resync: false };
        }
        return {};
      },
    });
    const client = new RemoteClient(clientCh, new PermissionBroker());
    await client.initialize();
    // Attached and LIVE: an unopened session drops every frame by design.
    const session = client.newSession(undefined, "s1", undefined, { attach: {} });
    await session.open();

    const reports: { rows: number; count: number }[] = [];
    session.onJobs((r) => reports.push({ rows: r.rows.length, count: r.count }));
    const hostile = Array.from({ length: 300 }, (_, i) => ({
      id: `bg-${i + 1}`,
      command: `w${i}\u001b[2J\n${"z".repeat(300)}`,
      startedAt: i,
      status: "running",
    }));
    peer.notify(Notification.SessionUpdate, {
      sessionId: "s1",
      seq: ++seq,
      update: { type: "jobs", jobs: hostile },
    });
    await tick();

    const last = reports.at(-1);
    expect(last?.rows).toBe(MAX_JOB_ROWS);
    // H1 again: the daemon's own count, never the client's slice.
    expect(last?.count).toBe(300);
    for (const row of session.jobs ?? []) {
      expect(CONTROL.test(row.command)).toBe(false);
      expect(row.command.length).toBeLessThanOrEqual(200);
    }
    client.close();
  });
});

describe("the live list reaches the client (real wire)", () => {
  const rig = () => {
    // One registry per session, like the daemon (`wiring.ts` per session): a
    // shared one would make every session see every job.
    const registries: FakeJobs[] = [];
    const host = new SessionHost({
      defaultCwd: "/tmp/jobs-client",
      createAgent: () => {
        const jobs = new FakeJobs();
        registries.push(jobs);
        return {
          agent: new Agent({ model: quiet, tools: new ToolRegistry(), env: noopEnv, jobs }),
          permissions: new PermissionBroker(),
          jobs,
        };
      },
    });
    const dial = () => {
      const [d, c] = createChannelPair();
      new Connection(d, host);
      return c;
    };
    const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
      channelFactory: async () => dial(),
      random: () => 0,
    });
    const sid = () =>
      [...(host as unknown as { sessions: Map<string, unknown> }).sessions.keys()][0] ?? "";
    const sessions = () => (host as unknown as { sessions: Map<string, unknown> }).sessions.size;
    return { registries, client, sid, sessions, close: () => client.close() };
  };

  const drain = async (events: AsyncIterable<unknown>): Promise<void> => {
    for await (const _event of events) {
      // drain
    }
  };

  const until = async (cond: () => boolean, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
      await tick(5);
    }
  };

  test("a start and an exit reach onJobs with the rows AND the daemon's count", async () => {
    const r = rig();
    await r.client.initialize();
    const session = r.client.newSession();
    const turnDone = drain(session.send("hi"));
    await until(() => r.sid() !== "");

    const notices: SessionJobsNotice[] = [];
    session.onJobs((report) => notices.push({ sessionId: "", ...report }));
    // No report yet: nothing is given, never a guess.
    expect(notices).toEqual([]);
    expect(session.jobs).toBeUndefined();

    r.registries[0]?.add({
      id: "bg-1",
      command: "watch",
      startedAt: 1,
      status: "running",
      exitCode: null,
    });
    await until(() => notices.length > 0);
    expect(notices.at(-1)?.rows.map((x) => x.id)).toEqual(["bg-1"]);
    expect(notices.at(-1)?.count).toBe(1);
    expect(session.jobs?.map((x) => x.id)).toEqual(["bg-1"]);

    r.registries[0]?.remove("bg-1");
    await until(() => (notices.at(-1)?.rows.length ?? -1) === 0);
    expect(notices.at(-1)?.count).toBe(0);
    expect(session.jobs).toEqual([]);

    await turnDone;
    r.close();
  });

  test("the count is the daemon's, never the client's 32-row slice (H1)", async () => {
    const r = rig();
    await r.client.initialize();
    const session = r.client.newSession();
    const turnDone = drain(session.send("hi"));
    await until(() => r.sid() !== "");

    const reports: { rows: number; count: number }[] = [];
    session.onJobs((report) => reports.push({ rows: report.rows.length, count: report.count }));
    // 40 running jobs: the daemon frames all 40, the client keeps 32.
    for (let i = 1; i <= 40; i++) {
      r.registries[0]?.add({
        id: `bg-${i}`,
        command: `w${i}`,
        startedAt: i,
        status: "running",
        exitCode: null,
      });
    }
    await until(() => reports.length > 0);
    const last = reports.at(-1);
    expect(last?.rows).toBe(MAX_JOB_ROWS);
    // The daemon's own number, taken before the client's cap: it must not be 32.
    expect(last?.count).toBe(40);

    await turnDone;
    r.close();
  });

  test("an unrelated session's frame leaves this entry alone", async () => {
    const r = rig();
    await r.client.initialize();
    const one = r.client.newSession();
    const turnOne = drain(one.send("hi"));
    await until(() => r.sid() !== "");
    await turnOne;

    const two = r.client.newSession();
    const turnTwo = drain(two.send("hi"));
    // Both live (each `send` opened its own session daemon-side).
    await until(() => r.sessions() === 2);

    // `bg-9` on session ONE reaches one's listeners and not two's.
    const oneSeen: number[] = [];
    const twoSeen: number[] = [];
    one.onJobs((report) => oneSeen.push(report.rows.length));
    two.onJobs((report) => twoSeen.push(report.rows.length));

    r.registries[0]?.add({
      id: "bg-9",
      command: "w",
      startedAt: 1,
      status: "running",
      exitCode: null,
    });
    await until(() => oneSeen.length > 0);
    expect(twoSeen).toEqual([]);
    expect(one.jobs?.map((x) => x.id)).toEqual(["bg-9"]);
    expect(two.jobs).toBeUndefined();

    await turnTwo;
    r.close();
  });

  test("both methods over the wire; MethodNotFound is a typed refusal, not a throw", async () => {
    const r = rig();
    await r.client.initialize();
    const session = r.client.newSession();
    const turnDone = drain(session.send("hi"));
    await until(() => r.sid() !== "");

    r.registries[0]?.add({
      id: "bg-1",
      command: "watch",
      startedAt: 1,
      status: "running",
      exitCode: null,
    });
    await until(() => session.jobs !== undefined);
    r.registries[0]?.tails.set("bg-1", {
      job: { id: "bg-1", command: "watch", startedAt: 1, status: "running", exitCode: null },
      stdout: ["one", "two"],
      stderr: [],
      truncated: false,
    });

    const read = await session.jobOutput("bg-1", { lines: 12 });
    expect(read.found).toBe(true);
    // Owner Q4 (b): ONE merged line array, as the model's `shell_output` sees it.
    expect(read.output).toEqual(["one", "two"]);

    // The kill goes to the registry, and the row leaves through the exit frame.
    expect(await session.killJob("bg-1")).toEqual({ killed: true });
    expect(r.registries[0]?.killed ?? []).toEqual(["bg-1"]);

    // An unknown job: the daemon's typed refusal.
    const missing = await session.jobOutput("bg-99");
    expect(missing.found).toBe(false);
    expect(missing.reason).toBeDefined();

    await turnDone;
    r.close();
  });
});
