import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ChatMessage, ChatRequest, StreamEvent, ToolDefinition } from "@tentacle/core";
import {
  ANTHROPIC_DEFAULT_MAX_TOKENS,
  ANTHROPIC_DEFAULT_VERSION,
  AnthropicProvider,
  ModelRequestError,
  anthropicErrorHint,
  buildPayload,
} from "../src/index.ts";

// A scripted Anthropic Messages SSE transcript: usage, a text block, a tool_use
// block whose input JSON streams across two deltas, then the final usage —
// exercising every normalisation path.
const EVENTS: unknown[] = [
  {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [],
      model: "test-model",
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_1", name: "get_weather" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"ci' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: 'ty":"Rome"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 5 },
  },
  { type: "message_stop" },
];

const REASONING_EVENTS: unknown[] = [
  { type: "message_start", message: { usage: { input_tokens: 3 } } },
  { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
  { type: "message_stop" },
];

const ERROR_EVENTS: unknown[] = [
  { type: "message_start", message: { usage: { input_tokens: 3 } } },
  { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
];

// A stream that cuts off MID tool_use block: no `content_block_stop`, no
// `message_delta`, no `message_stop` — as an overloaded/under-served gateway
// can produce. The partial call must surface as an error, never be run.
const TRUNCATED_EVENTS: unknown[] = [
  { type: "message_start", message: { usage: { input_tokens: 4 } } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_t", name: "t" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"a":1' },
  },
];

// The output cap (`max_tokens`) cuts a tool_use input mid-JSON: the API still
// closes the block and the message, but `stop_reason` says the call is partial.
const MAX_TOKENS_EVENTS: unknown[] = [
  { type: "message_start", message: { usage: { input_tokens: 4 } } },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_m", name: "fs_write" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":"big.ts","content":"line1' },
  },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 9 } },
  { type: "message_stop" },
];

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const payload = (await req.json()) as { model: string };
      if (payload.model === "err") {
        return Response.json(
          { type: "error", error: { type: "invalid_request_error", message: "boom" } },
          { status: 400 },
        );
      }
      const events =
        payload.model === "reason"
          ? REASONING_EVENTS
          : payload.model === "stream-error"
            ? ERROR_EVENTS
            : payload.model === "truncated"
              ? TRUNCATED_EVENTS
              : payload.model === "max-tokens"
                ? MAX_TOKENS_EVENTS
                : EVENTS;
      const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

async function collect(
  model: string,
  request: { messages: readonly ChatMessage[] } = { messages: [{ role: "user", content: "hi" }] },
): Promise<StreamEvent[]> {
  const provider = new AnthropicProvider({ baseURL, model, apiKey: "test-key" });
  const out: StreamEvent[] = [];
  for await (const event of provider.stream(request)) {
    out.push(event);
  }
  return out;
}

