import { describe, expect, test } from "bun:test";
import {
  InitializeParamsSchema,
  NewSessionParamsSchema,
  PromptParamsSchema,
  PromptResultSchema,
  StopReasonSchema,
} from "../src/index.ts";

describe("session lifecycle schemas", () => {
  test("initialize applies the streaming capability default", () => {
    const parsed = InitializeParamsSchema.parse({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(parsed.clientCapabilities.streaming).toBe(true);
  });

  test("initialize rejects unknown capability keys (strict)", () => {
    const r = InitializeParamsSchema.safeParse({
      protocolVersion: 1,
      clientCapabilities: { streaming: true, bogus: 1 },
    });
    expect(r.success).toBe(false);
  });

  test("session/new accepts empty params", () => {
    expect(NewSessionParamsSchema.safeParse({}).success).toBe(true);
  });

  const prompt = { sessionId: "s1", turnId: "t1", content: [{ type: "text", text: "hi" }] };

  test("prompt requires at least one content block", () => {
    expect(PromptParamsSchema.safeParse(prompt).success).toBe(true);
    expect(PromptParamsSchema.safeParse({ ...prompt, content: [] }).success).toBe(false);
  });

  test("prompt requires a non-empty sessionId", () => {
    expect(PromptParamsSchema.safeParse({ ...prompt, sessionId: "" }).success).toBe(false);
  });

  test("prompt requires a client turnId of 1..128 chars", () => {
    expect(PromptParamsSchema.safeParse({ ...prompt, turnId: undefined }).success).toBe(false);
    expect(PromptParamsSchema.safeParse({ ...prompt, turnId: "" }).success).toBe(false);
    expect(PromptParamsSchema.safeParse({ ...prompt, turnId: "x".repeat(128) }).success).toBe(true);
    expect(PromptParamsSchema.safeParse({ ...prompt, turnId: "x".repeat(129) }).success).toBe(
      false,
    );
  });

  test("the prompt result is an ack: turnId, plus `ended` only for a finished turn", () => {
    expect(PromptResultSchema.safeParse({ turnId: "t1" }).success).toBe(true);
    expect(
      PromptResultSchema.safeParse({
        turnId: "t1",
        ended: { stopReason: "error", error: { code: -32603, message: "internal error" } },
      }).success,
    ).toBe(true);
    // The old shape (the stop reason as the result) is gone.
    expect(PromptResultSchema.safeParse({ stopReason: "end_turn" }).success).toBe(false);
  });

  test("stop reasons", () => {
    expect(StopReasonSchema.options).toContain("end_turn");
    expect(StopReasonSchema.safeParse("nope").success).toBe(false);
  });
});
