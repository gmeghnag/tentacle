/**
 * docs/feat/mobile-hub.md H3 — the pure seam between the Session screen and the
 * hub: the context it reads, the menu it solves at the open, the finger's point
 * in band coordinates, and when a world change cancels an open fan.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta, ScheduleRow } from "@tentacle/protocol";
import { NOTHING_SEEN, markArtifactOpened, markGalleryOpened } from "../src/artifact-seen-store.ts";
import { FLOAT_SIZE, place } from "../src/floating-button.ts";
import { DUE_SOON_MS, buttonBadge, hubActions, hubOpen } from "../src/hub-actions.ts";
import { ITEM_SIZE } from "../src/hub-fan.ts";
import { LONG_MS } from "../src/hub-gesture.ts";
import {
  bandPoint,
  commitPlan,
  createHubDriver,
  hubA11yActions,
  hubA11yRoute,
  hubContextOf,
  isFanOpen,
  mustCancel,
  solveHub,
  wakeContext,
} from "../src/hub-session.ts";

const BAND = { width: 390, height: 600 };
const noop = () => {};
const ENTRIES = { attach: noop, activity: noop, sessions: noop, info: noop };
const idle = hubContextOf({
  link: "up",
  turn: null,
  ended: null,
  editable: true,
  dictation: false,
});

describe("hubContextOf", () => {
  test("carries the screen's facts; what H4b owns starts empty", () => {
    expect(idle).toEqual({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      schedules: 0,
      nextWakeInMs: null,
      unseenArtifacts: 0,
      activityEmpty: false,
    });
  });

  test("`dictation` is the setting's value, not a constant (Review round 3's survivor)", () => {
    // The Dictate entry is offered from it (`hub-actions.ts:120`), so a
    // hard-coded `false` hides Dictate even with the setting on. Both directions,
    // because a hard-coded `true` would be the same bug mirrored.
    const withIt = (dictation: boolean) =>
      hubContextOf({ link: "up", turn: null, ended: null, editable: true, dictation });
    expect(withIt(true).dictation).toBe(true);
    expect(withIt(false).dictation).toBe(false);
  });
});

const NOW = new Date(2026, 10, 17, 12, 0, 0).getTime();
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

describe("wakeContext — the daemon's wake table, as the hub reads it (H4a)", () => {
  test("no table (an older daemon, or a pod's dropped one) → no wakes, so no item (M9/P6)", () => {
    expect(wakeContext(undefined, NOW)).toEqual({ schedules: 0, nextWakeInMs: null });
    expect(wakeContext([], NOW)).toEqual({ schedules: 0, nextWakeInMs: null });
  });

  test("the count is the table's length, and the next wake is the SOONEST one", () => {
    // The daemon's order is not the firing order: a one-shot may come first in
    // its table and still fire after a recurring wake's next turn.
    const rows = [
      wake({ id: "sc-1", nextAt: NOW + 40 * 60_000 }),
      wake({ id: "sc-2", kind: "at", nextAt: NOW + 5 * 60_000 }),
      wake({ id: "sc-3", nextAt: NOW + 20 * 60_000 }),
    ];
    expect(wakeContext(rows, NOW)).toEqual({ schedules: 3, nextWakeInMs: 5 * 60_000 });
  });

  test('a wake already due reads 0 ms, never a negative "in −40 s"', () => {
    expect(wakeContext([wake({ nextAt: NOW - 40_000 })], NOW)).toEqual({
      schedules: 1,
      nextWakeInMs: 0,
    });
  });

  test("one wake inside the badge window is what promotes the item", () => {
    const soon = hubContextOf({
      link: "up",
      turn: null,
      ended: null,
      editable: true,
      dictation: false,
      schedules: { rows: [wake({ nextAt: NOW + DUE_SOON_MS - 1_000 })], now: NOW },
    });
    expect(soon).toMatchObject({ schedules: 1, nextWakeInMs: DUE_SOON_MS - 1_000 });
    // End to end: the daemon's table alone makes the item appear, badged, first.
    const a = hubActions(soon, { ...ENTRIES, scheduled: noop });
    expect(a.all.map((i) => i.id)).toEqual(["scheduled", "attach", "activity", "sessions", "info"]);
    expect(a.all[0]?.badge).toEqual({ kind: "dot" });
    expect(a.all[0]?.label).toBe("Scheduled");
  });
});

const art = (artifactId: string, version: number, createdAt: number): ArtifactMeta => ({
  artifactId,
  version,
  sha256: `${artifactId}${version}`.padEnd(64, "a"),
  size: 1_000,
  mimeType: "image/png",
  kind: "image",
  title: artifactId,
  callId: `c-${artifactId}-${version}`,
  createdAt,
});
const withArtifacts = (list: readonly ArtifactMeta[] | undefined, seen = NOTHING_SEEN) =>
  hubContextOf({
    link: "up",
    turn: null,
    ended: null,
    editable: true,
    dictation: false,
    artifacts: { list, seen },
  });

describe("hubContextOf — the session's artifacts, as the hub reads them (H4b)", () => {
  test("no feed (an older daemon, or none listed yet) → 0, so the item shows unbadged", () => {
    expect(withArtifacts(undefined).unseenArtifacts).toBe(0);
    expect(withArtifacts([]).unseenArtifacts).toBe(0);
    const a = hubActions(withArtifacts([]), { ...ENTRIES, artifacts: noop });
    expect(a.all.find((i) => i.id === "artifacts")?.badge).toBeNull();
  });

  test("the count is ARTIFACTS with something new (the gallery's own rule), not versions", () => {
    const list = [art("a", 1, NOW - 60_000), art("a", 2, NOW), art("b", 1, NOW)];
    expect(withArtifacts(list).unseenArtifacts).toBe(2);
  });

  test("what this device has seen is honoured: opening the gallery clears it, a new version re-badges", () => {
    const list = [art("report", 1, NOW - 60_000)];
    const opened = markGalleryOpened(NOTHING_SEEN, NOW);
    expect(withArtifacts(list, opened).unseenArtifacts).toBe(0);
    expect(withArtifacts([...list, art("report", 2, NOW + 1)], opened).unseenArtifacts).toBe(1);
    const viewed = markArtifactOpened(NOTHING_SEEN, list[0]?.sha256 ?? "");
    expect(withArtifacts(list, viewed).unseenArtifacts).toBe(0);
  });

  test("an unseen artifact badges the item with its count and promotes it (flow 29's step)", () => {
    const ctx = withArtifacts([art("a", 1, NOW), art("b", 1, NOW), art("c", 1, NOW)]);
    const a = hubActions(ctx, { ...ENTRIES, artifacts: noop });
    expect(a.all[0]?.id).toBe("artifacts");
    expect(a.all[0]?.badge).toEqual({ kind: "count", n: 3 });
    expect(
      buttonBadge({ running: 0, unseenArtifacts: ctx.unseenArtifacts, unreadReport: false }),
    ).toEqual({ kind: "dot" });
  });

  test("no `artifacts` entry (no router on the screen) → no item, whatever the count (P6)", () => {
    const a = hubActions(withArtifacts([art("a", 1, NOW)]), ENTRIES);
    expect(a.all.some((i) => i.id === "artifacts")).toBe(false);
  });
});

describe("solveHub — the fan solved at the open", () => {
  const items = hubActions(idle, ENTRIES).fan;
  const ids = (list: readonly { id: string }[]) => list.map((i) => i.id);

  test("anchored on the button's centre, in band coordinates, one id per item in fan order", () => {
    const menu = solveHub({ bounds: BAND, position: undefined, items });
    expect(menu.ids).toEqual(["attach", "activity", "sessions", "info"]);
    expect(menu.dimmed).toEqual([]);
    expect(menu.layout.kind).toBe("fan");
    const at = place(undefined, BAND);
    if (menu.layout.kind !== "fan" || at === null) {
      throw new Error("expected a fan");
    }
    expect(menu.layout.anchor).toEqual({ x: at.x + FLOAT_SIZE / 2, y: at.y + FLOAT_SIZE / 2 });
    expect(menu.layout.edge).toBe("right");
    expect(menu.layout.items).toHaveLength(4);
    for (const it of menu.layout.items) {
      expect(it.x - ITEM_SIZE / 2).toBeGreaterThanOrEqual(0);
      expect(it.x + ITEM_SIZE / 2).toBeLessThanOrEqual(BAND.width);
      expect(it.y - ITEM_SIZE / 2).toBeGreaterThanOrEqual(0);
      expect(it.y + ITEM_SIZE / 2).toBeLessThanOrEqual(BAND.height);
    }
  });

  test("a left-edge button fans to the right (the mirror)", () => {
    const menu = solveHub({ bounds: BAND, position: { edge: "left", yFraction: 0.5 }, items });
    if (menu.layout.kind !== "fan") {
      throw new Error("expected a fan");
    }
    expect(menu.layout.edge).toBe("left");
    for (const it of menu.layout.items) {
      expect(it.x).toBeGreaterThan(menu.layout.anchor.x);
    }
  });

  test("no band yet, or a band too short for the button → the menu (never a guessed fan)", () => {
    expect(solveHub({ bounds: null, position: undefined, items }).layout.kind).toBe("menu");
    expect(
      solveHub({ bounds: { width: 390, height: 80 }, position: undefined, items }).layout.kind,
    ).toBe("menu");
  });

  test("the dimmed snapshot is carried: the open decides the cue, the release the action", () => {
    const dimmed = hubActions({ ...idle, activityEmpty: true }, ENTRIES).fan;
    // The fan layout carries it, and the item keeps its slot (same ids, same order).
    const menu = solveHub({ bounds: BAND, position: undefined, items: dimmed });
    expect(menu.ids).toEqual(ids(hubActions(idle, ENTRIES).fan));
    expect(menu.dimmed).toEqual(["activity"]);
    // No band: the menu layout carries it too (a dimmed commit plays `light` there).
    expect(solveHub({ bounds: null, position: undefined, items: dimmed }).dimmed).toEqual([
      "activity",
    ]);
  });
});

describe("bandPoint — the finger in band coordinates", () => {
  test("the touch's spot on the button + how far the finger moved on the page", () => {
    expect(
      bandPoint({ buttonAt: { x: 326, y: 500 }, local: { x: 20, y: 30 } }, { x: 0, y: 0 }),
    ).toEqual({
      x: 346,
      y: 530,
    });
    expect(
      bandPoint({ buttonAt: { x: 326, y: 500 }, local: { x: 20, y: 30 } }, { x: -150, y: -40 }),
    ).toEqual({ x: 196, y: 490 });
  });
});

describe("mustCancel — a world change closes an open fan (M6, M10, M15)", () => {
  const world = { shown: true, voiceOver: false, width: 390, height: 600 };
  test("nothing changed → keep it", () => {
    expect(mustCancel(world, { ...world })).toBe(false);
  });
  test("a sheet or the drawer hides the button (M6)", () => {
    expect(mustCancel(world, { ...world, shown: false })).toBe(true);
  });
  test("VoiceOver turned on (M10)", () => {
    expect(mustCancel(world, { ...world, voiceOver: true })).toBe(true);
  });
  test("the band changed: keyboard, rotation, Dynamic Type relayout (M15)", () => {
    expect(mustCancel(world, { ...world, height: 320 })).toBe(true);
    expect(mustCancel(world, { ...world, width: 844 })).toBe(true);
  });
});

describe("commitPlan — what a released item does (Design 5, M7/M8, M14)", () => {
  const running = hubContextOf({
    link: "up",
    turn: { turnId: "t1" } as never,
    ended: null,
    editable: true,
    dictation: false,
  });
  const withStop = { ...ENTRIES, stop: noop, steer: noop };
  test("a live entry runs; More opens the overflow", () => {
    expect(commitPlan("attach", idle, ENTRIES, hubOpen(idle))).toEqual({
      kind: "run",
      id: "attach",
    });
    expect(commitPlan("more", idle, ENTRIES, hubOpen(idle))).toEqual({ kind: "more" });
  });
  test("Stop on a turn that ended since the open says so and does nothing (M7)", () => {
    expect(commitPlan("stop", idle, withStop, hubOpen(running))).toEqual({
      kind: "notice",
      text: "Already finished",
    });
  });
  test("Stop/Steer seen on turn A never act on turn B started before the release", () => {
    const runningB = hubContextOf({
      link: "up",
      turn: { turnId: "t2" } as never,
      ended: null,
      editable: true,
      dictation: false,
    });
    for (const id of ["stop", "steer"] as const) {
      expect(commitPlan(id, runningB, withStop, hubOpen(running))).toEqual({
        kind: "notice",
        text: "Already finished",
      });
    }
    // The same turn still running does run: the guard is the turn, not "running".
    expect(commitPlan("stop", running, withStop, hubOpen(running))).toEqual({
      kind: "run",
      id: "stop",
    });
  });
  test("an entry gone since the open is a silent no-op (P6)", () => {
    expect(commitPlan("info", idle, { attach: noop }, hubOpen(idle))).toEqual({ kind: "none" });
  });
});

describe("hub accessibility actions (Design 7) — never the fan under VoiceOver", () => {
  const all = hubActions(idle, ENTRIES).all;
  test("every action (no six cap) + Show all, plus the two standard ones", () => {
    const actions = hubA11yActions(all);
    expect(actions.map((a) => a.name)).toEqual([
      "activate",
      "longpress",
      ...all.map((item) => `hub-${item.id}`),
      "show-all",
    ]);
    expect(actions.at(-1)?.label).toBe("Show all actions");
  });
  test("activate and long-press both open the actions menu; an item = its commit (Q2 = B)", () => {
    // A sighted tap opens the hub; under VoiceOver that is the plain menu (the
    // fan never opens there). The rotor still reaches Activity directly.
    expect(hubA11yRoute("activate")).toEqual({ kind: "menu" });
    expect(hubA11yRoute("longpress")).toEqual({ kind: "menu" });
    expect(hubA11yRoute("show-all")).toEqual({ kind: "menu" });
    expect(hubA11yRoute("hub-attach")).toEqual({ kind: "commit", id: "attach" });
    expect(hubA11yRoute("hub-activity")).toEqual({ kind: "commit", id: "activity" });
    expect(hubA11yRoute("hub-bogus")).toEqual({ kind: "none" });
    expect(hubA11yRoute("magicTap")).toEqual({ kind: "none" });
  });
});

describe("createHubDriver — the 400 ms timer and the machine, wired (M12, M13, M16)", () => {
  function rig() {
    let now = 0;
    const timers = new Map<number, () => void>();
    let nextId = 1;
    const effects: string[] = [];
    const items = hubActions(idle, ENTRIES).fan;
    const driver = createHubDriver({
      solve: () => solveHub({ bounds: BAND, position: undefined, items }),
      now: () => now,
      arm: (fn, ms) => {
        expect(ms).toBe(LONG_MS);
        const id = nextId++;
        timers.set(id, fn);
        return id;
      },
      disarm: (id) => {
        timers.delete(id as number);
      },
      apply: (list) => {
        for (const e of list) {
          effects.push(e.kind);
        }
      },
    });
    return {
      driver,
      effects,
      timers,
      at: (t: number) => {
        now = t;
      },
      fire: () => {
        // A fired timer is gone, like a real `setTimeout`'s.
        for (const [id, fn] of [...timers.entries()]) {
          timers.delete(id);
          fn();
        }
      },
    };
  }
  const p = { x: 350, y: 450 };

  test("a hold arms ONE timer; its firing opens the fan with the lift haptic", () => {
    const r = rig();
    r.driver.down(p, 0);
    expect(r.timers.size).toBe(1);
    r.at(400);
    r.fire();
    expect(r.effects).toEqual(["haptic", "open"]);
    expect(isFanOpen(r.driver.state())).toBe(true);
  });

  test("lifted in place after the open, the fan stays up: sticky is open (M2)", () => {
    const r = rig();
    const items = hubActions(idle, ENTRIES).fan;
    const { layout } = solveHub({ bounds: BAND, position: undefined, items });
    const at = layout.kind === "fan" ? layout.anchor : p; // the button's centre
    r.driver.down(at, 0);
    r.at(400);
    r.fire();
    r.driver.up(at, 450);
    expect(r.effects).toEqual(["haptic", "open"]);
    expect(r.driver.state().kind).toBe("fanSticky");
    expect(isFanOpen(r.driver.state())).toBe(true);
  });

  test("a release before 400 ms clears the timer and opens the fan sticky, never a late re-open (M13)", () => {
    const r = rig();
    r.driver.down(p, 0);
    r.driver.up(p, 120);
    expect(r.timers.size).toBe(0);
    expect(r.effects).toEqual(["haptic", "open"]);
    expect(r.driver.state().kind).toBe("fanSticky");
    // And the timer that never fired cannot open a second fan later.
    const before = r.driver.state();
    expect(before.kind).toBe("fanSticky");
  });

  test("a drag clears the timer (M4)", () => {
    const r = rig();
    r.driver.down(p, 0);
    r.driver.move({ x: p.x - 30, y: p.y }, 50);
    expect(r.timers.size).toBe(0);
    expect(r.effects).toEqual(["dragTo"]);
  });

  test("a system cancel mid-press clears the timer and stays silent (M12)", () => {
    const r = rig();
    r.driver.down(p, 0);
    r.driver.cancel();
    expect(r.timers.size).toBe(0);
    expect(r.effects).toEqual([]);
  });

  test("dispose with the fan open closes it (the screen restores the back-swipe, M2)", () => {
    const r = rig();
    r.driver.down(p, 0);
    r.at(400);
    r.fire();
    r.driver.dispose();
    expect(r.effects.at(-1)).toBe("close");
    expect(isFanOpen(r.driver.state())).toBe(false);
    expect(r.timers.size).toBe(0);
  });

  test("a second finger's down mid-press is ignored and arms nothing (M16)", () => {
    const r = rig();
    r.driver.down(p, 0);
    r.driver.down({ x: 10, y: 10 }, 50);
    expect(r.timers.size).toBe(1);
    expect(r.effects).toEqual([]);
  });
});