describe("buildPayload (ChatRequest → Messages wire)", () => {
  // Fixture index access: these payloads have a known shape, so a missing index
  // means the fixture itself regressed — fail loudly rather than assert on undefined.
  const at = <T>(arr: readonly T[], i: number): T => {
    const v = arr[i];
    if (v === undefined) {
      throw new Error(`payload index ${i} missing`);
    }
    return v;
  };

  const tools: ToolDefinition[] = [
    {
      name: "get_weather",
      description: "Get the weather",
      parameters: { type: "object", properties: { city: { type: "string" } } },
    },
  ];

  test("maps the leading system message to the top-level system field", () => {
    const payload = buildPayload("m", {
      messages: [
        { role: "system", content: "You are tentacle." },
        { role: "user", content: "hi" },
      ],
    }) as { system: string; messages: Record<string, unknown>[] };
    expect(payload.system).toBe("You are tentacle.");
    expect(payload.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  test("omits system when no system message is present", () => {
    const payload = buildPayload("m", { messages: [{ role: "user", content: "hi" }] });
    expect("system" in payload).toBe(false);
  });

  test("maps an assistant tool call to a tool_use content block", () => {
    const payload = buildPayload("m", {
      messages: [
        { role: "user", content: "weather in Rome?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Rome"}' }],
        },
      ],
    }) as { messages: Record<string, unknown>[] };
    const assistant = at(payload.messages, 1);
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Rome" } },
    ]);
  });

  test("collapses consecutive tool results into ONE user tool_result message", () => {
    const payload = buildPayload("m", {
      messages: [
        { role: "user", content: "two things" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "toolu_a", name: "t", arguments: "{}" },
            { id: "toolu_b", name: "t", arguments: "{}" },
          ],
        },
        { role: "tool", content: "result A", toolCallId: "toolu_a" },
        { role: "tool", content: "result B", toolCallId: "toolu_b" },
        { role: "user", content: "and now?" },
      ],
    }) as { messages: Record<string, unknown>[] };
    const toolMsg = at(payload.messages, 2);
    expect(toolMsg.role).toBe("user");
    expect(toolMsg.content).toEqual([
      { type: "tool_result", tool_use_id: "toolu_a", content: "result A" },
      { type: "tool_result", tool_use_id: "toolu_b", content: "result B" },
    ]);
    // The following user turn stays a separate (string) message.
    expect(at(payload.messages, 3)).toEqual({ role: "user", content: "and now?" });
  });

  test("a compacted history (summary, then one `skill` round per kept skill) is a valid alternation", () => {
    // The shape `compactedHistory` builds (docs/feat/skills-compaction.md),
    // followed by the next user prompt.
    const round = (id: string, name: string): ChatMessage[] => [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id, name: "skill", arguments: JSON.stringify({ name }) }],
      },
      { role: "tool", content: `<skill_content name="${name}">\nbody`, toolCallId: id },
    ];
    const payload = buildPayload("m", {
      messages: [
        { role: "system", content: "SYS" },
        { role: "user", content: "Summary of the earlier conversation …" },
        ...round("toolu_a", "a"),
        ...round("toolu_b", "b"),
        { role: "user", content: "go on" },
      ],
    }) as { system: string; messages: { role: string; content: unknown }[] };
    expect(payload.system).toBe("SYS");
    // user / assistant / user … — the last user turn is tool_result + the prompt,
    // which the API merges (consecutive same-role turns).
    expect(payload.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
      "user",
    ]);
    const used = payload.messages.flatMap((m) =>
      Array.isArray(m.content)
        ? (m.content as { type: string; id?: string; tool_use_id?: string }[])
        : [],
    );
    const ids = (type: string, key: "id" | "tool_use_id"): unknown[] =>
      used.filter((b) => b.type === type).map((b) => b[key]);
    expect(ids("tool_use", "id")).toEqual(["toolu_a", "toolu_b"]);
    expect(ids("tool_result", "tool_use_id")).toEqual(["toolu_a", "toolu_b"]);
  });

  test("maps tools to input_schema and always sends max_tokens", () => {
    const payload = buildPayload("m", {
      messages: [{ role: "user", content: "hi" }],
      tools,
      temperature: 0.2,
    }) as { tools: Record<string, unknown>[]; max_tokens: number; temperature: number };
    expect(payload.tools).toEqual([
      {
        name: "get_weather",
        description: "Get the weather",
        input_schema: at(tools, 0).parameters,
      },
    ]);
    // Streaming request: room for a large tool input (a whole-file write), not
    // a 4096 cap that truncates any write above ~12 KB.
    expect(payload.max_tokens).toBe(64000);
    expect(payload.temperature).toBe(0.2);
  });

  test("drops an empty-text assistant turn with no tool calls", () => {
    // The agent loop can persist `{role:"assistant", content:""}` (a stalled
    // round past the nudge budget); the Messages API rejects empty content.
    const payload = buildPayload("m", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "" },
        { role: "user", content: "again" },
      ],
    }) as { messages: Record<string, unknown>[] };
    expect(payload.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "again" },
    ]);
  });

  test("honours an explicit maxTokens over the default", () => {
    const payload = buildPayload("m", {
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 999,
    }) as { max_tokens: number };
    expect(payload.max_tokens).toBe(999);
  });

  test("degrades a broken tool-call argument body to an empty input", () => {
    const payload = buildPayload("m", {
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "t", arguments: "{?" }] },
      ],
    }) as { messages: Record<string, unknown>[] };
    const content = at(payload.messages, 0).content as Record<string, unknown>[] as unknown as {
      input: unknown;
    }[];
    expect(at(content, 0).input).toEqual({});
  });

  test("round-trips a full tool turn: wire tool_use → stream → tool_result wire", () => {
    // 1. The harness history after a tool round: system, user, assistant+call, tool result.
    const history: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Rome"}' }],
      },
      { role: "tool", content: "sunny", toolCallId: "toolu_1" },
    ];
    const request: ChatRequest = { messages: history };
    const payload = buildPayload("m", request) as {
      system: string;
      messages: Record<string, unknown>[];
    };
    // The assistant turn must carry a tool_use block whose input is the parsed
    // arguments (what the agent loop's JSON.parse produced).
    const assistant = at(payload.messages, 1);
    const blocks = assistant.content as Record<string, unknown>[];
    expect(blocks).toEqual([
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Rome" } },
    ]);
    // The tool result must come back as a user tool_result referencing the same
    // id — the pair the Messages API requires for a tool round.
    const toolMsg = at(payload.messages, 2) as { content: Record<string, unknown>[] };
    expect(at(toolMsg.content, 0)).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: "sunny",
    });
    // And the streamed tool_call (id/name/arguments) from the provider is exactly
    // what re-encodes to the tool_use above: same id, name, JSON input.
    const reencoded = buildPayload("m", {
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "toolu_1", name: "get_weather", arguments: '{"city":"Rome"}' }],
        },
      ],
    }) as { messages: Record<string, unknown>[] };
    expect(at(reencoded.messages, 0).content).toEqual(blocks);
  });
});

