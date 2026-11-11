/**
 * The provider boundary must NAME why a stream ended, because nothing
 * downstream can reconstruct it (docs/fix/truncated-reply-silent.md).
 *
 * The three shapes are the owner's incident, measured on a fake
 * OpenAI-compatible server (`Bun.serve`, no key, no real API):
 * - `finish_reason: "length"` → the reply was CUT at the output limit;
 * - no `finish_reason` at all → the body was cut, the stream never finished;
 * - `finish_reason: "stop"` → it finished on its own.
 *
 * RED before the fix: `done` carried `{ type, usage }` only, so all three were
 * byte-identical to the caller.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../src/index.ts";

const f = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const t = (s: string): string => f({ choices: [{ delta: { content: s } }] });
const r = (s: string | null): string => f({ choices: [{ delta: {}, finish_reason: s }] });
const tool = (name: string, args: string): string =>
  f({
    choices: [
      { delta: { tool_calls: [{ index: 0, id: "c1", function: { name, arguments: args } }] } },
    ],
  });

const BODIES: Record<string, () => string> = {
  length: () => t("la vera") + t(" soluzione") + r("length"),
  cut: () => t("la vera") + t(" soluzione"),
  stop: () => t("la vera") + t(" soluzione") + r("stop"),
  empty_length: () => r("length"),
  toolcut_length: () => tool("fs_write", '{"path":"a.ts",') + r("length"),
  n_finish: () => t("mid") + r(null) + t("dle"),
};

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model?: string };
      return new Response((BODIES[body.model ?? ""] ?? (() => ""))(), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

async function collect(model: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of new OpenAIProvider({ baseURL, model }).stream({
    messages: [{ role: "user", content: "hi" }],
  })) {
    out.push(event);
  }
  return out;
}

const doneOf = (events: readonly StreamEvent[]): StreamEvent | undefined =>
  events.find((e) => e.type === "done");

describe("OpenAIProvider names the stop reason (docs/fix/truncated-reply-silent.md)", () => {
  test("finish_reason 'length' is reported as 'length', the text still streamed", async () => {
    const events = await collect("length");
    expect(doneOf(events)).toEqual({ type: "done", stopReason: "length" });
    const text = events.map((e) => (e.type === "text" ? e.delta : "")).join("");
    expect(text).toBe("la vera soluzione");
  });

  test("a body that ends with NO finish_reason is 'other': the stream was cut", async () => {
    // The owner's second symptom: byte-identical to a finished reply before.
    expect(doneOf(await collect("cut"))).toEqual({ type: "done", stopReason: "other" });
  });

  test("finish_reason 'stop' is a finished reply", async () => {
    expect(doneOf(await collect("stop"))).toEqual({ type: "done", stopReason: "stop" });
  });

  test("a null finish_reason mid-stream does not count: the LAST one wins", async () => {
    expect(doneOf(await collect("n_finish"))).toEqual({ type: "done", stopReason: "other" });
  });

  test("an empty reply cut by 'length' is 'length' with no text and no call", async () => {
    const events = await collect("empty_length");
    expect(doneOf(events)).toEqual({ type: "done", stopReason: "length" });
    expect(events.filter((e) => e.type === "text" || e.type === "tool_call")).toEqual([]);
  });

  test("a tool call remains visible at the boundary; the cut is the stop reason", async () => {
    // The provider does not refuse here (the agent loop does, so the refusal is
    // one rule for both providers); what it must do is NAME the cut.
    const events = await collect("toolcut_length");
    expect(events.find((e) => e.type === "tool_call")).toEqual({
      type: "tool_call",
      toolCall: { id: "c1", name: "fs_write", arguments: '{"path":"a.ts",' },
    });
    expect(doneOf(events)).toEqual({ type: "done", stopReason: "length" });
  });

  test("usage rides the same done event as the stop reason", async () => {
    const events = await collect("length");
    // This server sends no usage: the field is absent, not zeroed.
    expect(doneOf(events)).toEqual({ type: "done", stopReason: "length" });
  });
});
