import { describe, expect, test } from "bun:test";
import {
  InitializeParamsSchema,
  NewSessionParamsSchema,
  PromptParamsSchema,
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

  test("prompt requires at least one content block", () => {
    expect(
      PromptParamsSchema.safeParse({ sessionId: "s1", content: [{ type: "text", text: "hi" }] })
        .success,
    ).toBe(true);
    expect(PromptParamsSchema.safeParse({ sessionId: "s1", content: [] }).success).toBe(false);
  });

  test("prompt requires a non-empty sessionId", () => {
    expect(
      PromptParamsSchema.safeParse({ sessionId: "", content: [{ type: "text", text: "hi" }] })
        .success,
    ).toBe(false);
  });

  test("stop reasons", () => {
    expect(StopReasonSchema.options).toContain("end_turn");
    expect(StopReasonSchema.safeParse("nope").success).toBe(false);
  });
});
