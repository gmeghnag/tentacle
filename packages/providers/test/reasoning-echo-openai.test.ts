/**
 * reasoning-echo s2 (docs/fix/reasoning-echo.md, T2): the OpenAI-compatible
 * provider hands the reasoning it streamed back on `done` (D2), writes it into
 * the assistant message in the field it arrived in (D3), only for its own
 * records (D5), and falls back once, latched on success only, when the server
 * 400s on it (D9).
 */
import { describe, expect, test } from "bun:test";
import type { ChatMessage, ChatRequest, ReasoningRecord, StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../src/openai-provider.ts";

function sse(deltas: Record<string, unknown>[]): string {
  const chunks = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  const end = `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`;
  return `${chunks.join("")}${end}data: [DONE]\n\n`;
}

type Body = { messages: Record<string, unknown>[] };

/** A fake endpoint recording bodies; `reply(body)` picks the response. */
function endpoint(reply: (body: Body) => Response) {
  const bodies: Body[] = [];
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return reply(body);
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

const ok = (deltas: Record<string, unknown>[]) =>
  new Response(sse(deltas), { headers: { "content-type": "text/event-stream" } });

function provider(fetchImpl: typeof fetch): OpenAIProvider {
  return new OpenAIProvider({ baseURL: "http://x/v1", model: "m", fetch: fetchImpl });
}

async function events(p: OpenAIProvider, request: ChatRequest): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of p.stream(request)) {
    out.push(e);
  }
  return out;
}

function record(source: string, field: "reasoning_content" | "reasoning", text: string) {
  const r: ReasoningRecord = { source, body: { format: "openai", field, text } };
  return r;
}

function history(reasoning?: ReasoningRecord): ChatMessage[] {
  return [
    { role: "user", content: "go" },
    { role: "assistant", content: "", ...(reasoning ? { reasoning } : {}) },
    { role: "user", content: "again" },
  ];
}

function doneOf(evs: StreamEvent[]) {
  return evs.find((e) => e.type === "done");
}

describe("D2 decode: done carries the accumulated reasoning", () => {
  test("deltas accumulate; the field name seen is kept", async () => {
    const fake = endpoint(() =>
      ok([{ reasoning_content: "think " }, { reasoning_content: "hard" }, { content: "hi" }]),
    );
    const p = provider(fake.fetchImpl);
    const done = doneOf(await events(p, { messages: history() }));
    expect(done?.type === "done" ? done.reasoning : "x").toEqual(
      record(p.id, "reasoning_content", "think hard"),
    );
  });

  test("field `reasoning` is remembered as `reasoning`", async () => {
    const fake = endpoint(() => ok([{ reasoning: "a" }, { reasoning: "b" }]));
    const done = doneOf(await events(provider(fake.fetchImpl), { messages: history() }));
    expect(done?.type === "done" ? done.reasoning?.body : "x").toEqual({
      format: "openai",
      field: "reasoning",
      text: "ab",
    });
  });

  test("no reasoning streamed → no record on done", async () => {
    const fake = endpoint(() => ok([{ content: "hi" }]));
    const done = doneOf(await events(provider(fake.fetchImpl), { messages: history() }));
    expect(done !== undefined && "reasoning" in done).toBe(false);
  });
});

describe("D3/D5 encode: own records only, in the field they arrived in", () => {
  test("echoed in the same field", async () => {
    for (const field of ["reasoning_content", "reasoning"] as const) {
      const fake = endpoint(() => ok([{ content: "x" }]));
      const p = provider(fake.fetchImpl);
      await events(p, { messages: history(record(p.id, field, "my thoughts")) });
      expect(fake.bodies[0]?.messages[1]?.[field]).toBe("my thoughts");
    }
  });

  test("a record from another source is not sent (never deleted)", async () => {
    const fake = endpoint(() => ok([{ content: "x" }]));
    const p = provider(fake.fetchImpl);
    const h = history(record("some-other-provider", "reasoning_content", "theirs"));
    await events(p, { messages: h });
    const sent = fake.bodies[0]?.messages[1];
    expect(sent?.reasoning_content).toBeUndefined();
    expect(sent?.reasoning).toBeUndefined();
    expect(h[1]?.reasoning).toBeDefined();
  });

  test("an anthropic-format record is not sent even with a matching source", async () => {
    const fake = endpoint(() => ok([{ content: "x" }]));
    const p = provider(fake.fetchImpl);
    const r: ReasoningRecord = {
      source: p.id,
      body: { format: "anthropic", blocks: [{ type: "redacted_thinking", data: "SECRETDATA" }] },
    };
    await events(p, { messages: history(r) });
    expect(JSON.stringify(fake.bodies[0])).not.toContain("SECRETDATA");
  });
});

