/**
 * docs/fix/deepseek-dsml-leak.md, symptom A: the endpoint sent a tool call as
 * ordinary content text in DeepSeek's DSML markup, tentacle took it as the
 * final answer and ended the turn. The provider must refuse it instead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DsmlToolCallLeakError } from "@tentacle/core";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../src/index.ts";

const B = "\uFF5C";
/** The leaked reply, spelled as the incident's log has it. */
const LEAK = [
  "Base64 works.",
  `<${B}DSML${B} invoke>`,
  `<${B}DSML${B} parameter name="fs_write">`,
  "CiAgdGVzdCg=",
  `</${B}DSML${B} invoke>`,
  `</${B}DSML${B} calls>`,
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
      // "leak": the reply is a tool call in TEXT form. "clean": prose.
      const answer = body.model === "leak" ? LEAK : "The file is written.";
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

  test("ordinary prose is still accepted", async () => {
    expect(await attempt("clean")).toBeUndefined();
  });
});
