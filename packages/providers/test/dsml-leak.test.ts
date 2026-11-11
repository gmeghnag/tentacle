/**
 * docs/fix/deepseek-dsml-leak.md, symptom A: the endpoint sent a tool call as
 * ordinary content text in DeepSeek's DSML markup, tentacle took it as the
 * final answer and ended the turn. The provider must refuse it instead.
 *
 * The fixture is the INCIDENT's own bytes (log 773-778, the base64 body
 * shortened): prose, then parameter tags with attributes, then the closers —
 * and no opening invoke tag (Review HIGH-1).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DsmlToolCallLeakError } from "@tentacle/core";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../src/index.ts";

/** The leaked reply, the log's literal bytes. */
const LEAK = [
  "Base64 works reliably. Appending the rest.</｜DSML｜ parameter>",
  '<｜DSML｜ parameter name="fs_write">',
  '<｜DSML｜ parameter name="content" string="true">CiAgdGVzdCgiYW4gZW1w</｜DSML｜ parameter>',
  '<｜DSML｜ parameter name="path" string="true">/Users/gmeghnag/tentacle/.tentacle/worktrees/history-validity/packages/providers/test/p4.txt</｜DSML｜ parameter>',
  "</｜DSML｜ invoke>",
  "</｜DSML｜ calls>",
].join("\n");

/** One SSE frame carrying content text. */
function text(s: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: s } }] })}\n\n`;
}

let server: ReturnType<typeof Bun.serve>;
let baseURL: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { model: string };
      // "leak": the reply is a tool call in TEXT form. "clean": prose that
      // MENTIONS DSML (the guard must not refuse it).
      const answer =
        body.model === "leak"
          ? LEAK
          : "DSML is DeepSeek's markup; a real tool call is fine. The file is written.";
      return new Response(text(answer), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  baseURL = `http://localhost:${server.port}/v1`;
});

afterAll(() => {
  server.stop(true);
});

/** Drain a reply, returning the error it threw (or `undefined`). */
async function attempt(model: string): Promise<unknown> {
  const provider = new OpenAIProvider({ baseURL, model });
  const events: StreamEvent[] = [];
  try {
    for await (const event of provider.stream({ messages: [{ role: "user", content: "go" }] })) {
      events.push(event);
    }
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("a DSML tool call leaked as text", () => {
  test("is refused, not accepted as the answer", async () => {
    const error = await attempt("leak");
    expect(error).toBeInstanceOf(DsmlToolCallLeakError);
  });

  test("ordinary prose — even one mentioning DSML — is still accepted", async () => {
    expect(await attempt("clean")).toBeUndefined();
  });
});
