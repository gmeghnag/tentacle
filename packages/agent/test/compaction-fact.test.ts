/**
 * docs/feat/harness-notices.md S1: `Session.compact` measures the context
 * before (the old history, or the caller's figure) and after (the new one),
 * and stamps both on the summary message — the persisted, replayed fact.
 */
import { describe, expect, test } from "bun:test";
import {
  COMPACTION_SUMMARY_HEAD,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { Session } from "../src/session.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const isCompacted = (r: ChatRequest) =>
  r.messages.some((m) => m.content.startsWith(COMPACTION_SUMMARY_HEAD));

/** Summarizes with "a brief"; counts 9000 for a compacted history, 182000 for any other. */
function provider(
  opts: { count?: boolean; onCount?: (r: ChatRequest) => void } = {},
): ModelProvider & {
  counted: ChatRequest[];
} {
  const counted: ChatRequest[] = [];
  return {
    id: "fake",
    counted,
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text", delta: "a brief" };
      yield { type: "done" };
    },
    ...(opts.count === false
      ? {}
      : {
          countTokens: (r: ChatRequest) => {
            counted.push(r);
            opts.onCount?.(r);
            return Promise.resolve(isCompacted(r) ? 9000 : 182000);
          },
        }),
  };
}

function session(model: ModelProvider): Session {
  const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, systemPrompt: "SYS" });
  const s = new Session(agent, "fact");
  s.messages.push({ role: "user", content: "do x" });
  s.messages.push({ role: "assistant", content: "did x" });
  return s;
}

describe("Session.compact stamps the compaction fact", () => {
  test("from = the old (replaced) history's count, to = the new history's, exact", async () => {
    const model = provider();
    const s = session(model);
    const result = await s.compact();
    expect(s.messages[1]?.compacted).toEqual({ fromTokens: 182000, toTokens: 9000, toExact: true });
    expect(result).toMatchObject({ fromTokens: 182000, toTokens: 9000, toExact: true });
    // Only the summary carries it.
    expect(s.messages.filter((m) => m.compacted)).toHaveLength(1);
    // from measured on the OLD history (no summary in it), to on the new one.
    expect(model.counted.map(isCompacted)).toEqual([false, true]);
  });

  test("the caller's fromTokens wins and the old history is not counted", async () => {
    const model = provider();
    const s = session(model);
    const result = await s.compact(undefined, undefined, { fromTokens: 50000 });
    expect(s.messages[1]?.compacted).toEqual({ fromTokens: 50000, toTokens: 9000, toExact: true });
    expect(result.fromTokens).toBe(50000);
    expect(model.counted.map(isCompacted)).toEqual([true]);
  });

  test("a provider that cannot count → estimates, toExact absent", async () => {
    const s = session(provider({ count: false }));
    await s.compact();
    const fact = s.messages[1]?.compacted;
    expect(fact?.toExact).toBeUndefined();
    expect(fact?.fromTokens).toBeGreaterThan(0);
    expect(fact?.toTokens).toBeGreaterThan(0);
  });

  test("an abort during the after-count → rejects, history untouched", async () => {
    const controller = new AbortController();
    const model = provider({
      onCount: (r) => {
        if (isCompacted(r)) {
          controller.abort();
        }
      },
    });
    const s = session(model);
    const before = s.messages.map((m) => ({ ...m }));
    await expect(s.compact(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(s.messages).toEqual(before);
  });
});