describe("AnthropicProvider.stream", () => {
  test("streams text, an assembled tool_use, and merged usage", async () => {
    const events = await collect("test-model");

    const text = events
      .filter((e): e is Extract<StreamEvent, { type: "text" }> => e.type === "text")
      .map((e) => e.delta)
      .join("");
    expect(text).toBe("Hello world");

    // Exactly ONE tool_call, with the full JSON accumulated across deltas.
    const toolCalls = events.filter(
      (e): e is Extract<StreamEvent, { type: "tool_call" }> => e.type === "tool_call",
    );
    expect(toolCalls).toEqual([
      {
        type: "tool_call",
        toolCall: { id: "toolu_1", name: "get_weather", arguments: '{"city":"Rome"}' },
      },
    ]);

    const done = events.at(-1);
    expect(done).toEqual({ type: "done", usage: { promptTokens: 10, completionTokens: 5 } });
  });

  test("maps thinking deltas to reasoning events", async () => {
    const events = await collect("reason");
    const reasoning = events.find((e) => e.type === "reasoning");
    expect(reasoning).toEqual({ type: "reasoning", delta: "hmm" });
    const done = events.at(-1);
    expect(done).toEqual({ type: "done", usage: { promptTokens: 3, completionTokens: 2 } });
  });

  test("throws ModelRequestError on a non-2xx response", async () => {
    const run = async () => {
      for await (const _ of new AnthropicProvider({ baseURL, model: "err" }).stream({
        messages: [{ role: "user", content: "x" }],
      })) {
        // drain
      }
    };
    await expect(run()).rejects.toBeInstanceOf(ModelRequestError);
  });

  test("throws when the stream ends inside a tool_use block (never runs a partial call)", async () => {
    // No `content_block_stop` / `message_stop`: the call's JSON is truncated.
    // Synthesising a tool_call from it would persist an invalid call into the
    // history (docs/eval/sse-abort-truncated-toolcall.md) — fail loud instead.
    const events: StreamEvent[] = [];
    const run = async () => {
      for await (const event of new AnthropicProvider({ baseURL, model: "truncated" }).stream({
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(event);
      }
    };
    await expect(run()).rejects.toThrow("stream ended inside a tool_use block");
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
  });

  test("throws on stop_reason max_tokens with a tool_use (the truncated call is not emitted)", async () => {
    const events: StreamEvent[] = [];
    const run = async () => {
      for await (const event of new AnthropicProvider({ baseURL, model: "max-tokens" }).stream({
        messages: [{ role: "user", content: "x" }],
      })) {
        events.push(event);
      }
    };
    await expect(run()).rejects.toThrow("max_tokens");
    expect(events.filter((e) => e.type === "tool_call")).toEqual([]);
  });

  test("throws on an in-band error event (not swallowed)", async () => {
    const run = async () => {
      for await (const _ of new AnthropicProvider({ baseURL, model: "stream-error" }).stream({
        messages: [{ role: "user", content: "x" }],
      })) {
        // drain
      }
    };
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(ModelRequestError);
    expect((err as Error).message).toContain("Overloaded");
  });

  test("sends the x-api-key and anthropic-version headers and a valid body", async () => {
    let seenHeaders: Record<string, string> = {};
    let seenBody: Record<string, unknown> = {};
    const provider = new AnthropicProvider({
      baseURL: "http://unused.local/v1",
      model: "m",
      apiKey: "sk-test",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        seenHeaders = (init?.headers ?? {}) as Record<string, string>;
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const sse = [
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ]
          .map((e) => `data: ${JSON.stringify(e)}\n\n`)
          .join("");
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }) as typeof fetch,
    });
    for await (const _ of provider.stream({
      messages: [{ role: "user", content: "hi" }],
    })) {
      // drain
    }
    expect(seenHeaders["x-api-key"]).toBe("sk-test");
    expect(seenHeaders["anthropic-version"]).toBe(ANTHROPIC_DEFAULT_VERSION);
    // max_tokens is required by the API and always present in the body.
    expect(seenBody.max_tokens).toBe(ANTHROPIC_DEFAULT_MAX_TOKENS);
    expect(seenBody.stream).toBe(true);
  });

  test("passes the abort signal to fetch; an aborted body ends the stream", async () => {
    const controller = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const encoder = new TextEncoder();
    // A body that hangs until the signal aborts, then errors — like a real
    // fetch body does when its request is aborted.
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(
          encoder.encode(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
          ),
        );
        controller.signal.addEventListener("abort", () => c.error(new Error("aborted")));
      },
    });
    const provider = new AnthropicProvider({
      baseURL: "http://unused.local/v1",
      model: "m",
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        fetchSignal = init?.signal;
        return new Response(body);
      }) as typeof fetch,
    });
    const run = (async () => {
      for await (const _ of provider.stream({
        messages: [{ role: "user", content: "hi" }],
        signal: controller.signal,
      })) {
        // drain
      }
    })();
    await Bun.sleep(10);
    controller.abort();
    await expect(run).rejects.toThrow("aborted");
    // The provider must hand the caller's signal to fetch (the OpenAI provider's
    // existing abort contract) so the body stream can be torn down.
    expect(fetchSignal).toBe(controller.signal);
  });
});

