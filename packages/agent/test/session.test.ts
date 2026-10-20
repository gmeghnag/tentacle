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
import { Agent, type AgentEvent, Session } from "../src/index.ts";

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

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;

  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

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

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _ of gen) {
    // consume
  }
}

describe("Session", () => {
  test("keeps conversation history across turns", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "Hi there" }, { type: "done" }],
      [{ type: "text", delta: "You said hello earlier" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent);

    await drain(session.send("hello"));
    await drain(session.send("do you remember?"));

    const secondRequest = model.requests[1];
    expect(secondRequest?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(secondRequest?.messages[0]).toEqual({ role: "user", content: "hello" });
    expect(secondRequest?.messages[1]).toMatchObject({ role: "assistant", content: "Hi there" });
    expect(secondRequest?.messages[2]).toEqual({ role: "user", content: "do you remember?" });
    expect(session.messages).toHaveLength(4);
  });

  test('send("") is a continuation: no empty user message, reacts to a pending job exit', async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "reacting" }, { type: "done" }]]);
    const jobs = new FakeJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const session = new Session(agent);

    // A background job exits while idle (queued in the agent's pending exits).
    jobs.fire({ id: "j9", command: "build", startedAt: 0, status: "exited", exitCode: 0 });
    // The autonomous-wake continuation turn: an empty prompt.
    await drain(session.send(""));

    const req = model.requests[0];
    // No empty user message was appended anywhere.
    expect(req?.messages.some((m) => m.role === "user" && m.content === "")).toBe(false);
    expect(session.messages.some((m) => m.role === "user" && m.content === "")).toBe(false);
    // The injected background-exit note is the latest message the model saw.
    const last = req?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(String(last?.content)).toContain("[background] job j9");
  });

  test("seeds the system prompt when configured", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "be nice",
    });
    const session = new Session(agent);

    await drain(session.send("hi"));

    expect(model.requests[0]?.messages[0]).toEqual({ role: "system", content: "be nice" });
  });

  test("resumes seeded history instead of a fresh conversation", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "again" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const session = new Session(agent, "sess-1", {
      messages: [
        { role: "user", content: "earlier question" },
        { role: "assistant", content: "earlier answer" },
      ],
    });
    expect(session.id).toBe("sess-1");

    await drain(session.send("follow up"));

    // The model saw the resumed history before the new turn.
    expect(model.requests[0]?.messages.map((m) => m.content)).toEqual([
      "earlier question",
      "earlier answer",
      "follow up",
    ]);
  });

  test("persists a snapshot after each turn and after compaction", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "one" }, { type: "done" }],
      [{ type: "text", delta: "two" }, { type: "done" }],
    ]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const snapshots: number[] = [];
    const session = new Session(agent, undefined, {
      onPersist: (snap) => {
        expect(snap.id).toBe(session.id);
        snapshots.push(snap.messages.length);
      },
    });

    await drain(session.send("first"));
    await drain(session.send("second"));

    // One persist per turn, each with the full history at that point.
    expect(snapshots).toEqual([2, 4]);
  });
});

describe("Session.pendingSteering", () => {
  test("the queued messages, in order, as a copy (a persister must not alias the live queue)", () => {
    // Mutation: return the live array → the caller's mutation empties the queue.
    const model: ModelProvider = {
      id: "m",
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "done" };
      },
    };
    const env = {} as ExecutionEnvironment;
    const session = new Session(new Agent({ model, tools: new ToolRegistry(), env }));
    session.enqueue("a");
    session.enqueue("b");
    const copy = session.pendingSteering() as string[];
    expect(copy).toEqual(["a", "b"]);
    copy.length = 0;
    expect(session.pendingSteering()).toEqual(["a", "b"]);
  });
});
