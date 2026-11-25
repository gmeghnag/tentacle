/**
 * docs/fix/reasoning-echo.md, T1 (load-bearing, e2e) + the D4 push sites.
 *
 * The real `Agent` + the real `OpenAIProvider` against a `Bun.serve` fake: the
 * reasoning of round N must reach the request of round N+1, in the field it
 * arrived in, byte-identical. Red before s4: the loop dropped `done.reasoning`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  ModelStreamCutError,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { OpenAIProvider } from "../../providers/src/index.ts";
import { compactedHistory, summarizeConversation } from "../src/compact.ts";
import { Agent, type AgentConfig } from "../src/index.ts";

type Chunk = Record<string, unknown>;
type Wire = Record<string, unknown>;

/** Unicode, quotes, newlines: any re-encoding shows up as a byte diff. */
const THOUGHT_1 = 'I should list the dir first.\n  "quoted" — ünïcode ✓\n';
const THOUGHT_2 = "Now read the file.";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const reasoningDelta = (field: string, text: string): Chunk => ({
  choices: [{ delta: { [field]: text } }],
});
const callDelta = (id: string): Chunk => ({
  choices: [
    { delta: { tool_calls: [{ index: 0, id, function: { name: "ls", arguments: "{}" } }] } },
  ],
});
const finish = (reason: string): Chunk => ({ choices: [{ delta: {}, finish_reason: reason }] });
const answer = (text: string): Chunk => ({ choices: [{ delta: { content: text } }] });

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

/** A fake OpenAI-compatible server answering `script[i]` to the i-th chat request. */
function fakeServer(script: readonly (readonly Chunk[])[]): {
  baseURL: string;
  bodies: Array<{ messages: Wire[] }>;
} {
  const bodies: Array<{ messages: Wire[] }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      if (!new URL(req.url).pathname.endsWith("/chat/completions")) {
        return new Response("not found", { status: 404 });
      }
      bodies.push((await req.json()) as { messages: Wire[] });
      const chunks = script[bodies.length - 1] ?? [answer("done"), finish("stop")];
      const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  stop = () => server.stop(true);
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, bodies };
}

async function run(
  baseURL: string,
  history: ChatMessage[],
  config: Partial<AgentConfig> = {},
): Promise<unknown> {
  const agent = new Agent({
    model: new OpenAIProvider({ baseURL, model: "m" }),
    tools: new ToolRegistry(),
    env,
    ...config,
  });
  try {
    for await (const _ of agent.runMessages(history, "s1")) {
      // drain
    }
  } catch (error) {
    return error;
  }
  return undefined;
}

const assistants = (messages: readonly Wire[]): Wire[] =>
  messages.filter((m) => m.role === "assistant");

