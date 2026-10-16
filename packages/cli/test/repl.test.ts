import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { runRepl } from "../src/repl.ts";

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

async function* lines(items: readonly string[]): AsyncGenerator<string> {
  for (const item of items) {
    yield item;
  }
}

function agentWith(model: ModelProvider): Agent {
  return new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
}

describe("runRepl", () => {
  test("runs multiple turns with shared history, then exits", async () => {
    const model = new ScriptedProvider([
      [{ type: "text", delta: "first reply" }, { type: "done" }],
      [{ type: "text", delta: "second reply" }, { type: "done" }],
    ]);
    const out: string[] = [];

    await runRepl(agentWith(model), {
      prompts: lines(["hi", "again", "/exit"]),
      write: (t) => out.push(t),
    });

    const text = out.join("");
    expect(text).toContain("first reply");
    expect(text).toContain("second reply");
    expect(text).toContain("👋");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("/help prints help without calling the model", async () => {
    const model = new ScriptedProvider([]);
    const out: string[] = [];

    await runRepl(agentWith(model), {
      prompts: lines(["/help", "/exit"]),
      write: (t) => out.push(t),
    });

    expect(out.join("")).toContain("Commands:");
    expect(model.requests).toHaveLength(0);
  });

  test("blank lines are ignored", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]);
    const out: string[] = [];

    await runRepl(agentWith(model), {
      prompts: lines(["", "   ", "ping", "/exit"]),
      write: (t) => out.push(t),
    });

    expect(model.requests).toHaveLength(1);
    expect(out.join("")).toContain("hi");
  });
});
