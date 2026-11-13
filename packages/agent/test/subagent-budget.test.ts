/**
 * A sub-agent's token budget (docs/feat/subagent-token-budget.md): its spend is
 * bounded by TOKENS, not only by steps, and reaching the cap reuses the step
 * cap's own exit — the forced, tool-free final report — with an honest reason
 * (`max_token_budget`).
 *
 * RED before the implementation: `maxTokens` did not exist, so a child with
 * `maxIterations: 50` and an absurd `usage` ran all 50 rounds and reported
 * `max_iterations` (T1's reason, `toolUses` and nudge assertions).
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
  Usage,
} from "@tentacle/core";
import { CONTEXT_RESET_TOOL_NAME, ToolRegistry, createContextResetTool } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig, type AgentType } from "../src/index.ts";
import { createSubagentRunner } from "../src/subagent.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const noteTool: Tool = {
  name: "note",
  description: "no-op",
  inputSchema: z.object({}),
  permission: "none",
  execute: () => Promise.resolve({ content: "ok" }),
};

const tools = (): ToolRegistry => new ToolRegistry().register(noteTool);
const WORKER: AgentType = { name: "worker", description: "w", prompt: "work", tools: ["note"] };

const toolCall = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "note", arguments: "{}" },
});

/** Every round: one tool call, plus `usage` (so the round is counted and spent). */
function spendingChild(usage: Usage): { model: ModelProvider; requests: ChatRequest[] } {
  const requests: ChatRequest[] = [];
  let round = 0;
  const model: ModelProvider = {
    id: "spending",
    async *stream(request) {
      requests.push(request);
      round += 1;
      yield toolCall(`c${round}`);
      yield { type: "done", usage };
    },
  };
  return { model, requests };
}

describe("T1: the token cap forces the final report", () => {
  test("a child over budget stops as max_token_budget, with a tool-free nudge report", async () => {
    // 1,000 + 1,000 per round against a 4,000 cap: the second round lands
    // EXACTLY on the cap, so a `>=` check stops there while a `>` one would run
    // a third round — the off-by-one this asserts. The step budget (50) is
    // nowhere near spent, so only tokens can stop it.
    const { model, requests } = spendingChild({ promptTokens: 1_000, completionTokens: 1_000 });
    const { run } = createSubagentRunner({
      model,
      env: noopEnv,
      tools: tools(),
      types: [WORKER],
      maxIterations: 50,
      maxTokens: 4_000,
    });
    const result = await run({ type: "worker", description: "d", prompt: "go" }, {});
    expect(result.stopReason).toBe("max_token_budget");
    // Two productive rounds: 2,000 → 4,000 (≥ the cap, so the third is
    // refused — the boundary check overshoots by at most one round). The
    // forced report's own usage (1,000 + 1,000) arrives AFTER the last check,
    // so it is counted in the report line but stops nothing.
    expect(result.toolUses).toBe(2);
    // The final request offers NO tools (it must answer in prose) and carries
    // the TOKEN nudge, not the step one — a child told about a step limit it
    // never reached would be told a falsehood.
    const last = requests.at(-1);
    expect(last?.tools ?? []).toEqual([]);
    const nudge = String(last?.messages.at(-1)?.content);
    expect(nudge).toContain("token budget");
    expect(nudge).not.toContain("step limit");
    // The runner says how much was spent, so the parent can narrow the task.
    expect(result.report).toContain("(token budget reached: 6,000 of 4,000 tokens used)");
  });
});

describe("T2: cumulative across continuation passes (twoWay)", () => {
  test("a message cannot buy a fresh budget: the second pass starts already spent", async () => {
    // TWO passes over ONE conversation array — what a `twoWay` child does when
    // the inbox hands the runner a text in the close window (subagent.ts drives
    // `runMessages` once per pass). The counter is keyed by that ARRAY, so the
    // second pass's header check already sees the first pass's spend and takes
    // the forced report at once. A turn-local counter restarts at 0 and hands
    // the child two more productive rounds.
    let round = 0;
    const requests: ChatRequest[] = [];
    const model: ModelProvider = {
      id: "two-pass",
      async *stream(request) {
        requests.push(request);
        round += 1;
        if (round <= 2) {
          // Both productive rounds belong to pass 1: 1,500 + 500 each.
          yield toolCall(`c${round}`);
          yield { type: "done", usage: { promptTokens: 1_500, completionTokens: 500 } };
          return;
        }
        // A tool call offered during either pass's forced report is IGNORED
        // (no tools were offered); the text is the report.
        yield { type: "text", delta: "REPORT" };
        yield { type: "done" };
      },
    };
    const agent = new Agent({
      model,
      tools: tools(),
      env: noopEnv,
      maxIterations: 50,
      maxTokens: 4_000,
    });
    const messages = agent.startConversation();
    messages.push({ role: "user", content: "go" });
    const runPass = async (): Promise<string | undefined> => {
      let reason: string | undefined;
      for await (const event of agent.runMessages(messages, "s1", undefined)) {
        if (event.type === "turn_end") {
          reason = event.reason;
        }
      }
      return reason;
    };
    // Pass 1: two rounds land EXACTLY on the 4,000 cap, so it ends capped.
    expect(await runPass()).toBe("max_token_budget");
    // Pass 2 (the continuation the inbox would trigger): over budget from its
    // FIRST header check, so it produces no productive round at all — one
    // request, the forced report, no tools offered.
    const before = requests.length;
    expect(await runPass()).toBe("max_token_budget");
    const secondPass = requests.slice(before);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]?.tools ?? []).toEqual([]);
    expect(String(secondPass[0]?.messages.at(-1)?.content)).toContain("token budget");
  });
});

