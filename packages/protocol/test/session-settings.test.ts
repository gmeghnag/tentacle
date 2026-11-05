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

  test("the report: `overridden` holds validated values; a newer daemon's key is stripped", () => {
    const base = { sessionId: "s", epoch: "e", created: true, resync: false };
    expect(OpenResultSchema.parse(base).settings).toBeUndefined();
    const report = { carried: { maxIterations: 9 }, overridden: { maxIterations: 7 } };
    expect(OpenResultSchema.parse({ ...base, settings: report }).settings).toEqual(report);
    const future = { carried: {}, overridden: { keyFromTheFuture: "\u001b[31m" } };
    expect(OpenResultSchema.parse({ ...base, settings: future }).settings).toEqual({
      carried: {},
      overridden: {},
    });
    // Pod text where a number or an enum goes: its own open fails, nothing is printed.
    for (const overridden of [{ maxIterations: "\u001b[31m" }, { toolExecution: "evil" }]) {
      const bad = { carried: {}, overridden };
      expect(OpenResultSchema.safeParse({ ...base, settings: bad }).success).toBe(false);
    }
  });

  test("protocol 16: without the bump a v15 daemon would strip `settings` silently", () => {
    expect(PROTOCOL_VERSION).toBe(16);
  });
});
