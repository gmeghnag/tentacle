import { describe, expect, test } from "bun:test";
import { type ChatRequest, countTokensBounded } from "../src/index.ts";

const REQ: ChatRequest = { messages: [{ role: "user", content: "x" }] };

describe("countTokensBounded (the 2 s cap, one rule for the daemon and the laptop)", () => {
  test("a count within the cap: the number", async () => {
    expect(await countTokensBounded({ countTokens: async () => 7 }, REQ)).toBe(7);
  });

  test("cannot count / fails: undefined, never a throw", async () => {
    expect(await countTokensBounded({}, REQ)).toBeUndefined();
    expect(
      await countTokensBounded(
        {
          countTokens: async () => {
            throw new Error("down");
          },
        },
        REQ,
      ),
    ).toBeUndefined();
  });

  test("a hung count is cut at the cap AND the provider's signal is aborted (no dangling request)", async () => {
    let seen: AbortSignal | undefined;
    const started = Date.now();
    const got = await countTokensBounded(
      {
        countTokens: (r) => {
          seen = r.signal;
          return new Promise(() => {});
        },
      },
      REQ,
      undefined,
      40,
    );
    expect(got).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(seen?.aborted).toBe(true);
  });

  test("the caller's own abort cuts it too, and reaches the provider", async () => {
    const ctl = new AbortController();
    let seen: AbortSignal | undefined;
    const pending = countTokensBounded(
      {
        countTokens: (r) => {
          seen = r.signal;
          return new Promise(() => {});
        },
      },
      REQ,
      ctl.signal,
      5000,
    );
    ctl.abort();
    expect(await pending).toBeUndefined();
    expect(seen?.aborted).toBe(true);
  });
});
