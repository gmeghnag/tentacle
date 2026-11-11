import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatRequest, ExecutionEnvironment, ModelProvider } from "@tentacle/core";
import { DsmlToolCallLeakError } from "@tentacle/core";
import type { StreamEvent } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { Session } from "../src/session.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** A provider whose rounds leak a DSML tool call, or answer plainly. */
class Leaking implements ModelProvider {
  readonly id = "leaking";
  readonly seen: ChatMessage[][] = [];
  private round = 0;
  /** `true` for a round that leaks (throws), `false` for a plain answer. */
  constructor(private readonly leaks: readonly boolean[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request.messages.map((m) => ({ ...m })));
    const leaksThisRound = this.leaks[this.round++] ?? false;
    yield { type: "text", delta: "partial" };
    if (leaksThisRound) {
      throw new DsmlToolCallLeakError(42);
    }
    yield { type: "done" };
  }
}

const run = async (model: ModelProvider): Promise<{ type: string }[]> => {
  const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
  const session = new Session(agent);
  const events: { type: string }[] = [];
  for await (const event of session.send("go")) {
    events.push({ type: event.type });
  }
  return events;
};

describe("a DSML-leaked tool call", () => {
  test("is re-asked ONCE, then the turn proceeds", async () => {
    const model = new Leaking([true, false]);
    const events = await run(model);

    // Two rounds: the leak, then the re-ask.
    expect(model.seen).toHaveLength(2);
    // The re-ask reached the model as a user message naming the mistake.
    const last = model.seen[1] ?? [];
    const note = last.at(-1);
    expect(note?.role).toBe("user");
    expect(note?.content).toContain("DSML");

    // The turn ended normally, not as an error.
    expect(events.at(-1)?.type).toBe("turn_end");
  });

  test("is bounded: a SECOND leak fails the turn instead of looping", async () => {
    const model = new Leaking([true, true, false]);
    await expect(run(model)).rejects.toBeInstanceOf(DsmlToolCallLeakError);
    // Exactly two attempts: the turn does not sit in a retry loop.
    expect(model.seen).toHaveLength(2);
  });

  test("never leaves the leaked text in the history", async () => {
    // The second round sees the history the first leak left behind: the re-ask
    // note, and no assistant message carrying the DSML text.
    const model = new Leaking([true, true]);
    await expect(run(model)).rejects.toBeInstanceOf(DsmlToolCallLeakError);
    const second = model.seen[1] ?? [];
    expect(second.some((m) => m.role === "assistant")).toBe(false);
  });
});
