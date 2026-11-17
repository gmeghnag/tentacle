import { describe, expect, test } from "bun:test";
import {
  MAX_PINNED_SESSIONS,
  Method,
  PinParamsSchema,
  PinResultSchema,
  RequestSchemas,
  SessionListEntrySchema,
  SessionListResultSchema,
} from "../src/index.ts";

// `session/pin` (docs/feat/mobile-session-actions.md S1): additive — a new
// method, an optional entry flag, an optional first-page array.

const entry = (id: string, extra: Record<string, unknown> = {}) => ({
  sessionId: id,
  title: "t",
  cwd: "/w",
  createdAt: 1,
  updatedAt: 1,
  running: false,
  attached: 0,
  archived: false,
  ...extra,
});

describe("session/pin schemas", () => {
  test("registered in the method table", () => {
    expect(Method.Pin).toBe("session/pin");
    expect(RequestSchemas[Method.Pin].params).toBe(PinParamsSchema);
    expect(RequestSchemas[Method.Pin].result).toBe(PinResultSchema);
  });

  test("params: a session id and a boolean set (never a toggle)", () => {
    expect(PinParamsSchema.safeParse({ sessionId: "s", pinned: true }).success).toBe(true);
    expect(PinParamsSchema.safeParse({ sessionId: "s", pinned: false }).success).toBe(true);
    expect(PinParamsSchema.safeParse({ sessionId: "s" }).success).toBe(false);
    expect(PinParamsSchema.safeParse({ sessionId: "s", pinned: "yes" }).success).toBe(false);
    expect(PinParamsSchema.safeParse({ pinned: true }).success).toBe(false);
    expect(PinResultSchema.safeParse({ pinned: true }).success).toBe(true);
    expect(PinResultSchema.safeParse({}).success).toBe(false);
  });

  test("entry `pinned` is exactly `true` when present; absent = not pinned", () => {
    expect(SessionListEntrySchema.safeParse(entry("a", { pinned: true })).success).toBe(true);
    expect(SessionListEntrySchema.safeParse(entry("a")).success).toBe(true);
    expect(SessionListEntrySchema.safeParse(entry("a", { pinned: false })).success).toBe(false);
  });

  test(`result \`pinned\` is bounded by MAX_PINNED_SESSIONS (${MAX_PINNED_SESSIONS})`, () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => entry(`p${i}`, { pinned: true }));
    const ok = { sessions: [], pinned: many(MAX_PINNED_SESSIONS) };
    const over = { sessions: [], pinned: many(MAX_PINNED_SESSIONS + 1) };
    expect(SessionListResultSchema.safeParse(ok).success).toBe(true);
    expect(SessionListResultSchema.safeParse(over).success).toBe(false);
    expect(SessionListResultSchema.safeParse({ sessions: [] }).success).toBe(true);
  });
});
