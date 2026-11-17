/**
 * `hub-opacity.ts` — how see-through the floating hub button is
 * (docs/feat/mobile-hub-opacity.md Design 2), a pure function the component only
 * applies (AGENTS §7).
 *
 * The rules, all from the owner's decision (mockup variant B):
 *  - at rest the body is the setting; the floor is 30 %, so it is never invisible;
 *  - it is solid (1) while it is touched (press, drag, fan) and while the fan is
 *    open, and while iOS Reduce Transparency is on;
 *  - the running-turn arc is ALWAYS solid — below 75 % it gets thicker (2 → 3 pt)
 *    and gains a page-coloured halo, so it stays readable over a faint body.
 */
import { describe, expect, test } from "bun:test";
import { hubActions } from "../src/hub-actions.ts";
import { type GestureEvent, type GestureState, reduce } from "../src/hub-gesture.ts";
import {
  OPACITY_DEFAULT,
  OPACITY_MAX,
  OPACITY_MIN,
  clampOpacity,
  hubOpacity,
  opacityAt,
  settledReleased,
  shownOpacity,
  stepOpacity,
} from "../src/hub-opacity.ts";
import { hubContextOf, solveHub } from "../src/hub-session.ts";

/** The common case: nothing engaged, no fan, no Reduce Transparency. */
const at = (setting: number | undefined) =>
  hubOpacity({
    setting,
    gesture: "idle",
    fanOpen: false,
    reduceTransparency: false,
  });

describe("rest: the body is the setting", () => {
  test("the setting, as a fraction", () => {
    expect(at(55).body).toBeCloseTo(0.55, 5);
    expect(at(OPACITY_MIN).body).toBeCloseTo(0.3, 5);
    expect(at(OPACITY_MAX).body).toBe(1);
  });

  test("absent means the default, 100 % (today's look)", () => {
    expect(OPACITY_DEFAULT).toBe(100);
    expect(at(undefined).body).toBe(1);
  });

  test("the value is clamped at render too, not only at write", () => {
    expect(at(0).body).toBeCloseTo(0.3, 5);
    expect(at(1000).body).toBe(1);
  });
});

describe("the slider's shown value: the finger's while it drags, the released one until the record catches up", () => {
  test("no gesture → the stored value", () => {
    expect(shownOpacity(null, 55)).toBe(55);
    expect(shownOpacity(null, undefined)).toBe(OPACITY_DEFAULT);
    expect(shownOpacity(null, 0)).toBe(OPACITY_MIN);
    expect(shownOpacity(null, 1000)).toBe(OPACITY_MAX);
    expect(shownOpacity(null, Number.NaN)).toBe(OPACITY_MIN);
  });

  test("a live drag wins over the stored value", () => {
    expect(shownOpacity(42, 90)).toBe(42);
  });

  test("a JUST-RELEASED value wins over a stored one that has not caught up yet", () => {
    // Review round 4, finding 2: the write is one async Keychain round-trip, and
    // the store publishes only after it. Passing `null` here (the round 4 code)
    // showed the OLD stored number for that whole round-trip and then jumped.
    expect(shownOpacity(45, 90)).toBe(45);
    // It is the same value, not a re-derivation: a stored change mid-flight
    // (another surface) does not yank the label away from the finger's pick.
    expect(shownOpacity(45, 30)).toBe(45);
  });

  test("the release settles: once the record holds it, `null` follows the stored value again", () => {
    // The caller drops the held value when `stored === released` (`settledReleased`);
    // then a VoiceOver step after a drag moves again instead of re-writing the same
    // number.
    const storedAfterDrag = 45;
    expect(stepOpacity(shownOpacity(null, storedAfterDrag), 1)).toBe(50);
    expect(stepOpacity(shownOpacity(null, storedAfterDrag), -1)).toBe(40);
    // ...and a later change to the stored value is visible again.
    expect(shownOpacity(null, 70)).toBe(70);
  });

  test("a failed write still settles: it publishes the pick (F22), so the held value matches", () => {
    expect(shownOpacity(45, 45)).toBe(45);
    expect(shownOpacity(45, 45)).toBe(shownOpacity(null, 45));
  });

  test("a held value is clamped like a stored one (never a raw number on the label)", () => {
    expect(shownOpacity(1000, 50)).toBe(OPACITY_MAX);
    expect(shownOpacity(0, 50)).toBe(OPACITY_MIN);
  });
});

