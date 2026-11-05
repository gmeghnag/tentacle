import { describe, expect, test } from "bun:test";
import {
  OpenParamsSchema,
  OpenResultSchema,
  PROTOCOL_VERSION,
  SessionContextParamsSchema,
  SessionSettingsSchema,
  SessionSkillsParamsSchema,
} from "../src/index.ts";

const ok = (settings: unknown) => SessionSettingsSchema.safeParse(settings).success;

describe("session/open.settings (docs/feat/config-carry.md)", () => {
  test("every carrier keeps `settings`, unknown fields inside it are stripped", () => {
    const settings = { maxIterations: 99, fromTheFuture: true };
    expect(OpenParamsSchema.parse({ create: true, settings }).settings).toEqual({
      maxIterations: 99,
    });
    expect(SessionContextParamsSchema.parse({ settings }).settings).toEqual({ maxIterations: 99 });
    expect(SessionSkillsParamsSchema.parse({ settings }).settings).toEqual({ maxIterations: 99 });
  });

  test("each config boundary is accepted", () => {
    for (const settings of [
      { maxIterations: -1 },
      { subagentMaxIterations: -1 },
      { contextResetMaxPerMessage: -1 },
      { maxIterations: 1 },
      { maxInlineOutputChars: 0 },
      { contextAwarenessStepPercent: 1 },
      { contextAwarenessStepPercent: 100 },
      { contextWindow: 1 },
      { toolMaxParallel: 1 },
      { subagentMaxParallel: 1 },
      { toolExecution: "sequential" },
      { toolExecution: "read-only" },
      { toolExecution: "parallel" },
      { subagentExecution: "sequential" },
      { subagentExecution: "read-only" },
      { subagentExecution: "parallel" },
      { agentTaskDescription: "x" },
      { agentTaskDescription: "x".repeat(4096) },
    ]) {
      expect(ok(settings)).toBe(true);
    }
  });

  test("each out-of-bound value is refused", () => {
    for (const settings of [
      { maxIterations: 0 },
      { maxIterations: -2 },
      { maxIterations: 1.5 },
      { subagentMaxIterations: 0 },
      { contextResetMaxPerMessage: 0 },
      { maxInlineOutputChars: -1 },
      { contextAwarenessStepPercent: 0 },
      { contextAwarenessStepPercent: 101 },
      { contextWindow: 0 },
      { toolMaxParallel: 0 },
      { subagentMaxParallel: 0 },
      { toolExecution: "wild" },
      { subagentExecution: "wild" },
      { autoTitle: "yes" },
      { agentTaskDescription: "" },
      { agentTaskDescription: "x".repeat(4097) },
    ]) {
      expect(ok(settings)).toBe(false);
    }
  });

  test("the report: `overridden` is bounded names, so a newer daemon's key cannot reject an open", () => {
    const base = { sessionId: "s", epoch: "e", created: true, resync: false };
    expect(OpenResultSchema.parse(base).settings).toBeUndefined();
    const report = { carried: { maxIterations: 9 }, overridden: ["key-from-the-future"] };
    expect(OpenResultSchema.parse({ ...base, settings: report }).settings).toEqual(report);
    const tooMany = { carried: {}, overridden: Array.from({ length: 65 }, (_, i) => `k${i}`) };
    expect(OpenResultSchema.safeParse({ ...base, settings: tooMany }).success).toBe(false);
    const control = { carried: {}, overridden: ["\u001b[31m"] };
    expect(OpenResultSchema.safeParse({ ...base, settings: control }).success).toBe(false);
  });

  test("protocol 16: without the bump a v15 daemon would strip `settings` silently", () => {
    expect(PROTOCOL_VERSION).toBe(16);
  });
});
