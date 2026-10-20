import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { SessionJobsView, inProcessSessions } from "../src/session-jobs.ts";

class FakeJobs implements JobController {
  disposed = 0;
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  get listenerCount(): number {
    return this.listeners.size;
  }
  fire(id: string, status: BackgroundJob["status"] = "exited"): void {
    const job: BackgroundJob = { id, command: "x", startedAt: 0, status, exitCode: null };
    for (const l of [...this.listeners]) l(job);
  }
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  start(): BackgroundJob {
    return { id: "bg-1", command: "x", startedAt: 0, status: "running", exitCode: null };
  }
  read() {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {
    this.disposed++;
    // A real dispose kills the jobs, which then report their exit.
    this.fire("killed-on-dispose", "killed");
  }
}

describe("SessionJobsView (the TUI's one jobs subscription follows the current session)", () => {
  test("forwards exits from the current session's jobs only", () => {
    // Mutation: `use` keeps the previous subscription → the old session's exit leaks.
    const view = new SessionJobsView();
    const seen: string[] = [];
    view.onExit((job) => seen.push(job.id));
    const a = new FakeJobs();
    const b = new FakeJobs();
    view.use(a);
    a.fire("a1");
    view.use(b);
    a.fire("a2"); // a previous session's: not this transcript's
    b.fire("b1");
    expect(seen).toEqual(["a1", "b1"]);
    expect(a.listenerCount).toBe(0);
  });

  test("release before dispose: a closed session's kills never surface", () => {
    const view = new SessionJobsView();
    const seen: string[] = [];
    view.onExit((job) => seen.push(job.id));
    const a = new FakeJobs();
    view.use(a);
    view.release(a);
    a.dispose();
    expect(seen).toEqual([]);
    // Releasing a non-current one is a no-op.
    const b = new FakeJobs();
    view.use(b);
    view.release(a);
    b.fire("b1");
    expect(seen).toEqual(["b1"]);
  });

  test("delegates to the current session's jobs; empty without one", () => {
    const view = new SessionJobsView();
    expect(view.list()).toEqual([]);
    expect(view.kill("x")).toBe(false);
    expect(() => view.start("x")).toThrow();
    const a = new FakeJobs();
    view.use(a);
    expect(view.start("x").id).toBe("bg-1");
  });
});

describe("inProcessSessions (one agent per in-process session, decision D3)", () => {
  const noopEnv: ExecutionEnvironment = {
    id: "noop",
    exec: () => Promise.reject(new Error("unused")),
    readFile: () => Promise.reject(new Error("unused")),
    writeFile: () => Promise.reject(new Error("unused")),
  };
  const model: ModelProvider = {
    id: "m",
    async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
      yield { type: "text", delta: "ok" };
      yield { type: "done" };
    },
  };
  // Stands in for an MCP tool (any `Tool` registered after connecting).
  const mcpTool: Tool = shellTool;

  function factory(resume: Parameters<typeof inProcessSessions>[0]["resume"] = null) {
    const built: { jobs: FakeJobs; tools: ToolRegistry }[] = [];
    const persisted: string[] = [];
    const sessions = inProcessSessions({
      build: () => {
        const jobs = new FakeJobs();
        const tools = new ToolRegistry();
        built.push({ jobs, tools });
        return { agent: new Agent({ model, tools, env: noopEnv, jobs }), jobs, tools };
      },
      mcpTools: [mcpTool],
      resume,
      persist: (snapshot) => persisted.push(snapshot.id),
    });
    return { sessions, built, persisted };
  }

  test("each session gets its own agent + jobs, with the MCP tools registered", () => {
    const { sessions, built } = factory();
    sessions.createSession();
    sessions.createSession();
    expect(built).toHaveLength(2);
    expect(built[0]?.jobs).not.toBe(built[1]?.jobs);
    for (const b of built) expect(b.tools.get("shell")).toBeDefined();
  });

  test("close (the TUI's /clear) disposes THAT session's jobs once, silently; the next session's survive", () => {
    // Mutations: drop the `dispose` → 0; drop the `release` → the kill surfaces.
    const { sessions, built } = factory();
    const seen: string[] = [];
    sessions.jobs.onExit((job) => seen.push(job.id));
    const first = sessions.createSession();
    first.close?.();
    first.close?.(); // idempotent
    sessions.createSession();
    expect(built[0]?.jobs.disposed).toBe(1);
    expect(built[1]?.jobs.disposed).toBe(0);
    expect(seen).toEqual([]);
    built[1]?.jobs.fire("live");
    expect(seen).toEqual(["live"]);
  });

  test("only the first session resumes; it persists under the resumed uid", async () => {
    const { sessions, persisted } = factory({
      id: "uid-1",
      createdAt: 1,
      updatedAt: 1,
      cwd: "/w",
      model: "m",
      title: "t",
      messages: [{ role: "user", content: "before" }],
    } as never);
    const first = sessions.createSession();
    for await (const _ of first.send("hi")) {
      // drain
    }
    const second = sessions.createSession();
    for await (const _ of second.send("hi")) {
      // drain
    }
    expect(persisted[0]).toBe("uid-1");
    expect(persisted.at(-1)).not.toBe("uid-1");
  });
});
