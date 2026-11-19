/**
 * The `GATED` mock scenario (docs/fix/mobile-e2e-reds.md): a turn that streams its
 * first delta, then stays open until the harness RELEASES it (`model-release`) —
 * so flow 12 can type and queue a steer with no race against a timer (the 4 s
 * `STEADY` turn ended before Maestro's ~27 s of type + tap on iOS 26).
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../../../packages/providers/src/index.ts";
import { startMockModel } from "../e2e/mock-model.ts";

const mock = startMockModel({ gateCapMs: 2000 });
afterAll(() => mock.stop());
const provider = new OpenAIProvider({ baseURL: mock.baseUrl, model: "mock" });

async function run(prompt: string, log: string[]): Promise<void> {
  const messages = [{ role: "user" as const, content: prompt }];
  for await (const event of provider.stream({ messages }) as AsyncIterable<StreamEvent>) {
    if (event.type === "text") {
      log.push("text");
    }
  }
  log.push("end");
}

describe("GATED", () => {
  test("stays open after its first delta until released, then ends", async () => {
    const log: string[] = [];
    const done = run("GATED turn for the steer", log);
    await Bun.sleep(400);
    expect(log).toEqual(["text"]);
    expect(mock.gated()).toBe(true);
    log.push("release");
    mock.release();
    await done;
    expect(log.indexOf("end")).toBeGreaterThan(log.indexOf("release"));
    expect(mock.gated()).toBe(false);
  });

  test("a gate nobody releases ends at its cap (never a hung harness)", async () => {
    const log: string[] = [];
    const started = Date.now();
    await run("GATED forgotten", log);
    expect(log.at(-1)).toBe("end");
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
  });

  test("an aborted request opens its gate (a send-now cancels the turn: flow 13)", async () => {
    const abort = new AbortController();
    const response = fetch(`${mock.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "GATED cancelled" }] }),
      signal: abort.signal,
    });
    await (await response).body?.getReader().read();
    expect(mock.gated()).toBe(true);
    abort.abort();
    await Bun.sleep(100);
    expect(mock.gated()).toBe(false);
  });

  test("a release with no gated turn is a no-op for the next one", async () => {
    mock.release();
    const log: string[] = [];
    const done = run("GATED again", log);
    await Bun.sleep(400);
    expect(log).toEqual(["text"]);
    mock.release();
    await done;
  });
});
