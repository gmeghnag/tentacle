/**
 * An error the server sends INSIDE the stream must reach the user as that
 * error, never as a stream "cut" (docs/fix/model-stream-error.md). Recorded
 * llama.cpp bytes through an injected fetch: no network.
 */
import { describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider, createModelProvider } from "../src/index.ts";

const f = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;
const t = (s: string): string => f({ choices: [{ delta: { content: s } }] });
const ERR = { code: 500, message: "Context size has been exceeded.", type: "server_error" };
const WANT = "model server error: Context size has been exceeded.";

function fetchOf(body: string, calls?: { n: number }): typeof fetch {
  return (async () => {
    if (calls) {
      calls.n++;
    }
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
}

async function run(
  body: string,
  calls?: { n: number },
): Promise<{ events: StreamEvent[]; error?: Error }> {
  const provider = new OpenAIProvider({
    baseURL: "http://unused.local/v1",
    model: "m",
    fetch: fetchOf(body, calls),
  });
  const events: StreamEvent[] = [];
  try {
    for await (const e of provider.stream({ messages: [{ role: "user", content: "x" }] })) {
      events.push(e);
    }
  } catch (error) {
    return { events, error: error as Error };
  }
  return { events };
}

describe("in-band stream errors", () => {
  test("(a) llama.cpp `error:` field throws the server's message, no done", async () => {
    const { events, error } = await run(`${t("ok")}error: ${JSON.stringify(ERR)}\n\n`);
    expect(error?.message).toBe(WANT);
    expect(error?.name).toBe("ModelServerError");
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("(b) `data: {error}` throws the same", async () => {
    const { events, error } = await run(t("ok") + f({ error: ERR }));
    expect(error?.message).toBe(WANT);
    expect(events.some((e) => e.type === "done")).toBe(false);
  });

  test("(c) a non-JSON `error:` line", async () => {
    const { error } = await run("error: boom\n\n");
    expect(error?.message).toBe("model server error: boom");
  });

  test("error object without a message becomes its JSON, capped", async () => {
    const { error } = await run(f({ error: { code: 7 } }));
    expect(error?.message).toBe(`model server error: ${JSON.stringify({ code: 7 })}`);
    const big = await run(f({ error: { x: "y".repeat(500) } }));
    expect(big.error?.message.length).toBeLessThanOrEqual(400);
  });

  test("(d) an error after a partial tool-call delta yields no tool_call", async () => {
    const partial = f({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "c1", function: { name: "fs_write", arguments: '{"p' } }],
          },
        },
      ],
    });
    const { events, error } = await run(`${partial}error: ${JSON.stringify(ERR)}\n\n`);
    expect(error?.message).toBe(WANT);
    expect(events.some((e) => e.type === "tool_call")).toBe(false);
  });

  test("(e) through the retry wrapper: one fetch, still the server error", async () => {
    const calls = { n: 0 };
    const provider = createModelProvider({
      baseURL: "http://unused.local/v1",
      model: "m",
      fetch: fetchOf(`error: ${JSON.stringify(ERR)}\n\n`, calls),
    });
    let error: Error | undefined;
    try {
      for await (const _ of provider.stream({ messages: [{ role: "user", content: "x" }] })) {
        // drain
      }
    } catch (e) {
      error = e as Error;
    }
    expect(error?.message).toBe(WANT);
    expect(error?.name).toBe("ModelServerError");
    expect(calls.n).toBe(1);
  });

  test("(f) control: a normal stream still finishes, unknown JSON is skipped", async () => {
    const { events, error } = await run(
      t("hi") + f({ foo: 1 }) + f({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    );
    expect(error).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done && "stopReason" in done ? done.stopReason : undefined).toBe("stop");
  });
});
