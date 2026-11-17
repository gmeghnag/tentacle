/**
 * docs/feat/mobile-hub.md H3 — the pure seam between the Session screen and the
 * hub: the context it reads, the menu it solves at the open, the finger's point
 * in band coordinates, and when a world change cancels an open fan.
 */
import { describe, expect, test } from "bun:test";
import type { ArtifactMeta, ScheduleRow } from "@tentacle/protocol";
import { NOTHING_SEEN, markArtifactOpened, markGalleryOpened } from "../src/artifact-seen-store.ts";
import { FLOAT_SIZE, place } from "../src/floating-button.ts";
import { DUE_SOON_MS, buttonBadge, hubActions } from "../src/hub-actions.ts";
import { ITEM_SIZE } from "../src/hub-fan.ts";
import { bandPoint, hubContextOf, mustCancel, solveHub, wakeContext } from "../src/hub-session.ts";

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

  test("anchored on the button's centre, in band coordinates, one id per item in fan order", () => {
    const menu = solveHub({ bounds: BAND, position: undefined, items });
    expect(menu.ids).toEqual(["attach", "activity", "sessions", "info"]);
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
