/**
 * The reveal's TRACKER, and the batched layout pass that broke it
 * (docs/feat/mobile-hub.md H4a, fix round 1 finding M1).
 *
 * `session-info-reveal.test.ts` proves the RULE (`revealStep`): one report, one
 * state, one scroll. It could not prove the caller feeds it correctly, and the
 * screen fed it a render VALUE — so every band's `onLayout` in one pass folded
 * onto the same stale state, the last write won, the want was never spent, and
 * the sheet yanked the person back to the wakes band on every relayout above it.
 *
 * These tests drive a whole PASS (every band reporting, in tree order) through
 * the tracker the screen now uses, so the property M1 was missing is the one
 * asserted: the wanted band is reached ONCE and then never again.
 */
import { describe, expect, test } from "bun:test";
import { reportReveal, startReveal, trackReveal } from "../src/reveal-report.ts";
import type { SectionId } from "../src/session-info.ts";

/** The sheet's bands in TREE ORDER, with distinct ys (schedules is third). */
const BANDS: readonly { readonly id: SectionId; readonly y: number }[] = [
  { id: "model", y: 0 },
  { id: "session", y: 180 },
  { id: "schedules", y: 420 },
  { id: "mcp", y: 640 },
  { id: "skills", y: 900 },
];

/** Drive ONE layout pass: every band reports, in order, exactly as a real one does. */
function pass(
  track: ReturnType<typeof trackReveal>,
  scrolls: number[],
  bands: readonly { readonly id: SectionId; readonly y: number }[] = BANDS,
): void {
  for (const band of bands) {
    reportReveal(track, band, (y) => {
      scrolls.push(y);
    });
  }
}

describe("reveal tracker: a batched pass scrolls ONCE, to the wanted band (M1)", () => {
  test("five bands report in one pass: one scroll, to the wakes band", () => {
    const track = trackReveal();
    startReveal(track, "schedules");
    const scrolls: number[] = [];
    pass(track, scrolls);
    // THE BUG: folding against a render value kept the last write, which still
    // had `want: "schedules"`, so this was either no scroll or a repeated one.
    expect(scrolls).toEqual([420]);
    // …and the want is SPENT: that is what stops the yank-back below.
    expect(track.current.want).toBeNull();
  });

  test("a relayout after the reveal never scrolls again (the person's own scrolling wins)", () => {
    const track = trackReveal();
    startReveal(track, "schedules");
    const scrolls: number[] = [];
    pass(track, scrolls);
    // Something above the band moved: a pull landed, or a row was expanded, so a
    // band's y changed and it reports again. The sheet must stay where it is.
    const moved = BANDS.map((band) => (band.id === "session" ? { ...band, y: 200 } : band));
    pass(track, scrolls, moved);
    pass(track, scrolls, [...moved, { id: "schedules", y: 440 }]);
    expect(scrolls).toEqual([420]);
  });

  test("the bands report in any order: the wanted one's y still lands once", () => {
    const track = trackReveal();
    startReveal(track, "skills");
    const scrolls: number[] = [];
    pass(track, scrolls, [
      { id: "skills", y: 900 },
      { id: "model", y: 0 },
      { id: "schedules", y: 420 },
    ]);
    expect(scrolls).toEqual([900]);
    expect(track.current.want).toBeNull();
  });

  test("one report at a time (no batching) behaves identically", () => {
    const track = trackReveal();
    startReveal(track, "mcp");
    const scrolls: number[] = [];
    for (const band of BANDS) {
      pass(track, scrolls, [band]);
    }
    expect(scrolls).toEqual([640]);
  });
});

describe("reveal tracker: the sheet's other paths", () => {
  test("nothing wanted (a sheet with no wakes band): no scroll, never a guess", () => {
    const track = trackReveal();
    startReveal(track, null);
    const scrolls: number[] = [];
    pass(track, scrolls);
    expect(scrolls).toEqual([]);
    // The ys are still recorded, so a later want needs no second pass to see one.
    expect(track.current.at).toEqual({
      model: 0,
      session: 180,
      schedules: 420,
      mcp: 640,
      skills: 900,
    });
  });

  test("a y of 0 is a real offset, not 'unmeasured'", () => {
    const track = trackReveal();
    startReveal(track, "model");
    const scrolls: number[] = [];
    pass(track, scrolls, [{ id: "model", y: 0 }]);
    expect(scrolls).toEqual([0]);
  });

  test("a second open scrolls again (the tracker is reset by the new request)", () => {
    const track = trackReveal();
    startReveal(track, "schedules");
    const scrolls: number[] = [];
    pass(track, scrolls);
    startReveal(track, "skills");
    pass(track, scrolls);
    expect(scrolls).toEqual([420, 900]);
  });

  test("a second open re-measures: it never scrolls to the PREVIOUS open's y", () => {
    // The sheet grew above the band since the last open (a pull landed, a row was
    // expanded). A tracker that carried the old offsets would scroll to the stale
    // y on the pass's FIRST report, landing the person in the wrong place.
    const track = trackReveal();
    startReveal(track, "schedules");
    const first: number[] = [];
    pass(track, first);
    expect(first).toEqual([420]);
    startReveal(track, "schedules");
    const second: number[] = [];
    pass(track, second, [
      { id: "model", y: 0 },
      { id: "session", y: 260 },
      { id: "schedules", y: 520 },
      { id: "mcp", y: 740 },
    ]);
    expect(second).toEqual([520]);
  });

  test("a request with no layout at all never scrolls (the person lands at the top)", () => {
    // The sheet was closed before its bands reported: nothing to scroll to, and
    // the next open starts clean.
    const track = trackReveal();
    startReveal(track, "schedules");
    expect(track.current.want).toBe("schedules");
    expect(track.current.at).toEqual({});
  });

  test("the scroll is issued DURING the report, for that step's y only", () => {
    // The side effect is the caller's, taken out of any React updater: it fires
    // once, with the step's own y, and never for a band that merely came first.
    const track = trackReveal();
    startReveal(track, "schedules");
    const seen: number[] = [];
    reportReveal(track, { id: "model", y: 0 }, (y) => {
      seen.push(y);
    });
    expect(seen).toEqual([]); // measured, not wanted: no scroll yet
    reportReveal(track, { id: "schedules", y: 420 }, (y) => {
      seen.push(y);
    });
    expect(seen).toEqual([420]); // the wanted band: the one scroll
  });
});
