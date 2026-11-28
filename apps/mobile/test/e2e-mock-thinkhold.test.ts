/**
 * The `THINKHOLD` mock scenario (docs/feat/mobile-hub-native-driver.md), through
 * the REAL `OpenAIProvider` stream: a HOLD turn that is all Thinking first — the
 * load the hub's fan is measured under — and only then its answer.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { StreamEvent } from "@tentacle/core";
import { OpenAIProvider } from "../../../packages/providers/src/index.ts";
import { FAST_HOLDS, startMockModel } from "../e2e/mock-model.ts";

const mock = startMockModel({ holdMs: 300 });
afterAll(() => mock.stop());
const provider = new OpenAIProvider({ baseURL: mock.baseUrl, model: "mock" });

async function kinds(prompt: string): Promise<string[]> {
  const out: string[] = [];
  const messages = [{ role: "user" as const, content: prompt }];
  for await (const event of provider.stream({ messages }) as AsyncIterable<StreamEvent>) {
    out.push(event.type);
  }
  return out;
}

describe("THINKHOLD", () => {
  test("streams reasoning for the hold, then the answer", async () => {
    const seen = await kinds("THINKHOLD hub");
    const firstText = seen.indexOf("text");
    const reasoning = seen.filter((k) => k === "reasoning").length;
    expect(reasoning).toBeGreaterThan(3);
    expect(firstText).toBeGreaterThan(seen.lastIndexOf("reasoning"));
  });

  test("FAST streams the reasoning about 4x as often (docs/fix/mobile-fan-jank-device.md)", async () => {
    const slow = (await kinds("THINKHOLD hub")).filter((k) => k === "reasoning").length;
    const fast = (await kinds("THINKHOLD FAST hub")).filter((k) => k === "reasoning").length;
    // Per hold: FAST's load lasts `FAST_HOLDS` of them.
    expect(fast / FAST_HOLDS).toBeGreaterThan(slow * 2);
  });

  // Flow 90 asserts `turn-running` after its last hub open. That proves the open
  // was under load only if the turn cannot outlive the load.
  test("FAST keeps its load past two holds and ends the turn with it", async () => {
    const holdMs = 1000;
    const timed = startMockModel({ holdMs });
    try {
      const stream = new OpenAIProvider({ baseURL: timed.baseUrl, model: "mock" }).stream({
        messages: [{ role: "user" as const, content: "THINKHOLD FAST 90" }],
      }) as AsyncIterable<StreamEvent>;
      const reasoning: number[] = [];
      for await (const event of stream) {
        if (event.type === "reasoning") {
          reasoning.push(performance.now());
        }
      }
      const ended = performance.now();
      const first = reasoning[0] ?? Number.NaN;
      const last = reasoning[reasoning.length - 1] ?? Number.NaN;
      expect(last - first).toBeGreaterThan(2 * holdMs);
      // No quiet tail: a trickle after the load would last another whole hold.
      expect(ended - last).toBeLessThan(holdMs / 2);
      expect(timed.held()).toBe(false);
    } finally {
      timed.stop();
    }
  }, 15_000);

  test("a plain HOLD has no reasoning", async () => {
    expect(await kinds("HOLD hub")).not.toContain("reasoning");
  });
});
