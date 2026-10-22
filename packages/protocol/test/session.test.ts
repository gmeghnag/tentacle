import { describe, expect, test } from "bun:test";
import {
  InitializeParamsSchema,
  InitializeResultSchema,
  MAX_SKILL_CATALOG,
  OpenParamsSchema,
  OpenResultSchema,
  PROTOCOL_VERSION,
  PromptParamsSchema,
  PromptResultSchema,
  StopReasonSchema,
  isMethodName,
} from "../src/index.ts";

describe("session lifecycle schemas", () => {
  test("initialize applies the streaming capability default", () => {
    const parsed = InitializeParamsSchema.parse({
      protocolVersion: 1,
      clientCapabilities: {},
    });
    expect(parsed.clientCapabilities.streaming).toBe(true);
  });

  test("initialize strips unknown capability keys; a bad known one is rejected", () => {
    const r = InitializeParamsSchema.safeParse({
      protocolVersion: 1,
      clientCapabilities: { streaming: true, bogus: 1 },
    });
    expect(r.success && r.data.clientCapabilities).toEqual({ streaming: true });
    expect(
      InitializeParamsSchema.safeParse({ protocolVersion: 1, clientCapabilities: { streaming: 1 } })
        .success,
    ).toBe(false);
  });

  test("session/open accepts empty params and the full shape, and strips unknown keys", () => {
    expect(OpenParamsSchema.safeParse({}).success).toBe(true);
    const full = {
      sessionId: "s",
      since: { epoch: "e", seq: 0 },
      create: true,
      messages: [{ role: "user", content: "hi" }],
      cwd: "/w",
    };
    expect(OpenParamsSchema.safeParse(full).success).toBe(true);
    const extra = OpenParamsSchema.safeParse({ ...full, incarnation: "x" });
    expect(extra.success && "incarnation" in extra.data).toBe(false);
    // `since` is a cut, never a bare number (decision D1).
    expect(OpenParamsSchema.safeParse({ since: 3 }).success).toBe(false);
  });

  test("session/open result carries the epoch and both flags", () => {
    expect(
      OpenResultSchema.safeParse({ sessionId: "s", epoch: "e", created: false, resync: true })
        .success,
    ).toBe(true);
    expect(OpenResultSchema.safeParse({ sessionId: "s", created: false }).success).toBe(false);
  });

  test("session/new is gone (replaced by session/open)", () => {
    expect(isMethodName("session/new")).toBe(false);
    expect(isMethodName("session/open")).toBe(true);
    expect(isMethodName("session/close")).toBe(true);
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

describe("skills on the wire (docs/feat/skills-slash.md)", () => {
  const result = (skills: unknown) => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { tools: true, permissions: true },
    skills,
  });

  test("the version is bumped for the breaking change", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(7);
  });

  test("initialize result requires the catalog (empty is fine)", () => {
    expect(InitializeResultSchema.safeParse(result([])).success).toBe(true);
    const { skills: _omit, ...without } = result([]);
    expect(InitializeResultSchema.safeParse(without).success).toBe(false);
    expect(
      InitializeResultSchema.safeParse(result([{ name: "deploy-app", description: "Deploy." }]))
        .success,
    ).toBe(true);
  });

  test("a hostile catalog is rejected: bad names, control characters, too many", () => {
    for (const name of ["Deploy", "a b", "/tmp/x", "-a", "a--b", "x".repeat(65), ""]) {
      expect(InitializeResultSchema.safeParse(result([{ name, description: "d" }])).success).toBe(
        false,
      );
    }
    for (const description of ["\u001b[2Jwipe", "two\nlines", "bell\u0007", "c1\u009b31m", ""]) {
      expect(InitializeResultSchema.safeParse(result([{ name: "a", description }])).success).toBe(
        false,
      );
    }
    const many = Array.from({ length: MAX_SKILL_CATALOG + 1 }, (_, i) => ({
      name: `s${i}`,
      description: "d",
    }));
    expect(InitializeResultSchema.safeParse(result(many)).success).toBe(false);
    expect(InitializeResultSchema.safeParse(result(many.slice(1))).success).toBe(true);
    const extra = InitializeResultSchema.safeParse(
      result([{ name: "a", description: "d", extra: 1 }]),
    );
    expect(extra.success && extra.data.skills[0]).toEqual({ name: "a", description: "d" });
  });

  test("session/prompt carries an optional, spec-named skill", () => {
    const base = { sessionId: "s", turnId: "t", content: [{ type: "text", text: "/a go" }] };
    expect(PromptParamsSchema.safeParse(base).success).toBe(true);
    expect(PromptParamsSchema.safeParse({ ...base, skill: "deploy-app" }).success).toBe(true);
    expect(PromptParamsSchema.safeParse({ ...base, skill: "/deploy-app" }).success).toBe(false);
    expect(PromptParamsSchema.safeParse({ ...base, skill: "" }).success).toBe(false);
  });
});
