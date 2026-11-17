/**
 * The Sessions screen's grouping (mockup `Sessions`, plan Design 3): the active
 * rows split into Running and Idle, Archived kept; an inline meta line instead
 * of filled badges; and the search field (owner decision 2) that filters the
 * list on the phone. A pure regroup of `session-list.ts`'s rows — no new data.
 */
import { describe, expect, test } from "bun:test";
import { groupSessions, sessionLine, sessionMeta } from "../src/session-groups.ts";
import type { SessionRow } from "../src/session-list.ts";

const row = (over: Partial<SessionRow> & { sessionId: string }): SessionRow => ({
  title: over.sessionId,
  subtitle: "5m ago",
  badges: [],
  wakes: 0,
  archived: false,
  running: false,
  attached: 0,
  pinned: false,
  ...over,
});

const a = row({ sessionId: "a", title: "Fix the flaky test", running: true, attached: 2 });
const b = row({ sessionId: "b", title: "Refactor parser" });
const c = row({ sessionId: "c", title: "Docs pass", running: true });
const z = row({ sessionId: "z", title: "Old spike", archived: true, subtitle: "3d ago" });
const sections = { pinned: [], active: [a, b, c], archived: [z] };

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
    expect(groupSessions({ pinned: [], active: [], archived: [] }, "").noMatch).toBe(false);
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
  test("armed wakes are named on the line a person reads (cron-tool S6, M8)", () => {
    expect(sessionMeta(row({ sessionId: "w", wakes: 2 }))).toBe("Idle · 2 wakes · 5m ago");
    expect(sessionMeta(row({ sessionId: "w", wakes: 1, attached: 1 }))).toBe(
      "Idle · 1 attached · 1 wake · 5m ago",
    );
    // An archived session's wakes are frozen and never fire: they earn no word.
    expect(sessionMeta(row({ sessionId: "w", archived: true, wakes: 3 }))).toBe(
      "Archived · 5m ago",
    );
  });
});

describe("sessionLine (the row's visible line, under its section header)", () => {
  test("Running keeps its state word (the accent dot carries meaning)", () => {
    expect(sessionLine(a)).toBe("Running · 2 attached · 5m ago");
  });
  test("an Idle row does not repeat its section's name", () => {
    expect(sessionLine(row({ sessionId: "x", attached: 1 }))).toBe("1 attached · 5m ago");
    expect(sessionLine(b)).toBe("5m ago");
  });
  test("an Archived row does not repeat its section's name", () => {
    expect(sessionLine(z)).toBe("3d ago");
  });
});

describe("the Pinned group (docs/feat/mobile-session-actions.md S2)", () => {
  // The real projector keeps a pin in `active` too (`session-list.ts` `rows()`),
  // so the hoist has to be pinned against THAT shape: the same row in both.
  const p = row({ sessionId: "p", title: "Pinned spike", pinned: true, running: true });
  const pinned = { pinned: [p], active: [p, a, b, c], archived: [z] };
  test("a pinned row is hoisted into its own group, first, and leaves Running/Idle", () => {
    const groups = groupSessions(pinned, "");
    expect(groups.pinned.map((r) => r.sessionId)).toEqual(["p"]);
    // `p` is a RUNNING row in `active`: without the hoist it would be here twice.
    expect(groups.running.map((r) => r.sessionId)).toEqual(["a", "c"]);
    expect(groups.idle.map((r) => r.sessionId)).toEqual(["b"]);
  });

  test("the search filters Pinned too, and a pinned hit alone is not 'no matches'", () => {
    expect(groupSessions(pinned, "spike").pinned.map((r) => r.sessionId)).toEqual(["p"]);
    expect(groupSessions(pinned, "spike").noMatch).toBe(false);
    expect(groupSessions(pinned, "spike").running).toEqual([]);
    expect(groupSessions(pinned, "nothing like it").noMatch).toBe(true);
  });

  test("a search ONLY a pinned row matches is not 'no matches' (review finding 1)", () => {
    // "Old spike" (z, archived, not pinned) does not match "pinned spike", so
    // nothing outside the Pinned group matches: before the fix `noMatch` summed
    // only active + archived and said "No matches" above a visible pinned row.
    const groups = groupSessions(pinned, "pinned spike");
    expect(groups.pinned.map((r) => r.sessionId)).toEqual(["p"]);
    expect(groups.running).toEqual([]);
    expect(groups.idle).toEqual([]);
    expect(groups.archived).toEqual([]);
    expect(groups.noMatch).toBe(false);
  });

  test("a pinned archived row shows in Pinned, not in Archived (Owner Q3)", () => {
    const old = row({ sessionId: "z2", archived: true, pinned: true });
    const groups = groupSessions({ pinned: [old], active: [a], archived: [z, old] }, "");
    expect(groups.pinned.map((r) => r.sessionId)).toEqual(["z2"]);
    expect(groups.archived.map((r) => r.sessionId)).toEqual(["z"]);
  });

  test("no pins: the groups are exactly the sections, in the same order", () => {
    const groups = groupSessions({ pinned: [], active: [a, b, c], archived: [z] }, "");
    expect(groups.pinned).toEqual([]);
    expect(groups.running.map((r) => r.sessionId)).toEqual(["a", "c"]);
  });
});
