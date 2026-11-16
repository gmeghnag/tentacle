/**
 * Flow 27's mock-model scenarios (docs/feat/mobile-chrome.md S9), driven through
 * the REAL `OpenAIProvider` stream (so the two parallel `agent_task` calls are
 * reassembled exactly as the daemon will see them): `AGENTS27` launches two
 * background children, a child takes its steps one per round and then reports,
 * the person's message to a child (a later user message) does not derail it, the
 * child's report does not look like a child to the parent, and `SHELLJOB27`
 * starts a background shell job.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { ChatMessage, StreamEvent, ToolCall } from "@tentacle/core";
// Not a dependency of the app (it never talks to a model): the e2e harness's
// own concern, imported by path like the harness's other workspace reach-ins.
import { OpenAIProvider } from "../../../packages/providers/src/index.ts";
import {
  AGENTS_PROMPT,
  CHILD_MARK,
  LONG_CHILD_STEPS,
  SHELLJOB_PROMPT,
  SHORT_CHILD_STEPS,
  childSteps,
  startMockModel,
} from "../e2e/mock-model.ts";

const mock = startMockModel({ childStepMs: 1 });
afterAll(() => mock.stop());
const provider = new OpenAIProvider({ baseURL: mock.baseUrl, model: "mock" });

async function round(
  messages: ChatMessage[],
): Promise<{ text: string; calls: ToolCall[]; stop?: string }> {
  let text = "";
  const calls: ToolCall[] = [];
  let stop: string | undefined;
  for await (const event of provider.stream({ messages }) as AsyncIterable<StreamEvent>) {
    if (event.type === "text") {
      text += event.delta;
    } else if (event.type === "tool_call") {
      calls.push(event.toolCall);
    } else if (event.type === "done") {
      stop = event.stopReason;
    }
  }
  return { text, calls, ...(stop === undefined ? {} : { stop }) };
}

/** A reassembled call's arguments, parsed (the provider hands the raw JSON). */
function input(call: ToolCall): unknown {
  return JSON.parse(call.arguments);
}

/** A child's history after `n` steps: its prompt, then n call/result pairs. */
function childHistory(steps: number, n: number, extra: ChatMessage[] = []): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "user", content: `${CHILD_MARK} ${steps}` }];
  for (let i = 1; i <= n; i += 1) {
    out.push({
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: `c${i}`,
          name: "fs_read",
          arguments: JSON.stringify({ path: `project/step-${i}.txt` }),
        },
      ],
    } as ChatMessage);
    out.push({ role: "tool", content: "missing", toolCallId: `c${i}` } as ChatMessage);
  }
  return [...out, ...extra];
}

describe("flow 27's mock model", () => {
  test("AGENTS27 → two BACKGROUND agent_task calls (long + short) in one round", async () => {
    const r = await round([{ role: "user", content: `${AGENTS_PROMPT}\n[context: 1%]` }]);
    expect(r.calls.map((c) => c.name)).toEqual(["agent_task", "agent_task"]);
    expect(r.calls.map(input)).toEqual([
      { description: "long child", prompt: `${CHILD_MARK} ${LONG_CHILD_STEPS}`, background: true },
      {
        description: "short child",
        prompt: `${CHILD_MARK} ${SHORT_CHILD_STEPS}`,
        background: true,
      },
    ]);
    expect(new Set(r.calls.map((c) => c.id)).size).toBe(2);
  });

  test("a child takes one fs_read step per round, then reports", async () => {
    const first = await round(childHistory(SHORT_CHILD_STEPS, 0));
    expect(first.calls.map((c) => [c.name, input(c)])).toEqual([
      ["fs_read", { path: "project/step-1.txt" }],
    ]);
    const last = await round(childHistory(SHORT_CHILD_STEPS, SHORT_CHILD_STEPS));
    expect(last.calls).toEqual([]);
    expect(last.text).toBe(`Child report: ${SHORT_CHILD_STEPS} steps done.`);
  });

  test("the person's message (a later user message) does not derail the child", async () => {
    const r = await round(
      childHistory(LONG_CHILD_STEPS, 2, [{ role: "user", content: "salta i test" }]),
    );
    expect(r.calls.map(input)).toEqual([{ path: "project/step-3.txt" }]);
    expect(mock.prompts.at(-1)).toContain("salta i test");
  });

  test("the child's report, back at the parent, is NOT taken for a child", () => {
    const parent = {
      messages: [
        { role: "user", content: AGENTS_PROMPT },
        {
          role: "user",
          content: `[background] sub-agent sa-2 (short child) finished:\nChild report: ${SHORT_CHILD_STEPS} steps done.`,
        },
      ],
    };
    expect(childSteps(parent)).toBeNull();
  });

  test("SHELLJOB27 → a background `sleep 30` shell call", async () => {
    const r = await round([{ role: "user", content: SHELLJOB_PROMPT }]);
    expect(r.calls.map((c) => [c.name, input(c)])).toEqual([
      ["shell", { command: "sleep 30", run_in_background: true }],
    ]);
  });
});
