import { describe, expect, test } from "bun:test";
import { Agent, SessionGrants } from "@tentacle/agent";
import {
  AgentJobs,
  type BackgroundJob,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import { DomainErrorCode, type SessionUpdate } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import type { Attachment, HostedSession } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

// docs/feat/clear-keeps-jobs.md — T5..T13: `/clear` resets the conversation
// INSIDE the session through the compaction barrier; background work stays.

const CWD = "/tmp/clear-keeps-jobs";
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

async function until(pred: () => boolean, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
  expect(pred()).toBe(true);
}

/** A chat model: replies "ok"; while `gate` is set, a stream waits for it. */
class Chat implements ModelProvider {
  readonly id = "chat";
  gate: Promise<void> | null = null;
  readonly seen: ChatMessage[][] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push([...request.messages]);
    if (this.gate) {
      await this.gate;
    }
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

class TitleModel implements ModelProvider {
  readonly id = "title";
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "Fix the login bug" };
    yield { type: "done" };
  }
}

class FakeJobs implements JobController {
  private readonly ls = new Set<(j: BackgroundJob) => void>();
  running = true;
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read(): undefined {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [
      {
        id: "bg-1",
        command: "npm run dev",
        startedAt: 0,
        status: this.running ? "running" : "exited",
        exitCode: null,
      },
    ];
  }
  disposed = false;
  dispose(): void {
    this.disposed = true;
  }
  onStart(): () => void {
    return () => {};
  }
  onExit(l: (j: BackgroundJob) => void): () => void {
    this.ls.add(l);
    return () => this.ls.delete(l);
  }
  fire(): void {
    this.running = false;
    for (const l of [...this.ls]) {
      l({ id: "bg-1", command: "npm run dev", startedAt: 0, status: "exited", exitCode: 0 });
    }
  }
}

const shellTool: Tool = {
  name: "shell",
  description: "shell",
  inputSchema: z.object({ command: z.string() }),
  permission: "ask",
  async execute() {
    return { content: "" };
  },
};

function rig(
  opts: {
    wake?: boolean;
    title?: boolean;
    noGrants?: boolean;
    titleModel?: ModelProvider;
  } = {},
) {
  const jobs = new FakeJobs();
  const agentJobs = new AgentJobs(2);
  const broker = new PermissionBroker();
  const grants = new SessionGrants();
  const model = new Chat();
  const errors: Error[] = [];
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(opts.wake ? { wakeOnJobExit: true } : {}),
    onTurnError: (e) => errors.push(e),
    createAgent: () => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        jobs,
        agentJobs,
        systemPrompt: "sys",
      }),
      permissions: broker,
      jobs,
      agentJobs,
      ...(opts.noGrants ? {} : { grants }),
      ...(opts.titleModel
        ? { titleModel: opts.titleModel }
        : opts.title
          ? { titleModel: new TitleModel() }
          : {}),
    }),
  });
  const updates: SessionUpdate[] = [];
  const attachment: Attachment = { send: (u) => void updates.push(u.update as SessionUpdate) };
  const open = (messages?: ChatMessage[]): HostedSession =>
    host.open({ create: true, ...(messages ? { messages: messages as never } : {}) }, attachment)
      .hosted;
  const of = <T extends SessionUpdate["type"]>(type: T) =>
    updates.filter((u): u is Extract<SessionUpdate, { type: T }> => u.type === type);
  return { jobs, agentJobs, broker, grants, model, errors, host, updates, open, of };
}

const OLD: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "old chat" },
  { role: "assistant", content: "old reply" },
];

/** Start a child that asks once `askGate` opens and ends when `endGate` opens. */
function startChild(r: ReturnType<typeof rig>) {
  const askGate = Promise.withResolvers<void>();
  const endGate = Promise.withResolvers<void>();
  r.agentJobs.start(
    { callId: "c1", agentType: "general", description: "map the repo" },
    async ({ signal, agentId }) => {
      await askGate.promise;
      void r.broker.request(
        { tool: "shell", input: {} } as unknown as PermissionRequest,
        {
          signal,
          agent: { id: agentId, type: "general", description: "map the repo" },
        } as never,
      );
      await endGate.promise;
      return { report: "the repo has 15 packages", toolUses: 3, stopReason: "end_turn" };
    },
  );
  return { askGate, endGate };
}

const logTypes = (hosted: HostedSession): string[] =>
  hosted.logRead().entries.map((e) => {
    const x = e as { type: string; reason?: string; agentId?: string };
    const extra = x.reason ?? x.agentId;
    return extra ? `${x.type}(${extra})` : x.type;
  });

