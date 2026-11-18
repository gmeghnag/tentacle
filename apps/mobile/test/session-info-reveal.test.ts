/**
 * `revealSection` — where the hub's Scheduled item lands the person in Session
 * info (docs/feat/mobile-hub.md H4a: "Session info scrolled to SCHEDULED
 * WAKES").
 */
import { describe, expect, test } from "bun:test";
import type { ScheduleRow } from "@tentacle/protocol";
import {
  type InfoFacts,
  type Pull,
  REVEAL_IDLE,
  revealStart,
  revealStep,
  scheduledSection,
  sessionInfoView,
} from "../src/session-info.ts";

const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
const ready = <T>(value: T): Pull<T> => ({ state: "ready", value });
const wake = (over: Partial<ScheduleRow> = {}): ScheduleRow => ({
  id: "sc-1",
  kind: "every",
  spec: "every 10m",
  prompt: "check CI on PR #412",
  nextAt: NOW + 10 * 60_000,
  fires: 4,
  createdAt: NOW - 3_600_000,
  ...over,
});

function facts(over: Partial<InfoFacts> = {}): InfoFacts {
  return {
    phase: "open",
    link: "up",
    now: NOW,
    title: "Fix the flaky test",
    computerName: "MacBook Pro",
    daemon: { version: "1.4.0" },
    mcp: ready({ servers: [] }),
    skills: ready({ slash: [], skills: [], problems: [], moreProblems: 0 }),
    context: ready({ used: 0, exact: true }),
    entry: ready({
      sessionId: "s-1",
      title: "Fix the flaky test",
      cwd: "/Users/me/tentacle/apps",
      createdAt: 0,
      updatedAt: 0,
      running: false,
      attached: 1,
      archived: false,
      jobs: 0,
    }),
    autoAccept: false,
    ...over,
  };
}

/** An empty line kept for spacing (the sheet's own order follows). */

describe("scheduledSection: where the hub's Scheduled item lands", () => {
  test("the wakes section, when the sheet draws it", () => {
    const view = sessionInfoView(facts({ schedules: { rows: [wake()], error: null } }));
    expect(scheduledSection(view)).toBe("schedules");
  });

  test("a sheet that does NOT draw the band asks for nothing (never a scroll to empty air)", () => {
    // No feed at all: `sessionInfoView` omits the section (a port without it).
    const view = sessionInfoView(facts());
    expect(view.sections.map((s) => s.id)).not.toContain("schedules");
    expect(scheduledSection(view)).toBeNull();
    // The sheet has no value yet (the first open, before any read answered).
    expect(scheduledSection(null)).toBeNull();
  });
});

describe("revealOffset is the reveal's own rule (through revealStep)", () => {
  test("not laid out yet → null, never a scroll to a guess", () => {
    expect(revealStep(revealStart("schedules"), { id: "session", y: 220 }).scrollTo).toBeNull();
    expect(revealStep(REVEAL_IDLE, { id: "schedules", y: 440 }).scrollTo).toBeNull();
  });
});

describe("revealStep: scrolling once the wanted band has laid out", () => {
  test("a band that is not the wanted one just records its y (no scroll yet)", () => {
    const step = revealStep(revealStart("schedules"), { id: "model", y: 0 });
    expect(step.scrollTo).toBeNull();
    expect(step.state.want).toBe("schedules");
    expect(step.state.at).toEqual({ model: 0 });
  });

  test("the bands report in any order: only the wanted one's y scrolls, ONCE", () => {
    let state = revealStart("schedules");
    const first = revealStep(state, { id: "mcp", y: 620 });
    expect(first.scrollTo).toBeNull();
    state = first.state;
    const second = revealStep(state, { id: "schedules", y: 440 });
    expect(second.scrollTo).toBe(440);
    // The want is spent: a relayout (a row expanding) never yanks the person back.
    expect(second.state.want).toBeNull();
    expect(revealStep(second.state, { id: "schedules", y: 500 }).scrollTo).toBeNull();
  });

  test('a band measured at y=0 is a real offset, not "unmeasured"', () => {
    expect(revealStep(revealStart("model"), { id: "model", y: 0 }).scrollTo).toBe(0);
  });

  test("no reveal pending → the sheet never scrolls itself", () => {
    const step = revealStep(REVEAL_IDLE, { id: "schedules", y: 440 });
    expect(step.scrollTo).toBeNull();
    expect(step.state.want).toBeNull();
  });
});
