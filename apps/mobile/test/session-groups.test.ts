/**
 * The Sessions screen's grouping (mockup `Sessions`, plan Design 3): the active
 * rows split into Running and Idle, Archived kept; an inline meta line instead
 * of filled badges; and the search field (owner decision 2) that filters the
 * list on the phone. A pure regroup of `session-list.ts`'s rows — no new data.
 */
import { describe, expect, test } from "bun:test";
import { groupSessions, sessionMeta } from "../src/session-groups.ts";
import type { SessionRow } from "../src/session-list.ts";

const row = (over: Partial<SessionRow> & { sessionId: string }): SessionRow => ({
  title: over.sessionId,
  subtitle: "5m ago",
  badges: [],
  archived: false,
  running: false,
  attached: 0,
  ...over,
});

const a = row({ sessionId: "a", title: "Fix the flaky test", running: true, attached: 2 });
const b = row({ sessionId: "b", title: "Refactor parser" });
const c = row({ sessionId: "c", title: "Docs pass", running: true });
const z = row({ sessionId: "z", title: "Old spike", archived: true, subtitle: "3d ago" });
const sections = { active: [a, b, c], archived: [z] };

describe("groupSessions", () => {
  test("active rows split into Running and Idle, each in the daemon's order; Archived kept", () => {
    const groups = groupSessions(sections, "");
    expect(groups.running.map((r) => r.sessionId)).toEqual(["a", "c"]);
    expect(groups.idle.map((r) => r.sessionId)).toEqual(["b"]);
    expect(groups.archived.map((r) => r.sessionId)).toEqual(["z"]);
    expect(groups.noMatch).toBe(false);
  });

  test("the search filters every section by title, case- and space-insensitive", () => {
    const groups = groupSessions(sections, "  FLAKY ");
    expect(groups.running.map((r) => r.sessionId)).toEqual(["a"]);
    expect(groups.idle).toEqual([]);
    expect(groups.archived).toEqual([]);
    expect(groupSessions(sections, "spike").archived.map((r) => r.sessionId)).toEqual(["z"]);
  });

  test("a search with no hit says so (noMatch), an empty list with no search does not", () => {
    expect(groupSessions(sections, "nothing like it").noMatch).toBe(true);
    expect(groupSessions({ active: [], archived: [] }, "").noMatch).toBe(false);
  });
});

describe("sessionMeta (the inline line under a title)", () => {
  test("running, with the attached count and the time", () => {
    expect(sessionMeta(a)).toBe("Running · 2 attached · 5m ago");
  });
  test("idle with one client attached", () => {
    expect(sessionMeta(row({ sessionId: "x", attached: 1 }))).toBe("Idle · 1 attached · 5m ago");
  });
  test("idle with none attached shows only the time", () => {
    expect(sessionMeta(b)).toBe("Idle · 5m ago");
  });
  test("archived", () => {
    expect(sessionMeta(z)).toBe("Archived · 3d ago");
  });
});
