import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import * as P from "../src/index.ts";

// Namespace access: on a tree without `session/list` every case fails on its
// assertion (an absent schema parses nothing), not on a missing import.
const parses = (schema: z.ZodTypeAny | undefined, value: unknown): boolean | undefined =>
  schema?.safeParse(value).success;
const entry = (value: unknown) => parses(P.SessionListEntrySchema, value);
const params = (value: unknown) => parses(P.SessionListParamsSchema, value);
const result = (value: unknown) => parses(P.SessionListResultSchema, value);

const full = {
  sessionId: "s1",
  title: "fix the build",
  cwd: "/w/project",
  createdAt: 1,
  updatedAt: 2,
  running: false,
  attached: 0,
  archived: false,
};

describe("session/list (docs/feat/session-list.md)", () => {
  test("P1 is registered with both its schemas", () => {
    expect(P.Method.SessionList).toBe("session/list");
    const schemas = P.RequestSchemas[P.Method.SessionList];
    expect(schemas?.params).toBe(P.SessionListParamsSchema);
    expect(schemas?.result).toBe(P.SessionListResultSchema);
  });

  test("P2 an entry: every field validated; an unknown field stripped (forward compat)", () => {
    expect(entry(full)).toBe(true);
    expect(entry({ ...full, title: "" })).toBe(false);
    expect(entry({ ...full, title: "a\u001bb" })).toBe(false);
    expect(entry({ ...full, title: "t".repeat(P.MAX_SESSION_TITLE) })).toBe(true);
    expect(entry({ ...full, title: "t".repeat(P.MAX_SESSION_TITLE + 1) })).toBe(false);
    expect(entry({ ...full, cwd: "/w\u0007" })).toBe(false);
    expect(entry({ ...full, attached: -1 })).toBe(false);
    expect(entry({ ...full, updatedAt: 1.5 })).toBe(false);
    expect(entry({ ...full, archived: undefined })).toBe(false);
    const stripped = P.SessionListEntrySchema?.safeParse({ ...full, extra: 1 });
    expect(stripped?.success).toBe(true);
    expect(stripped?.success && "extra" in stripped.data).toBe(false);
  });

  test("P3 params: limit 1..MAX_SESSION_LIST, integer; cursor non-empty; both optional", () => {
    expect(params({})).toBe(true);
    expect(params({ limit: 1, cursor: "1:s" })).toBe(true);
    expect(params({ limit: P.MAX_SESSION_LIST })).toBe(true);
    expect(params({ limit: 0 })).toBe(false);
    expect(params({ limit: P.MAX_SESSION_LIST + 1 })).toBe(false);
    expect(params({ limit: 1.5 })).toBe(false);
    expect(params({ cursor: "" })).toBe(false);
  });

  test("P4 result: at most MAX_SESSION_LIST entries; cursor optional, never empty", () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...full, sessionId: `s${i}` }));
    expect(result({ sessions: [] })).toBe(true);
    expect(result({ sessions: many(1), cursor: "2:s0" })).toBe(true);
    expect(result({ sessions: many(P.MAX_SESSION_LIST) })).toBe(true);
    expect(result({ sessions: many(P.MAX_SESSION_LIST + 1) })).toBe(false);
    expect(result({ sessions: [], cursor: "" })).toBe(false);
  });
});