describe("reasoning echo — the loop carries the provider's record to the next request (T1)", () => {
  for (const field of ["reasoning_content", "reasoning"] as const) {
    test(`\`${field}\` in → \`${field}\` out on request 2, byte-identical`, async () => {
      const { baseURL, bodies } = fakeServer([
        [reasoningDelta(field, THOUGHT_1), callDelta("call_1"), finish("tool_calls")],
      ]);
      expect(await run(baseURL, [{ role: "user", content: "go" }])).toBeUndefined();
      expect(bodies).toHaveLength(2);
      const [assistant] = assistants(bodies[1]?.messages ?? []);
      expect(assistant?.[field]).toBe(THOUGHT_1);
      const other = field === "reasoning" ? "reasoning_content" : "reasoning";
      expect(assistant && other in assistant).toBe(false);
    });
  }

  test("no reasoning in → no reasoning field out", async () => {
    const { baseURL, bodies } = fakeServer([[callDelta("call_1"), finish("tool_calls")]]);
    expect(await run(baseURL, [{ role: "user", content: "go" }])).toBeUndefined();
    const [assistant] = assistants(bodies[1]?.messages ?? []);
    expect(assistant).toBeDefined();
    expect(assistant && ("reasoning_content" in assistant || "reasoning" in assistant)).toBe(false);
  });

  test("current segment (D6 as narrowed by fix/think-tag-leak): request 3 carries BOTH of the turn's rounds' reasoning, each on its own message; history stores the record", async () => {
    const { baseURL, bodies } = fakeServer([
      [reasoningDelta("reasoning_content", THOUGHT_1), callDelta("call_1"), finish("tool_calls")],
      [reasoningDelta("reasoning_content", THOUGHT_2), callDelta("call_2"), finish("tool_calls")],
    ]);
    const history: ChatMessage[] = [{ role: "user", content: "go" }];
    expect(await run(baseURL, history)).toBeUndefined();
    expect(bodies).toHaveLength(3);
    expect(assistants(bodies[2]?.messages ?? []).map((m) => m.reasoning_content)).toEqual([
      THOUGHT_1,
      THOUGHT_2,
    ]);
    // The stored history (what persistence writes) holds the provider's record.
    expect(history.filter((m) => m.role === "assistant").map((m) => m.reasoning)).toEqual([
      {
        source: "openai:m",
        body: { format: "openai", field: "reasoning_content", text: THOUGHT_1 },
      },
      {
        source: "openai:m",
        body: { format: "openai", field: "reasoning_content", text: THOUGHT_2 },
      },
      undefined, // the final answer had no reasoning
    ]);
  });

  test("the forced final report (max_iterations) keeps its record too", async () => {
    const { baseURL, bodies } = fakeServer([
      [reasoningDelta("reasoning_content", THOUGHT_1), callDelta("call_1"), finish("tool_calls")],
      [reasoningDelta("reasoning_content", THOUGHT_2), answer("report"), finish("stop")],
    ]);
    const history: ChatMessage[] = [{ role: "user", content: "go" }];
    await run(baseURL, history, { maxIterations: 1 });
    expect(bodies).toHaveLength(2);
    // The final request itself echoes round 1's reasoning.
    expect(assistants(bodies[1]?.messages ?? [])[0]?.reasoning_content).toBe(THOUGHT_1);
    const last = history.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.content).toBe("report");
    expect(last?.reasoning).toEqual({
      source: "openai:m",
      body: { format: "openai", field: "reasoning_content", text: THOUGHT_2 },
    });
  });

  test("a cut stream (no stop reason) keeps its text but stores NO record", async () => {
    const { baseURL } = fakeServer([
      [reasoningDelta("reasoning_content", THOUGHT_1), answer("partial")],
    ]);
    const history: ChatMessage[] = [{ role: "user", content: "go" }];
    expect(await run(baseURL, history)).toBeInstanceOf(ModelStreamCutError);
    const last = history.at(-1);
    expect(last?.content).toBe("partial");
    expect(last && "reasoning" in last).toBe(false);
  });
});

describe("reasoning and compaction (T7, P5)", () => {
  const SECRET_THOUGHT = "zz-private-chain-of-thought-zz";
  const history: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "listing",
      toolCalls: [{ id: "c1", name: "ls", arguments: "{}" }],
      reasoning: {
        source: "openai:m",
        body: { format: "openai", field: "reasoning_content", text: SECRET_THOUGHT },
      },
    },
    { role: "tool", content: "a.txt", toolCallId: "c1" },
  ];

  test("the compaction transcript carries content + calls, never the reasoning", async () => {
    const requests: ChatRequest[] = [];
    const model: ModelProvider = {
      id: "summarizer",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        requests.push(request);
        yield { type: "text", delta: "summary" };
        yield { type: "done", stopReason: "stop" };
      },
    };
    expect(await summarizeConversation(model, history)).toBe("summary");
    const sent = JSON.stringify(requests);
    expect(sent).toContain("listing");
    expect(sent).not.toContain(SECRET_THOUGHT);
  });

  test("the compacted history holds no reasoning record", () => {
    const next = compactedHistory(history, "summary");
    expect(next.some((m) => m.reasoning !== undefined)).toBe(false);
    expect(JSON.stringify(next)).not.toContain(SECRET_THOUGHT);
  });
});
