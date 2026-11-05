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
    const err: string[] = [];

    await runRepl(agentWith(model), {
      prompts: lines(["hi", "again", "/exit"]),
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });

    // docs/fix/cli-output-streams.md D5: stdout is the answers alone; the
    // banner and the goodbye are stderr's.
    expect(out.join("")).toBe("first reply\nsecond reply\n");
    expect(err.join("")).toContain("tentacle — interactive session");
    expect(err.join("")).toContain("👋");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });

  test("/help prints help without calling the model", async () => {
    const model = new ScriptedProvider([]);
    const out: string[] = [];
    const err: string[] = [];

    await runRepl(agentWith(model), {
      prompts: lines(["/help", "/exit"]),
      out: (t) => out.push(t),
      err: (t) => err.push(t),
    });

    expect(err.join("")).toContain("Commands:");
    expect(out).toEqual([]);
    expect(model.requests).toHaveLength(0);
  });

  test("blank lines are ignored", async () => {
    const model = new ScriptedProvider([[{ type: "text", delta: "hi" }, { type: "done" }]]);
    const out: string[] = [];

    await runRepl(agentWith(model), {
      prompts: lines(["", "   ", "ping", "/exit"]),
      out: (t) => out.push(t),
      err: () => {},
    });

    expect(model.requests).toHaveLength(1);
    expect(out.join("")).toContain("hi");
  });
});

describe("runRepl error placement", () => {
  class Failing implements ModelProvider {
    readonly id = "failing";
    constructor(private readonly partial: string) {}
    async *stream(): AsyncIterable<StreamEvent> {
      if (this.partial !== "") {
        yield { type: "text", delta: this.partial };
      }
      throw new Error("ECONNRESET");
    }
  }
  /** Both streams interleaved as on one terminal, and each apart. */
  const errorOut = async (partial: string) => {
    const screen: string[] = [];
    const out: string[] = [];
    const err: string[] = [];
    await runRepl(agentWith(new Failing(partial)), {
      shared: true, // the screen below is one terminal
      prompts: lines(["hi", "/exit"]),
      out: (t) => {
        screen.push(t);
        out.push(t);
      },
      err: (t) => {
        screen.push(t);
        err.push(t);
      },
    });
    return { screen: screen.join(""), out: out.join(""), err: err.join("") };
  };

  test("an error after streamed text starts on its own line (never glued)", async () => {
    // Mutation: no lead newline -> glued to the text.
    const r = await errorOut("Hello wor");
    expect(r.screen).toContain("Hello wor\n[error] ");
    // The partial answer is stdout's; the error is stderr's.
    expect(r.out).toBe("Hello wor");
    expect(r.err).toContain("[error] ");
  });

  test("an error with nothing written yet adds no blank line", async () => {
    // Mutation: always a lead newline -> a blank line before the error.
    const r = await errorOut("");
    expect(r.screen).toContain("to quit.\n[error] ");
    expect(r.out).toBe("");
  });
});
