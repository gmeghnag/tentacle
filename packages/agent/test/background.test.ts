import { describe, expect, test } from "bun:test";
import type {
  BackgroundJob,
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** A JobController whose exits the test can fire on demand. */
function controllableJobs(): JobController & { fireExit(job: BackgroundJob): void } {
  const listeners = new Set<(job: BackgroundJob) => void>();
  return {
    fireExit(job) {
      for (const l of listeners) {
        l(job);
      }
    },
    start: () => ({
      id: "bg-1",
      command: "serve",
      startedAt: 0,
      status: "running",
      exitCode: null,
    }),
    read: () => undefined,
    kill: () => false,
    list: () => [],
    dispose: () => {},
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

describe("background-job exit trigger", () => {
  test("surfaces a finished job at the next turn and injects a note", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const jobs = controllableJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });

    // A background job finishes while the agent is idle.
    jobs.fireExit({
      id: "bg-1",
      command: "python3 -m http.server",
      startedAt: 0,
      status: "exited",
      exitCode: 0,
    });

    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const events = [];
    for await (const event of agent.runMessages(messages, "s1")) {
      events.push(event);
    }

    const exit = events.find((e) => e.type === "background_exit");
    expect(exit).toBeDefined();
    expect(exit).toMatchObject({ jobId: "bg-1", status: "exited", exitCode: 0 });

    // A note was injected so the model learns the job ended.
    const note = messages.find((m) => m.role === "user" && m.content.includes("[background]"));
    expect(note?.content).toContain("bg-1");
    expect(note?.content).toContain("shell_output");
  });

  test("does not re-surface the same exit on a later turn", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "a" }, { type: "done" }],
      [{ type: "text", delta: "b" }, { type: "done" }],
    ]);
    const jobs = controllableJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    jobs.fireExit({ id: "bg-1", command: "serve", startedAt: 0, status: "exited", exitCode: 0 });

    const messages: ChatMessage[] = [{ role: "user", content: "one" }];
    for await (const _ of agent.runMessages(messages, "s1")) {
      // drain turn 1
    }
    messages.push({ role: "user", content: "two" });
    const second = [];
    for await (const event of agent.runMessages(messages, "s1")) {
      second.push(event);
    }
    expect(second.some((e) => e.type === "background_exit")).toBe(false);
  });
});
