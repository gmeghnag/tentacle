import { describe, expect, test } from "bun:test";
import * as P from "../src/index.ts";

// Namespace access: on a tree without `session/send_now` every case fails on
// its assertion (an absent schema parses nothing), not on a missing import.
const params = (value: unknown): boolean | undefined =>
  P.SendNowParamsSchema?.safeParse(value).success;

const valid = {
  sessionId: "s",
  turnId: "T2",
  interrupt: { kind: "turn", turnId: "T1" },
  messages: [
    { id: "a", text: "A" },
    { id: "b", text: "B" },
  ],
};

describe("session/send_now (docs/feat/send-now-a.md)", () => {
  test("is registered as session/send_now, acked like session/prompt", () => {
    expect(P.Method.SendNow).toBe("session/send_now");
    const schemas = P.RequestSchemas[P.Method.SendNow];
    expect(schemas?.params).toBe(P.SendNowParamsSchema);
    expect(schemas?.result).toBe(P.PromptResultSchema);
  });

  test("accepts a turn or a compaction target", () => {
    expect(params(valid)).toBe(true);
    expect(params({ ...valid, interrupt: { kind: "compaction" } })).toBe(true);
  });

  test("rejects an empty send-now, a missing or unknown target, an empty text or id", () => {
    expect(params({ ...valid, messages: [] })).toBe(false);
    const { interrupt: _, ...noTarget } = valid;
    expect(params(noTarget)).toBe(false);
    expect(params({ ...valid, interrupt: { kind: "turn" } })).toBe(false);
    expect(params({ ...valid, interrupt: { kind: "other" } })).toBe(false);
    expect(params({ ...valid, messages: [{ id: "a", text: "" }] })).toBe(false);
    expect(params({ ...valid, messages: [{ id: "", text: "A" }] })).toBe(false);
    expect(params({ ...valid, messages: [{ id: "x".repeat(129), text: "A" }] })).toBe(false);
    expect(params({ ...valid, turnId: "" })).toBe(false);
  });

  test("an unknown field is stripped, not rejected (forward compat)", () => {
    const parsed = P.SendNowParamsSchema?.safeParse({
      ...valid,
      extra: 1,
      interrupt: { kind: "turn", turnId: "T1", extra: 2 },
      messages: [{ id: "a", text: "A", extra: 3 }],
    });
    expect(parsed?.success).toBe(true);
    expect(parsed?.data).toEqual({
      sessionId: "s",
      turnId: "T2",
      interrupt: { kind: "turn", turnId: "T1" },
      messages: [{ id: "a", text: "A" }],
    });
  });
});
