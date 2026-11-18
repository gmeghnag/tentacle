/**
 * docs/fix/thought-placeholder.md: a round that streamed reasoning keeps ONLY
 * how long it thought (`thought: { ms }`, agent-side monotonic clock) on its
 * assistant message — never the reasoning text — and a round that did not
 * think carries no field at all.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { ThinkingClock } from "../src/thinking-clock.ts";

/** One stream step: advance the fake clock by `after` ms, then yield `event`. */
type Step = { readonly after: number; readonly event: StreamEvent };

class Timed implements ModelProvider {
  readonly id = "timed";
  private turn = 0;
  constructor(
    private readonly c: { t: number },
    private readonly script: readonly (readonly Step[])[],
  ) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    for (const s of this.script[this.turn++] ?? [{ after: 0, event: { type: "done" } }]) {
      this.c.t += s.after;
      yield s.event;
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

async function assistants(script: readonly (readonly Step[])[]): Promise<ChatMessage[]> {
  const c = { t: 1000 };
  const agent = new Agent({
    model: new Timed(c, script),
    tools: new ToolRegistry(),
    env,
    now: () => c.t,
  });
  const messages: ChatMessage[] = [{ role: "user", content: "go" }];
  for await (const _ of agent.runMessages(messages, "s1")) {
    // drain
  }
  return messages.filter((m) => m.role === "assistant");
}

const r = (delta: string, after = 0): Step => ({ after, event: { type: "reasoning", delta } });
const t = (delta: string, after = 0): Step => ({ after, event: { type: "text", delta } });
const done = (after = 0): Step => ({ after, event: { type: "done", stopReason: "stop" } });

describe("thought placeholder on the assistant message", () => {
  test("reasoning → text: ms from the first reasoning delta to the first text, no text kept", async () => {
    const [m] = await assistants([
      [r("let me ", 300), r("think", 4000), r(" hard", 8000), t("hello", 400), done(50)],
    ]);
    expect(m?.thought).toEqual({ ms: 12_400 });
    expect(JSON.stringify(m)).not.toContain("think");
  });

  test("two thinking runs in one round are summed (one row per message)", async () => {
    const [m] = await assistants([[r("a", 0), t("x", 1000), r("b", 0), t("y", 2000), done()]]);
    expect(m?.thought).toEqual({ ms: 3000 });
  });

  test("whitespace-only reasoning is no thought (the phone draws no row for it)", async () => {
    const [m] = await assistants([[r("  \n", 0), t("x", 5000), done()]]);
    expect(m !== undefined && "thought" in m).toBe(false);
  });

  test("a round that never thought carries no field", async () => {
    const [m] = await assistants([[t("hello", 5000), done()]]);
    expect(m !== undefined && "thought" in m).toBe(false);
  });

  test("reasoning to the stream's end (no text) closes at `done`", () => {
    const c = { t: 0 };
    const clock = new ThinkingClock(() => c.t);
    clock.see({ type: "reasoning", delta: "hmm" });
    c.t += 700;
    clock.see({ type: "done" });
    c.t += 5000; // after the stream: not thinking time
    expect(clock.fact()).toEqual({ thought: { ms: 700 } });
  });
});