describe("session.clear — the load-bearing assumption (T5–T8)", () => {
  test("T5 a running child's ask is raised by the same session; its end lands in the new segment after the re-emitted subagent_background", async () => {
    // Mutation: skip `logSegmentFacts()` in the barrier → no subagent_background(sa-1).
    const r = rig();
    const hosted = r.open(OLD);
    const child = startChild(r);
    await new Promise((x) => setTimeout(x, 5));
    expect(hosted.clear()).toEqual({ before: 3, after: 2 });
    child.askGate.resolve();
    await until(() => r.of("permission_request").length > 0);
    child.endGate.resolve();
    await until(() => logTypes(hosted).includes("subagent_end(sa-1)"));
    const types = logTypes(hosted);
    const bg = types.indexOf("subagent_background(sa-1)");
    expect(types[0]).toBe("base(compact)");
    expect(bg).toBeGreaterThan(0);
    expect(types.indexOf("subagent_end(sa-1)")).toBeGreaterThan(bg);
  });

  test("T6 a job's and a child's exit after clear stream from the same session, are pending, and the next turn delivers both notes", async () => {
    // Mutation: dispose `jobs` in `clear` → the job exit never streams.
    const r = rig();
    const hosted = r.open(OLD);
    const child = startChild(r);
    await new Promise((x) => setTimeout(x, 5));
    hosted.clear();
    expect(r.jobs.disposed).toBe(false);
    child.askGate.resolve();
    child.endGate.resolve();
    r.jobs.fire();
    await until(() => hosted.unflushedExits === 2);
    expect(
      r
        .of("background_exit")
        .map((u) => u.jobId)
        .sort(),
    ).toEqual(["bg-1", "sa-1"]);
    hosted.prompt("t1", []);
    await until(() => !hosted.running && hosted.unflushedExits === 0);
    const kinds = hosted
      .snapshotPage()
      .messages.map((m) => m.note?.kind)
      .filter((k) => k !== undefined);
    expect(kinds).toContain("background_exit");
    expect(kinds).toContain("subagent_report");
  });

  test("T7 the subagents list survives clear: the snapshot after it names the child", async () => {
    // Mutation: `subagents: []` in the cut for `clear`.
    const r = rig();
    const hosted = r.open(OLD);
    startChild(r);
    await new Promise((x) => setTimeout(x, 5));
    hosted.clear();
    const snap = hosted.snapshotPage() as unknown as { subagents?: { id: string }[] };
    expect(snap.subagents?.map((s) => s.id)).toEqual(["sa-1"]);
  });

  test("T8 clear emits history_replaced{clear} but logs base.reason compact", () => {
    // Mutation: log "clear" (a reader's `LogBaseReasonSchema` refuses it).
    const r = rig();
    const hosted = r.open(OLD);
    hosted.clear();
    expect(r.of("history_replaced").map((u) => u.reason)).toEqual(["clear"]);
    expect(logTypes(hosted)[0]).toBe("base(compact)");
  });
});

