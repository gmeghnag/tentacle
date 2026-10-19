import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replies with a fixed line each turn, and counts how many turns ran. */
class ReactProvider implements ModelProvider {
  readonly id = "react";
  turns = 0;
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.turns++;
    yield { type: "text", delta: "reacted to the job" };
    yield { type: "done" };
  }
}

/** A JobController whose exits are fired manually. */
class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
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
    return [];
  }
  dispose(): void {}
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(job: BackgroundJob): void {
    for (const listener of this.listeners) {
      listener(job);
    }
  }
}

const exited: BackgroundJob = {
  id: "j1",
  command: "npm run build",
  startedAt: 0,
  status: "exited",
  exitCode: 0,
};

describe("autonomous wake on job-exit", () => {
  test("a job exit while idle starts a continuation turn (default on)", async () => {
    const model = new ReactProvider();
    const jobs = new FakeJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { lastFrame, unmount } = render(
      <App agent={agent} jobs={jobs} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30); // let the jobs subscription attach
    jobs.fire(exited);
    await delay(60); // notice + the continuation turn

    const frame = lastFrame() ?? "";
    expect(frame).toContain("background job j1"); // the exit notice
    expect(frame).toContain("reacted to the job"); // the agent woke and replied
    expect(model.turns).toBe(1);
    unmount();
  });

  test("with auto-wake off, the exit only shows a notice — no turn starts", async () => {
    const model = new ReactProvider();
    const jobs = new FakeJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { lastFrame, unmount } = render(
      <App agent={agent} jobs={jobs} model="qwen3" cwd="/tmp/work" autoWakeOnJobExit={false} />,
    );
    await delay(30);
    jobs.fire(exited);
    await delay(60);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("background job j1"); // notice still shows
    expect(frame).not.toContain("reacted to the job"); // but no autonomous turn
    expect(model.turns).toBe(0);
    unmount();
  });
});