describe("T3: -1 is unlimited", () => {
  test("a finite but large spend runs to a clean end_turn", async () => {
    const { model } = spendingChild({ promptTokens: 1_000, completionTokens: 1_000 });
    const { run } = createSubagentRunner({
      model,
      env: noopEnv,
      tools: tools(),
      types: [WORKER],
      maxIterations: 2,
      maxTokens: -1,
    });
    const result = await run({ type: "worker", description: "d", prompt: "go" }, {});
    // The step cap still applies (2 rounds), and the reason is the step one:
    // an unlimited token budget must never claim a cap nobody set.
    expect(result.stopReason).toBe("max_iterations");
    expect(result.toolUses).toBe(2);
    expect(result.report).not.toContain("token budget");
  });
});

describe("T4: cancel wins over the cap", () => {
  test("an abort during the productive rounds is cancelled, never max_token_budget", async () => {
    const controller = new AbortController();
    let round = 0;
    const model: ModelProvider = {
      id: "cancelling",
      async *stream() {
        round += 1;
        // The abort lands mid-stream on the round that crosses the cap.
        controller.abort();
        yield toolCall(`c${round}`);
        yield { type: "done", usage: { promptTokens: 9_000, completionTokens: 1_000 } };
      },
    };
    const { run } = createSubagentRunner({
      model,
      env: noopEnv,
      tools: tools(),
      types: [WORKER],
      maxIterations: 50,
      maxTokens: 5_000,
    });
    const result = await run(
      { type: "worker", description: "d", prompt: "go" },
      { signal: controller.signal },
    );
    // Over budget AND cancelled: the person's stop is the honest reason.
    expect(result.stopReason).toBe("cancelled");
  });
});

describe("T5: context_reset does not refund the token counter (Agent level)", () => {
  test("rounds restart, tokens do not", async () => {
    // At `Agent` level the two budgets must stay distinct: `budgetFrom` is
    // restarted by a context reset, the token count never is (a reset
    // un-spends nothing). The child never gets the reset tool, so this is
    // pinned here to keep the semantics apart for a future parent budget.
    const seen: ChatRequest[] = [];
    let round = 0;
    const model: ModelProvider = {
      id: "resetter",
      async *stream(request) {
        seen.push(request);
        round += 1;
        if (round === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "r1",
              name: CONTEXT_RESET_TOOL_NAME,
              arguments: JSON.stringify({ prompt: "next: step 2" }),
            },
          };
          yield { type: "done", usage: { promptTokens: 4_000, completionTokens: 0 } };
          return;
        }
        yield toolCall(`c${round}`);
        yield { type: "done", usage: { promptTokens: 3_000, completionTokens: 0 } };
      },
    };
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(noteTool).register(createContextResetTool()),
      env: noopEnv,
      maxIterations: 1,
      maxTokens: 5_000,
      requestPermission: () => Promise.resolve({ allowed: true }),
      contextReset: {
        maxPerMessage: 5,
        refresh: () => Promise.resolve({ systemPrompt: "FRESH SYSTEM", skills: {} }),
      },
    } as AgentConfig);
    const events: { type: string; reason?: string }[] = [];
    for await (const event of agent.run("s1", [{ role: "user", content: "go" }], undefined)) {
      events.push(event);
    }
    // The reset restarted the ROUND budget, so round 2 ran; it did NOT refund
    // the 4,000 already spent, and round 2's 3,000 crosses the 5,000 cap — so
    // the reason is the TOKEN one, not the step one.
    expect(seen).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_token_budget" });
  });
});
