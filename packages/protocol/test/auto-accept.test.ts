import { describe, expect, test } from "bun:test";
import {
  Method,
  OpenParamsSchema,
  OpenResultSchema,
  PROTOCOL_VERSION,
  RequestSchemas,
  SessionUpdateSchema,
  SetAutoAcceptParamsSchema,
  SetAutoAcceptResultSchema,
  UPDATE_CLASS,
  SessionUpdateSchema as Union,
} from "../src/index.ts";

// docs/feat/session-auto-accept.md — slice 1 (protocol).
describe("session/set_auto_accept", () => {
  test("is registered with its params and result", () => {
    expect(Method.SetAutoAccept).toBe("session/set_auto_accept");
    expect(RequestSchemas[Method.SetAutoAccept].params).toBe(SetAutoAcceptParamsSchema);
    expect(RequestSchemas[Method.SetAutoAccept].result).toBe(SetAutoAcceptResultSchema);
  });

  test("params: a session and a boolean `on`, nothing else", () => {
    expect(SetAutoAcceptParamsSchema.parse({ sessionId: "S", on: true })).toEqual({
      sessionId: "S",
      on: true,
    });
    expect(SetAutoAcceptParamsSchema.parse({ sessionId: "S", on: false })).toEqual({
      sessionId: "S",
      on: false,
    });
    // An unknown extra field is stripped (forward compat, protocol 10).
    expect(SetAutoAcceptParamsSchema.parse({ sessionId: "S", on: true, by: "x" })).toEqual({
      sessionId: "S",
      on: true,
    });
    for (const bad of [
      { sessionId: "S" },
      { sessionId: "S", on: "true" },
      { sessionId: "S", on: 1 },
      { sessionId: "S", on: null },
      { on: true },
      { sessionId: "", on: true },
    ]) {
      expect(SetAutoAcceptParamsSchema.safeParse(bad).success).toBe(false);
    }
  });

  test("result: the session's value after applying", () => {
    expect(SetAutoAcceptResultSchema.parse({ on: true })).toEqual({ on: true });
    expect(SetAutoAcceptResultSchema.safeParse({}).success).toBe(false);
    expect(SetAutoAcceptResultSchema.safeParse({ on: "off" }).success).toBe(false);
  });

  test("the `auto_accept` update is a display class", () => {
    expect(UPDATE_CLASS.auto_accept).toBe("display");
    expect(
      SessionUpdateSchema.safeParse({ type: "auto_accept", on: true, by: "laptop" }).success,
    ).toBe(true);
    expect(SessionUpdateSchema.safeParse({ type: "auto_accept", on: false }).success).toBe(true);
    // `on` is required; a bad `by` is refused rather than trusted.
    expect(SessionUpdateSchema.safeParse({ type: "auto_accept" }).success).toBe(false);
    expect(
      SessionUpdateSchema.safeParse({ type: "auto_accept", on: true, by: "x".repeat(65) }).success,
    ).toBe(false);
    // An unknown extra field is stripped, never an error.
    const parsed = Union.parse({ type: "auto_accept", on: true, extra: 1 });
    expect(parsed).toEqual({ type: "auto_accept", on: true });
  });

  test("OpenParams.autoAccept seeds a created session; OpenResult.autoAccept is the snapshot", () => {
    expect(OpenParamsSchema.parse({ create: true, autoAccept: true })).toEqual({
      create: true,
      autoAccept: true,
    });
    expect(OpenParamsSchema.parse({ create: true })).toEqual({ create: true });
    expect(OpenParamsSchema.safeParse({ autoAccept: "on" }).success).toBe(false);

    const base = { sessionId: "S", epoch: "e", created: false, resync: false };
    expect(OpenResultSchema.parse({ ...base, autoAccept: true })).toEqual({
      ...base,
      autoAccept: true,
    });
    // An older daemon sends neither; absent is legal and means "not shared".
    expect(OpenResultSchema.parse(base)).toEqual(base);
    expect(OpenResultSchema.safeParse({ ...base, autoAccept: 1 }).success).toBe(false);
  });

  test("no protocol bump: a method, a display update and optional fields are free", () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(19);
  });
});