describe("when the hold ends: `settledReleased` keeps the released value until the record catches up", () => {
  test("the Keychain round-trip keeps it (the round 4 bug: it was dropped here)", () => {
    // Released 45, the record still says 90 for the length of the write.
    expect(settledReleased(45, 90)).toBe(45);
    // Mid-flight stored changes from another surface do not settle it either.
    expect(settledReleased(45, 30)).toBe(45);
    expect(settledReleased(45, undefined)).toBe(45);
  });

  test("the record catching up ends it — success or a failed write (both publish, F22)", () => {
    expect(settledReleased(45, 45)).toBeNull();
    // The stored record is clamped on read, so a raw one still settles.
    expect(settledReleased(45, 45.4)).toBeNull();
  });

  test("nothing held stays nothing held", () => {
    expect(settledReleased(null, 70)).toBeNull();
    expect(settledReleased(null, undefined)).toBeNull();
  });

  test("the settled value is what `shownOpacity` then reads from the record", () => {
    const stored = 45;
    expect(shownOpacity(settledReleased(45, stored), stored)).toBe(stored);
    // ...and while it is NOT settled, the released value is what shows.
    expect(shownOpacity(settledReleased(45, 90), 90)).toBe(45);
  });
});

describe("engaged: solid while it is touched or the fan is up", () => {
  for (const gesture of ["pressing", "dragging", "fanTracking", "fanSticky"] as const) {
    test(`${gesture} → 1`, () => {
      expect(at(30).body).toBeCloseTo(0.3, 5);
      expect(
        hubOpacity({ setting: 30, gesture, fanOpen: false, reduceTransparency: false }).body,
      ).toBe(1);
    });
  }

  test("a press emits no effect on down, so the state is the only source (`hub-gesture.ts:108`)", () => {
    // The owner's rule is "while it is touched": a finger down that has not moved
    // yet is `pressing`, and it must already be solid.
    expect(
      hubOpacity({ setting: 40, gesture: "pressing", fanOpen: false, reduceTransparency: false })
        .body,
    ).toBe(1);
  });

  test("fan open → 1, and closing it returns to the setting", () => {
    const open = hubOpacity({
      setting: 30,
      gesture: "idle",
      fanOpen: true,
      reduceTransparency: false,
    });
    expect(open.body).toBe(1);
    expect(at(30).body).toBeCloseTo(0.3, 5);
  });

  test("Reduce Transparency on → 1, even at the 30 % floor", () => {
    expect(
      hubOpacity({
        setting: 30,
        gesture: "idle",
        fanOpen: false,
        reduceTransparency: true,
      }).body,
    ).toBe(1);
  });
});

describe("the arc: always solid, thicker with a halo below 75 %", () => {
  test("74 / 75 / 100", () => {
    expect(at(74).arc).toEqual({ width: 3, halo: true });
    expect(at(75).arc).toEqual({ width: 2, halo: false });
    expect(at(100).arc).toEqual({ width: 2, halo: false });
  });

  test("the floor is low enough to always be thick", () => {
    expect(at(OPACITY_MIN).arc).toEqual({ width: 3, halo: true });
  });

  test("touching it (body 1) thins the arc back, so a solid button is never haloed", () => {
    expect(
      hubOpacity({ setting: 30, gesture: "pressing", fanOpen: false, reduceTransparency: false })
        .arc,
    ).toEqual({ width: 2, halo: false });
  });

  test("the arc has no opacity of its own: it follows the outer fade only", () => {
    // The property the split into two layers exists for — the plan's
    // load-bearing assumption, pinned here so a component regression shows up.
    expect(Object.keys(at(30))).toEqual(["body", "arc"]);
    expect(at(30).arc).not.toHaveProperty("opacity");
  });
});

describe("clampOpacity: an integer inside [30, 100]", () => {
  test("in range rounds", () => {
    expect(clampOpacity(55.4)).toBe(55);
    expect(clampOpacity(55.5)).toBe(56);
    expect(clampOpacity(30)).toBe(30);
    expect(clampOpacity(100)).toBe(100);
  });

  test("0 and below → the floor; above the top → the top", () => {
    expect(clampOpacity(0)).toBe(30);
    expect(clampOpacity(-40)).toBe(30);
    expect(clampOpacity(29.6)).toBe(30);
    expect(clampOpacity(101)).toBe(100);
    expect(clampOpacity(1e9)).toBe(100);
  });

  test("NaN → the floor (never an invisible button)", () => {
    expect(clampOpacity(Number.NaN)).toBe(30);
    expect(clampOpacity(Number.POSITIVE_INFINITY)).toBe(100);
    expect(clampOpacity(Number.NEGATIVE_INFINITY)).toBe(30);
  });
});