describe("D9 400 fallback", () => {
  const withField = (b: Body | undefined) => JSON.stringify(b).includes("reasoning_content");

  test("one retry without the field, latched only after it succeeds", async () => {
    const fake = endpoint((b) =>
      withField(b)
        ? new Response("Unrecognized request argument supplied: reasoning_content", {
            status: 400,
          })
        : ok([{ content: "x" }]),
    );
    const p = provider(fake.fetchImpl);
    const h = history(record(p.id, "reasoning_content", "t"));
    await events(p, { messages: h });
    expect(fake.bodies.length).toBe(2);
    expect(withField(fake.bodies[0])).toBe(true);
    expect(withField(fake.bodies[1])).toBe(false);
    await events(p, { messages: h });
    expect(fake.bodies.length).toBe(3);
    expect(withField(fake.bodies[2])).toBe(false);
  });

  test("a 400 for another cause (both bodies) is not latched", async () => {
    const fake = endpoint(() => new Response("too long", { status: 400 }));
    const p = provider(fake.fetchImpl);
    const h = history(record(p.id, "reasoning_content", "t"));
    await expect(events(p, { messages: h })).rejects.toThrow();
    await expect(events(p, { messages: h })).rejects.toThrow();
    // 2 bodies per turn: the echo is still tried first on the 2nd turn.
    expect(fake.bodies.length).toBe(4);
    expect(withField(fake.bodies[2])).toBe(true);
  });

  test("a 400 that a smaller body fixes (context overflow) does not latch the echo off", async () => {
    // llama.cpp-like: any body over the limit 400s, with a message that does
    // not name the echoed field. Dropping the echo shrinks the body, so the
    // retry succeeds — that is not evidence the field is refused.
    const limit = 700;
    const fake = endpoint((b) =>
      JSON.stringify(b).length > limit
        ? new Response("the request exceeds the available context size", { status: 400 })
        : ok([{ content: "x" }]),
    );
    const p = provider(fake.fetchImpl);
    const big = history(record(p.id, "reasoning_content", "t".repeat(600)));
    await events(p, { messages: big });
    expect(fake.bodies.map(withField)).toEqual([true, false]);
    // A later, small turn: the echo is still sent.
    await events(p, { messages: history(record(p.id, "reasoning_content", "t")) });
    expect(withField(fake.bodies[2])).toBe(true);
  });

  test("an endpoint refusing both the voice switches and the echo: the turn still succeeds", async () => {
    const switches = (b: Body | undefined) => JSON.stringify(b).includes("reasoning_effort");
    const fake = endpoint((b) =>
      switches(b) || withField(b)
        ? new Response("bad request", { status: 400 })
        : ok([{ content: "x" }]),
    );
    const p = provider(fake.fetchImpl);
    const h = history(record(p.id, "reasoning_content", "t"));
    const done = doneOf(await events(p, { messages: h, reasoning: "off" }));
    expect(done?.type).toBe("done");
    const last = fake.bodies.at(-1);
    expect(switches(last) || withField(last)).toBe(false);
    // The next voice turn converges too.
    const n = fake.bodies.length;
    expect(doneOf(await events(p, { messages: h, reasoning: "off" }))?.type).toBe("done");
    expect(fake.bodies.length - n).toBeLessThan(n);
  });

  test("a request without echoed reasoning gets no retry", async () => {
    const fake = endpoint(() => new Response("bad", { status: 400 }));
    await expect(events(provider(fake.fetchImpl), { messages: history() })).rejects.toThrow();
    expect(fake.bodies.length).toBe(1);
  });
});
