/**
 * docs/fix/deepseek-dsml-leak.md, symptom B over the wire: a long `fs_write`
 * body streamed as many argument deltas must yield ONE call, never a head
 * fragment plus a nameless tail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../src/index.ts";

/** A body of the incident's size: many deltas, one logical call. */
const ARGS = JSON.stringify({ path: "/tmp/x.test.ts", content: "a".repeat(3000) });

const pieces: string[] = [];
for (let i = 0; i < ARGS.length; i += 400) {
  pieces.push(ARGS.slice(i, i + 400));
}

/** One SSE frame for a `tool_calls` delta. */
function frame(call: Record<string, unknown>): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [call] } }] })}\n\n`;
}

/** The head frame names the call; the rest are continuations. */
function head(): string {
  return frame({ index: 0, id: "c1", function: { name: "fs_write", arguments: pieces[0] } });
}

const BODY = pieces.slice(1);

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

/** Which split shape the request asks for, by model name. */
function continuation(part: string, same: boolean): Record<string, unknown> {
  return same ? { index: 0, function: { arguments: part } } : { function: { arguments: part } };
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const model = (await req.json()) as { model: string };
      const keepIndex = model.model === "same-index";
      const frames = BODY.map((p) => frame(continuation(p, keepIndex))).join("");
      return new Response(head() + frames, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

/** Drain a stream, keeping only its tool calls. */
async function calls(model: string): Promise<StreamEvent[]> {
  const provider = new OpenAIProvider({ baseURL, model });
  const out: StreamEvent[] = [];
  for await (const event of provider.stream({ messages: [{ role: "user", content: "go" }] })) {
    if (event.type === "tool_call") {
      out.push(event);
    }
  }
  return out;
}

const callsOf = (events: StreamEvent[]): { name: string; arguments: string }[] =>
  events.map((e) => {
    if (e.type !== "tool_call") {
      throw new Error("not a tool call");
    }
    return { name: e.toolCall.name, arguments: e.toolCall.arguments };
  });

describe("a streamed tool call split across deltas", () => {
  test("an OMITTED index mid-call still yields one complete call", async () => {
    const got = callsOf(await calls("omitted-index"));
    expect(got).toHaveLength(1);
    expect(got[0]?.name).toBe("fs_write");
    expect(() => JSON.parse(got[0]?.arguments ?? "")).not.toThrow();
    expect(JSON.parse(got[0]?.arguments ?? "")).toEqual(JSON.parse(ARGS));
  });

  test("a REPEATED index mid-call still yields one complete call", async () => {
    const got = callsOf(await calls("same-index"));
    expect(got).toHaveLength(1);
    expect(JSON.parse(got[0]?.arguments ?? "")).toEqual(JSON.parse(ARGS));
  });
});