describe("anthropicErrorHint (actionable non-2xx errors)", () => {
  const body = (type: string, message: string) =>
    JSON.stringify({ type: "error", error: { type, message } });

  test("an unknown model names the config key to set", () => {
    const hint = anthropicErrorHint(404, body("not_found_error", "model: default"));
    expect(hint).toContain("model.model");
    expect(hint).toContain("TENTACLE_MODEL");
  });

  test("a missing or bad key names the key settings", () => {
    const hint = anthropicErrorHint(401, body("authentication_error", "invalid x-api-key"));
    expect(hint).toContain("model.apiKeyCommand");
    expect(hint).toContain("TENTACLE_MODEL_API_KEY");
  });

  test("other errors get no hint; a non-JSON body never throws", () => {
    expect(anthropicErrorHint(429, body("rate_limit_error", "slow down"))).toBeUndefined();
    expect(anthropicErrorHint(404, "<html>not found</html>")).toBeUndefined();
  });

  test("the hint reaches the thrown error message", async () => {
    const provider = new AnthropicProvider({
      baseURL: "http://h/v1",
      model: "default",
      fetch: (async () =>
        new Response(body("not_found_error", "model: default"), {
          status: 404,
        })) as unknown as typeof fetch,
    });
    const run = async () => {
      for await (const _ of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow("TENTACLE_MODEL");
  });
});

// docs/feat/context-awareness.md: with prompt caching active, `input_tokens` counts
// only the uncached tail; the prompt's real size adds both cache counts.
describe("prompt usage with prompt caching", () => {
  const done = async (start: unknown): Promise<StreamEvent | undefined> => {
    const events = [
      { type: "message_start", message: { usage: start } },
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ];
    const provider = new AnthropicProvider({
      baseURL: "http://h/v1",
      model: "m",
      fetch: (async () =>
        new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })) as unknown as typeof fetch,
    });
    let last: StreamEvent | undefined;
    for await (const e of provider.stream({ messages: [{ role: "user", content: "hi" }] })) {
      last = e;
    }
    return last;
  };

  test("promptTokens = input + cache creation + cache read", async () => {
    expect(
      await done({
        input_tokens: 40,
        cache_read_input_tokens: 11000,
        cache_creation_input_tokens: 960,
      }),
    ).toEqual({ type: "done", usage: { promptTokens: 12000, completionTokens: 30 } });
  });

  test("absent cache counts add nothing", async () => {
    expect(await done({ input_tokens: 40 })).toEqual({
      type: "done",
      usage: { promptTokens: 40, completionTokens: 30 },
    });
  });
});
