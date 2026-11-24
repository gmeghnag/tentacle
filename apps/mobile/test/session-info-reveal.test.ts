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
    expect(scheduledSection(view, 1)).toBe("schedules");
  });

  test("a sheet that does NOT draw the band asks for nothing (never a scroll to empty air)", () => {
    // No feed at all: `sessionInfoView` omits the section (a port without it).
    const view = sessionInfoView(facts());
    expect(view.sections.map((s) => s.id)).not.toContain("schedules");
    expect(scheduledSection(view, 0)).toBeNull();
    // The sheet has no value yet and the session knows of no wake: nothing to land on.
    expect(scheduledSection(null, 0)).toBeNull();
  });

  test("the wakes the session KNOWS OF win over a sheet value pulled before them", () => {
    // docs/feat/mobile-native-sheets.md, Fix round (simulator): the hub's Scheduled
    // item exists only when the session has wakes, but the sheet's value can be
    // older than the wake (pulled before it was created) and lack the band. The
    // app log at the tap read `T=null`, sections `model,session,mcp,skills`, and 1
    // wake (gate run 1795475314390, flow 34-hub-scheduled): no reveal, so the native
    // sheet opened at M on the top band. The open re-pulls the facts, and
    // `revealStep` scrolls only once the band reports its y — never to empty air.
    const stale = sessionInfoView(facts());
    expect(stale.sections.map((s) => s.id)).not.toContain("schedules");
    expect(scheduledSection(stale, 1)).toBe("schedules");
    // No value at all yet (the first open): the same.
    expect(scheduledSection(null, 1)).toBe("schedules");
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
