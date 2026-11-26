/**
 * The session-apps wire (docs/feat/session-apps-publish.md D7): the display
 * update `apps`, the snapshot field, `session/app_unpublish`.
 */
import { describe, expect, test } from "bun:test";
import * as P from "../src/index.ts";

const ROW = {
  app: "abcdefghijklmnop",
  url: "https://abcdefghijklmnop.apps.tentacle.so/",
  artifactId: "demo",
  version: 1,
  title: "Demo",
  state: "up",
  since: 1,
  publishedAt: 1,
};

describe("apps wire", () => {
  test("the `apps` update parses, an unknown state string included", () => {
    const parsed = P.SessionUpdateSchema.parse({
      type: "apps",
      apps: [ROW, { ...ROW, state: "hibernating", reason: "a newer daemon's word" }],
    });
    expect(parsed.type).toBe("apps");
    if (parsed.type === "apps") {
      expect(parsed.apps.map((r) => r.state)).toEqual(["up", "hibernating"]);
      expect(parsed.apps[1]?.reason).toBe("a newer daemon's word");
    }
    expect(P.SessionUpdateSchema.safeParse({ type: "apps", apps: [] }).success).toBe(true);
    expect(P.SessionUpdateSchema.safeParse({ type: "apps", apps: [{ app: "x" }] }).success).toBe(
      false,
    );
  });

  test("`apps` is a display update, known and never blocking", () => {
    expect(P.UPDATE_CLASS.apps).toBe("display");
    expect(P.KNOWN_UPDATE_TYPES).toContain("apps");
    expect(P.BLOCKING_UPDATE_TYPES.has("apps")).toBe(false);
  });

  test("the snapshot carries `apps` (absent = not reported)", () => {
    const base = { messages: [] };
    expect(P.SnapshotResultSchema.parse(base).apps).toBeUndefined();
    expect(P.SnapshotResultSchema.parse({ ...base, apps: [ROW] }).apps).toEqual([ROW]);
  });

  test("session/app_unpublish is registered with its params and result", () => {
    expect(P.Method.AppUnpublish).toBe("session/app_unpublish");
    const entry = P.RequestSchemas[P.Method.AppUnpublish];
    expect(entry.params.safeParse({ sessionId: "s", app: ROW.app }).success).toBe(true);
    expect(entry.params.safeParse({ sessionId: "s" }).success).toBe(false);
    expect(entry.params.safeParse({ sessionId: "s", app: "x".repeat(65) }).success).toBe(false);
    expect(entry.result.parse({ ok: false, reason: "no such app" })).toEqual({
      ok: false,
      reason: "no such app",
    });
  });

  test("one size cap for both ends: 10 MiB", () => {
    expect(P.APPS_MAX_APP_BYTES_DEFAULT).toBe(10 * 1024 * 1024);
  });
});
