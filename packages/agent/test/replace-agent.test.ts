import { describe, expect, test } from "bun:test";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { Session } from "../src/session.ts";

// docs/feat/session-settings-apply.md: the agent swap between turns.

class RecordingProvider implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

function controllableJobs(): JobController & {
  fireExit(job: BackgroundJob): void;
  listeners(): number;
} {
  const listeners = new Set<(job: BackgroundJob) => void>();
  return {
    fireExit(job) {
      for (const l of [...listeners]) {
        l(job);
      }
    },
    listeners: () => listeners.size,
    start: () => ({ id: "bg-1", command: "x", startedAt: 0, status: "running", exitCode: null }),
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

const job = (id: string): BackgroundJob => ({
  id,
  command: `cmd-${id}`,
  startedAt: 0,
  status: "exited",
  exitCode: 0,
});

function agent(model: ModelProvider, systemPrompt?: string, jobs?: JobController): Agent {
  return new Agent({
    model,
    tools: new ToolRegistry(),
    env: noopEnv,
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    ...(jobs ? { jobs } : {}),
  });
}

async function drain(session: Session, text: string): Promise<void> {
  for await (const _ of session.send(text)) {
    // consume
  }
}

describe("Session.replaceAgent", () => {
  test("the next turn runs on the new agent; the conversation is kept", async () => {
    const before = new RecordingProvider();
    const after = new RecordingProvider();
    const session = new Session(agent(before, "old prompt"), "s1");
    await drain(session, "one");
    session.replaceAgent(agent(after, "old prompt"));
    await drain(session, "two");
    expect(before.requests).toHaveLength(1);
    expect(after.requests).toHaveLength(1);
    const contents = after.requests[0]?.messages.map((m) => m.content);
    expect(contents).toContain("one");
    expect(contents).toContain("two");
  });

  test("a system head is replaced in place by the new prompt (same length)", () => {
    const session = new Session(agent(new RecordingProvider(), "old prompt"), "s1", {
      messages: [
        { role: "system", content: "old prompt" },
        { role: "user", content: "hi" },
      ],
    });
    const history = session.messages;
    session.replaceAgent(agent(new RecordingProvider(), "new prompt"));
    expect(session.messages).toBe(history);
    expect(session.messages).toEqual([
      { role: "system", content: "new prompt" },
      { role: "user", content: "hi" },
    ]);
  });

  test("a history with no system head is left alone", () => {
    const seed = [
      { role: "user" as const, content: "summary" },
      { role: "assistant" as const, content: "ok" },
    ];
    const session = new Session(agent(new RecordingProvider(), "old"), "s1", { messages: seed });
    session.replaceAgent(agent(new RecordingProvider(), "new prompt"));
    expect(session.messages).toEqual(seed);
  });

  test("a new agent without a prompt leaves the head as it is", () => {
    const session = new Session(agent(new RecordingProvider(), "old prompt"), "s1");
    session.replaceAgent(agent(new RecordingProvider()));
    expect(session.messages).toEqual([{ role: "system", content: "old prompt" }]);
  });
});

describe("Agent.retire / adoptExits", () => {
  test("an exit seen while idle reaches the model once, on the new agent", async () => {
    const jobs = controllableJobs();
    const oldModel = new RecordingProvider();
    const newModel = new RecordingProvider();
    const old = agent(oldModel, "p", jobs);
    const session = new Session(old, "s1");
    jobs.fireExit(job("bg-1"));
    const next = agent(newModel, "p", jobs);
    next.adoptExits(old.retire());
    session.replaceAgent(next);
    await drain(session, "go");
    const notes = (newModel.requests[0]?.messages ?? []).filter(
      (m) => typeof m.content === "string" && m.content.includes("bg-1"),
    );
    expect(notes).toHaveLength(1);
    // The old agent left the jobs: a later exit is collected once, by the new one.
    expect(jobs.listeners()).toBe(1);
    jobs.fireExit(job("bg-2"));
    await drain(session, "again");
    const later = (newModel.requests[1]?.messages ?? []).filter(
      (m) => typeof m.content === "string" && m.content.includes("bg-2"),
    );
    expect(later).toHaveLength(1);
    expect(oldModel.requests).toHaveLength(0);
  });

  test("retire twice is harmless and returns nothing the second time", () => {
    const jobs = controllableJobs();
    const old = agent(new RecordingProvider(), "p", jobs);
    jobs.fireExit(job("bg-1"));
    expect(old.retire().map((j) => ("id" in j ? j.id : j.agentId))).toEqual(["bg-1"]);
    expect(old.retire()).toEqual([]);
    expect(jobs.listeners()).toBe(0);
  });
});