describe("opacityAt: the slider's track position → a percentage", () => {
  test("both ends", () => {
    expect(opacityAt(0, 200)).toBe(OPACITY_MIN);
    expect(opacityAt(200, 200)).toBe(OPACITY_MAX);
  });

  test("the middle, and past either end (a drag can overshoot)", () => {
    expect(opacityAt(100, 200)).toBe(65);
    expect(opacityAt(-30, 200)).toBe(OPACITY_MIN);
    expect(opacityAt(400, 200)).toBe(OPACITY_MAX);
  });

  test("a zero or negative width is the floor, never a division by zero", () => {
    expect(opacityAt(50, 0)).toBe(OPACITY_MIN);
    expect(opacityAt(50, -10)).toBe(OPACITY_MIN);
    expect(opacityAt(0, 0)).toBe(OPACITY_MIN);
  });
});

describe("stepOpacity: VoiceOver's adjustable increment / decrement", () => {
  test("±5", () => {
    expect(stepOpacity(55, 1)).toBe(60);
    expect(stepOpacity(55, -1)).toBe(50);
  });

  test("both bounds", () => {
    expect(stepOpacity(OPACITY_MIN, -1)).toBe(OPACITY_MIN);
    expect(stepOpacity(OPACITY_MAX, 1)).toBe(OPACITY_MAX);
    expect(stepOpacity(OPACITY_MAX - 2, 1)).toBe(OPACITY_MAX);
  });

  test("a junk value steps from the floor, not from NaN", () => {
    expect(stepOpacity(Number.NaN, 1)).toBe(35);
  });
});

/**
 * The "missed sync" failure mode (docs/feat/mobile-hub-opacity.md): the level is
 * a function of the machine's state, so the only way the button stays solid is a
 * close path that does not reach that state — i.e. one that leaves the state
 * engaged. Every close path in `hub-gesture.ts` ends in `idle`; this pins that
 * composition through the real reducer, so a new close effect that forgot to
 * reset the state fails here, not on a device.
 */
describe("every close path lands in `idle` (so the body returns to the setting)", () => {
  const menu = solveHub({
    bounds: { width: 390, height: 600 },
    position: undefined,
    items: hubActions(
      hubContextOf({
        link: "up",
        turn: null,
        ended: null,
        editable: true,
        dictation: false,
      }),
      { attach: () => {}, activity: () => {}, sessions: () => {}, info: () => {} },
    ).fan,
  });
  const p = { x: 100, y: 100 };
  const step = (s: GestureState, event: GestureEvent) => reduce(s, event, () => menu);

  test("a menu layout is a real fan here (otherwise this suite proves nothing)", () => {
    expect(menu.layout.kind).toBe("fan");
    expect(menu.ids.length).toBeGreaterThan(0);
  });

  test("tap and cancel end idle", () => {
    const pressing: GestureState = { kind: "pressing", down: p, t0: 0, last: p };
    expect(step(pressing, { type: "up", p, t: 100 }).state.kind).toBe("idle");
    expect(step(pressing, { type: "cancel" }).state.kind).toBe("idle");
  });

  test("a drop (moved far, then up) ends idle", () => {
    const pressing: GestureState = { kind: "pressing", down: p, t0: 0, last: p };
    const dragged = step(pressing, { type: "move", p: { x: 200, y: 100 }, t: 50 }).state;
    expect(dragged.kind).toBe("dragging");
    expect(step(dragged, { type: "up", p: { x: 200, y: 100 }, t: 80 }).state.kind).toBe("idle");
  });

  test("an open fan closes on a tap on its overlay, on a commit, and on a cancel", () => {
    const sticky: GestureState = { kind: "fanSticky", menu };
    // An empty spot on the overlay closes it; a tap on an item commits (also idle).
    expect(step(sticky, { type: "tapOverlay", p: { x: 0, y: 0 } }).state.kind).toBe("idle");
    expect(step(sticky, { type: "cancel" }).state.kind).toBe("idle");
    // A new touch on the button closes it (`hub-gesture.ts:255`).
    expect(step(sticky, { type: "down", p, t: 1200 }).state.kind).toBe("idle");
    const tracking: GestureState = {
      kind: "fanTracking",
      menu,
      openAt: p,
      moved: false,
      hi: null,
    };
    expect(step(tracking, { type: "cancel" }).state.kind).toBe("idle");
    // Lifted in place: it goes STICKY (`hub-gesture.ts:239`), so the level stays 1
    // until the next touch — which closes it.
    const stickyNow = step(tracking, { type: "up", p, t: 500 }).state;
    expect(stickyNow.kind).toBe("fanSticky");
    expect(step(stickyNow, { type: "down", p, t: 900 }).state.kind).toBe("idle");
  });

  test("while engaged the level is 1, so a state that never resets fails SAFE (solid, not faint)", () => {
    for (const kind of ["pressing", "dragging", "fanTracking", "fanSticky"] as const) {
      expect(
        hubOpacity({ setting: 30, gesture: kind, fanOpen: false, reduceTransparency: false }).body,
      ).toBe(1);
    }
  });
});
