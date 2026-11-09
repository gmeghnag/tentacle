import { describe, expect, test } from "bun:test";
import {
  Method,
  PROTOCOL_VERSION,
  RequestSchemas,
  SessionSettingsReportSchema,
  SessionUpdateParamsSchema,
  SessionUpdateSchema,
  UPDATE_CLASS,
  UpdateSettingsParamsSchema,
  UpdateSettingsResultSchema,
} from "../src/index.ts";

// docs/feat/session-settings-apply.md
describe("session/update_settings", () => {
  test("is registered with its params and result", () => {
    expect(Method.UpdateSettings).toBe("session/update_settings");
    expect(RequestSchemas[Method.UpdateSettings].params).toBe(UpdateSettingsParamsSchema);
    expect(RequestSchemas[Method.UpdateSettings].result).toBe(UpdateSettingsResultSchema);
  });

  test("params: the same bounds as session/open.settings; an id is required", () => {
    const params = { sessionId: "S", id: "a1", settings: { maxIterations: 3 } };
    expect(UpdateSettingsParamsSchema.parse(params)).toEqual(params);
    for (const bad of [
      { sessionId: "S", id: "a1", settings: { maxIterations: 0 } },
      { sessionId: "S", id: "a1", settings: { contextAwarenessStepPercent: 101 } },
      { sessionId: "S", settings: { maxIterations: 3 } },
      { sessionId: "S", id: "", settings: {} },
      { sessionId: "S", id: "x".repeat(129), settings: {} },
      { sessionId: "S", id: "a1" },
    ]) {
      expect(UpdateSettingsParamsSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("result: applied, with the report when the daemon honoured it", () => {
    const report = { carried: { maxIterations: 3 }, overridden: {} };
    expect(UpdateSettingsResultSchema.parse({ applied: true, settings: report })).toEqual({
      applied: true,
      settings: report,
    });
    expect(UpdateSettingsResultSchema.parse({ applied: false })).toEqual({ applied: false });
    expect(UpdateSettingsResultSchema.safeParse({ settings: report }).success).toBe(false);
  });

  test("no protocol bump: a method, a display update and a field are free", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(19);
  });
});

describe("the report's containerKeys", () => {
  test("optional, kept as names (a newer daemon's name is not a rejection)", () => {
    const report = {
      carried: {},
      overridden: {},
      containerKeys: ["maxIterations", "fromTheFuture"],
    };
    expect(SessionSettingsReportSchema.parse(report).containerKeys).toEqual([
      "maxIterations",
      "fromTheFuture",
    ]);
    expect(SessionSettingsReportSchema.parse({ carried: {}, overridden: {} })).toEqual({
      carried: {},
      overridden: {},
    });
  });

  test("bounded", () => {
    for (const containerKeys of [[""], ["x".repeat(65)], Array(65).fill("k")]) {
      const bad = { carried: {}, overridden: {}, containerKeys };
      expect(SessionSettingsReportSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe("the session_settings update", () => {
  test("a display update carrying the report and the applier's id", () => {
    expect(UPDATE_CLASS.session_settings).toBe("display");
    const update = {
      type: "session_settings" as const,
      settings: { carried: { maxIterations: 3 }, overridden: {} },
      id: "a1",
    };
    expect(SessionUpdateSchema.parse(update)).toEqual(update);
    const frame = SessionUpdateParamsSchema.parse({ sessionId: "S", seq: 4, update });
    expect(frame.update).toEqual(update);
    expect(frame.mandatory).toBeUndefined();
  });

  test("a malformed report is refused", () => {
    const bad = {
      type: "session_settings",
      settings: { carried: { maxIterations: "lots" }, overridden: {} },
    };
    expect(SessionUpdateSchema.safeParse(bad).success).toBe(false);
  });
});