describe("session.clear — the daemon's own steps (T9–T13)", () => {
  test("T9 refuses during a turn and during a compaction, and changes NOTHING", async () => {
    // Mutation: do any step (grants / title / history) before `assertIdle`.
    const r = rig();
    const hosted = r.open(OLD);
    r.grants.remember(shellTool, { suggestion: { prefix: "bun test" } } as never);
    const state = () =>
      JSON.stringify({
        messages: hosted.snapshotPage().messages,
        covers: r.grants.covers(shellTool, { command: "bun test a" }),
        log: hosted.logRead().entries.length,
        replaced: r.of("history_replaced").length,
      });
    const before = state();

    const gate = Promise.withResolvers<void>();
    r.model.gate = gate.promise;
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    await until(() => r.model.seen.length > 0);
    const turnState = state();
    let code: number | undefined;
    try {
      hosted.clear();
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.TurnInProgress);
    expect(state()).toBe(turnState);
    gate.resolve();
    await until(() => !hosted.running);
    r.model.gate = null;

    const compactGate = Promise.withResolvers<void>();
    r.model.gate = compactGate.promise;
    const compacting = hosted.compact();
    await until(() => r.model.seen.length > 1);
    const compactState = state();
    code = undefined;
    try {
      hosted.clear();
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.CompactInProgress);
    expect(state()).toBe(compactState);
    compactGate.resolve();
    await compacting;
    expect(before).not.toBe(state()); // the rig did move on (not a vacuous comparison)
  });

  test("T10 clear empties the session approvals", () => {
    // Mutation: skip `grants.clear()`.
    const r = rig();
    const hosted = r.open(OLD);
    r.grants.remember(shellTool, { suggestion: { prefix: "bun test" } } as never);
    expect(r.grants.covers(shellTool, { command: "bun test a" })).toBe(true);
    hosted.clear();
    expect(r.grants.covers(shellTool, { command: "bun test a" })).toBe(false);
  });

  test("H1 a session built WITHOUT an approvals store reports it on clear (never a silent skip), and still clears", () => {
    // Mutation: back to `this.grants?.clear()` → no report.
    const r = rig({ noGrants: true });
    const hosted = r.open(OLD);
    expect(hosted.clear()).toEqual({ before: 3, after: 2 });
    expect(r.errors.map((e) => e.message)).toEqual([expect.stringContaining("no approvals store")]);
    expect(r.of("history_replaced").map((u) => u.reason)).toEqual(["clear"]);
  });

  test("T11 a model title becomes auto, a user title stays; the new segment's title entry says so", async () => {
    // Mutation: reset the title AFTER the barrier (the segment's entry keeps `model`).
    const model = rig({ title: true });
    const a = model.open();
    a.prompt("t1", [{ type: "text", text: "please fix the login bug" }]);
    await until(
      () =>
        (a.snapshotPage() as unknown as { title?: { source: string } }).title?.source === "model",
    );
    a.clear();
    const titleEntry = a
      .logRead()
      .entries.filter((e) => (e as { type: string }).type === "title")
      .at(-1) as { title?: { source?: string } } | undefined;
    expect(titleEntry?.title?.source).toBe("auto");
    expect((a.snapshotPage() as unknown as { title?: { source: string } }).title?.source).toBe(
      "auto",
    );

    const user = rig();
    const b = user.open(OLD);
    b.rename("My name");
    b.clear();
    const t = (b.snapshotPage() as unknown as { title?: { text: string; source: string } }).title;
    expect(t).toEqual({ text: "My name", source: "user" });
  });

  test("L5 a title being generated from the OLD chat does not land after the clear", async () => {
    // Mutation: drop `abortTitle()` + the `titleKick` clear in `clear()` → the
    // old chat's title lands after the clear (review M5 survived before this test).
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    class GatedTitle implements ModelProvider {
      readonly id = "gated-title";
      // Ignores the abort signal on purpose: the strongest form of a late answer.
      async *stream(): AsyncIterable<StreamEvent> {
        started.resolve();
        await release.promise;
        yield { type: "text", delta: "Title of the old chat" };
        yield { type: "done" };
      }
    }
    const r = rig({ titleModel: new GatedTitle() });
    const hosted = r.open();
    hosted.prompt("t1", [{ type: "text", text: "please fix the login bug" }]);
    await until(() => !hosted.running);
    await started.promise; // the title request is in flight
    const titlesBefore = r.of("session_title").length;
    hosted.clear();
    release.resolve();
    await new Promise((x) => setTimeout(x, 60));
    expect(r.of("session_title").length).toBe(titlesBefore);
    expect((hosted.snapshotPage() as unknown as { title?: { source: string } }).title?.source).toBe(
      "auto",
    );
  });

  test("T12 after a stopped turn, clear re-enables the wake: a pending exit wakes (autoWake)", async () => {
    // Mutation: skip `lastEndBad = false`.
    const r = rig({ wake: true });
    const hosted = r.open(OLD);
    hosted.prompt("t1", [{ type: "text", text: "go" }]);
    hosted.cancel();
    await until(() => !hosted.running);
    r.jobs.fire();
    await new Promise((x) => setTimeout(x, 30));
    const calls = r.model.seen.length;
    expect(hosted.unflushedExits).toBe(1); // the stopped turn blocks the wake
    hosted.clear();
    await until(() => r.model.seen.length > calls);
    await until(() => !hosted.running && hosted.unflushedExits === 0);
  });

  test("T13 the still-running note is the installed head: a send-now after clear is NoTurnRunning", () => {
    // Mutation: `compactionSummary = undefined` after the barrier (the note then awaits an answer).
    const r = rig();
    const hosted = r.open(OLD);
    hosted.clear();
    expect(hosted.snapshotPage().messages.at(-1)?.note?.kind).toBe("still_running");
    let code: number | undefined;
    try {
      hosted.sendNow("sn", { kind: "turn", turnId: "gone" }, []);
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.NoTurnRunning);
  });
});
