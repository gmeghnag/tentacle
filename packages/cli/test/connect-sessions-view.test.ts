import { describe, expect, test } from "bun:test";
import type { SessionListEntry, SessionListResult } from "@tentacle/protocol";
import { sessionsViewFrom } from "../src/connect.ts";

// docs/feat/mobile-session-actions.md S3: the `connect` list mapping keeps the
// daemon's pins, so the `/sessions` panel can show them (each rule names the
// mutation that turns it red, AGENTS §9). What the panel RENDERS from this view
// is `packages/tui/test/sessions-panel.test.ts`'s.

const NOW = 10 * 60_000;
const wire = (id: string, o: Partial<SessionListEntry> = {}): SessionListEntry => ({
  sessionId: id,
  title: `title ${id}`,
  cwd: "/work",
  createdAt: NOW - 9 * 60_000,
  updatedAt: NOW - 5 * 60_000,
  running: false,
  attached: 0,
  archived: false,
  ...o,
});

describe("sessionsViewFrom", () => {
  test("the entry's `pinned` reaches the view, and a page without pins carries no pin field", () => {
    // Mutation: drop the `pinned` spread → the row loses its marker.
    const view = sessionsViewFrom({
      sessions: [wire("a", { pinned: true }), wire("b")],
    } satisfies SessionListResult);
    expect(view.sessions.map((s) => [s.id, s.pinned])).toEqual([
      ["a", true],
      ["b", undefined],
    ]);
    expect(view.more).toBe(false);
    expect("pinned" in view).toBe(false);
  });

  test("the first page's `pinned` array reaches the view — a pin older than the page included", () => {
    // Mutation: drop the `result.pinned` spread → an off-page pin is invisible.
    const view = sessionsViewFrom({
      sessions: [wire("new"), wire("mid")],
      cursor: "1:mid",
      pinned: [wire("old", { pinned: true })],
    } satisfies SessionListResult);
    expect(view.pinned?.map((s) => s.id)).toEqual(["old"]);
    expect(view.more).toBe(true); // a cursor page
  });

  test("absent `pinned` stays absent (an older daemon): today's view exactly", () => {
    // Mutation: always set `pinned: []` → `"pinned" in view` true.
    const view = sessionsViewFrom({ sessions: [wire("a")] } satisfies SessionListResult);
    expect("pinned" in view).toBe(false);
    expect(view.sessions[0]).toEqual({
      id: "a",
      title: "title a",
      updatedAt: NOW - 5 * 60_000,
      running: false,
      attached: 0,
      archived: false,
    });
  });
});
