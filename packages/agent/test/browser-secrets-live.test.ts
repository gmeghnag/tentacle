import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, ModelProvider, StreamEvent, Tool } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent } from "../src/agent.ts";
import { NO_CAPABILITIES } from "../src/capabilities.ts";

// docs/feat/browser-inspect.md B5b, assumption 2: the browser tools read the
// session's `secrets` switch LIVE, so a flip mid-turn reaches the next call.

const call = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "probe", arguments: "{}" },
});

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const event of this.script[this.turn++] ?? [{ type: "text", delta: "end" }]) yield event;
    yield { type: "done" };
  }
}

describe("ctx.browserSecrets", () => {
  test("a flip to clear during call 1 is seen by call 2 of the SAME turn", async () => {
    // Mutation: build the getter from `this.readCapabilities` captured at turn
    // start (`const read = this.readCapabilities; () => …read()…`) → call 2 sees masked.
    const seen: (string | undefined)[] = [];
    let agent: Agent | undefined;
    const probe: Tool = {
      name: "probe",
      description: "probe",
      inputSchema: z.object({}).passthrough(),
      permission: "none",
      async execute(_input, ctx) {
        seen.push(ctx.browserSecrets?.());
        agent?.setCapabilities({
          ...NO_CAPABILITIES,
          browser: { secrets: "clear", actions: "ask" },
        });
        return { content: "ok" };
      },
    };
    agent = new Agent({
      model: new Scripted([[call("c1")], [call("c2")]]),
      tools: new ToolRegistry().register(probe),
      env: {} as ExecutionEnvironment,
    });
    for await (const _ of agent.runMessages([{ role: "user", content: "go" }], "s1")) {
      // drain
    }
    expect(seen).toEqual(["masked", "clear"]);
  });
});
