import { describe, expect, test } from "bun:test";
import { applyCacheControl } from "../src/anthropic-cache.ts";
import { AnthropicProvider, buildPayload } from "../src/index.ts";

const EPH = { type: "ephemeral" };
const tool = { name: "t", description: "d", parameters: { type: "object", properties: {} } };

function count(v: unknown): number {
  return JSON.stringify(v).split('"cache_control"').length - 1;
}

describe("applyCacheControl", () => {
  test("system becomes one cached block; last user string message is cached", () => {
    const p: Record<string, unknown> = {
      system: "SYS",
      messages: [{ role: "user", content: "hi" }],
    };
    applyCacheControl(p);
    expect(p.system).toEqual([{ type: "text", text: "SYS", cache_control: EPH }]);
    expect(p.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "hi", cache_control: EPH }] },
    ]);
  });

  test("last block of the last message (tool_result) gets the breakpoint, earlier ones not", () => {
    const p: Record<string, unknown> = {
      system: "S",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: [{ type: "tool_use", id: "a", name: "t", input: {} }] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "a", content: "1" },
            { type: "tool_result", tool_use_id: "b", content: "2" },
          ],
        },
      ],
    };
    applyCacheControl(p);
    const msgs = p.messages as { content: unknown }[];
    expect(count(msgs[0])).toBe(0);
    expect(count(msgs[1])).toBe(0);
    const last = msgs[2]?.content as Record<string, unknown>[];
    expect(last[0]?.cache_control).toBeUndefined();
    expect(last[1]?.cache_control).toEqual(EPH);
    expect(count(p)).toBeLessThanOrEqual(4);
  });

  test("no system prompt: the last tool carries the breakpoint", () => {
    const p: Record<string, unknown> = {
      tools: [{ name: "a" }, { name: "b" }],
      messages: [{ role: "user", content: "x" }],
    };
    applyCacheControl(p);
    const tools = p.tools as Record<string, unknown>[];
    expect(tools[0]?.cache_control).toBeUndefined();
    expect(tools[1]?.cache_control).toEqual(EPH);
  });

  test("empty messages / empty content: no crash, no stray breakpoint", () => {
    const p: Record<string, unknown> = { messages: [] };
    applyCacheControl(p);
    expect(count(p)).toBe(0);
  });
});

describe("AnthropicProvider.stream request body", () => {
  test("sends cache_control on system and the last message; prefix before it is byte-stable across rounds", async () => {
    const bodies: Record<string, unknown>[] = [];
    const provider = new AnthropicProvider({
      baseURL: "http://unused.local/v1",
      model: "m",
      fetch: (async (_u: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        const sse = [
          { type: "message_start", message: { usage: { input_tokens: 1 } } },
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
    const base = [
      { role: "system" as const, content: "SYS" },
      { role: "user" as const, content: "q1" },
    ];
    const r2 = [
      ...base,
      { role: "assistant" as const, content: "a1" },
      { role: "user" as const, content: "q2" },
    ];
    for (const messages of [base, r2]) {
      for await (const _ of provider.stream({ messages, tools: [tool] })) {
        // drain
      }
    }
    expect(bodies[0]?.system).toEqual([{ type: "text", text: "SYS", cache_control: EPH }]);
    expect(count(bodies[0])).toBe(2);
    expect(count(bodies[1])).toBe(2);
    // The cached prefix (tools + system) is identical between rounds.
    expect(JSON.stringify([bodies[0]?.tools, bodies[0]?.system])).toBe(
      JSON.stringify([bodies[1]?.tools, bodies[1]?.system]),
    );
    // buildPayload itself (used by count_tokens) stays breakpoint-free.
    expect(count(buildPayload("m", { messages: base, tools: [tool] }))).toBe(0);
  });
});
