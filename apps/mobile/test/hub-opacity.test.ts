/**
 * `hub-opacity.ts` — how see-through the floating hub button is
 * (docs/feat/mobile-hub-opacity.md Design 2), a pure function the component only
 * applies (AGENTS §7).
 *
 * The rules, all from the owner's decision (mockup variant B):
 *  - at rest the body is the setting; the floor is 20 %, so it is never invisible;
 *    the setting is one of five steps, 20 · 40 · 60 · 80 · 100
 *    (docs/feat/mobile-hub-defaults.md);
 *  - it is solid (1) while it is touched (press, drag, fan) and while the fan is
 *    open, and while iOS Reduce Transparency is on;
 *  - the running-turn arc is ALWAYS solid — below 75 % it gets thicker (2 → 3 pt)
 *    and gains a page-coloured halo, so it stays readable over a faint body.
 */
import { describe, expect, test } from "bun:test";
import { opacityStepHaptic } from "../src/haptic-rules.ts";
import { hubActions } from "../src/hub-actions.ts";
import { type GestureEvent, type GestureState, reduce } from "../src/hub-gesture.ts";
import {
  OPACITY_DEFAULT,
  OPACITY_MAX,
  OPACITY_MIN,
  OPACITY_STEPS,
  hubOpacity,
  opacityAt,
  settledReleased,
  shownOpacity,
  snapOpacity,
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
    expect(at(60).body).toBeCloseTo(0.6, 5);
    expect(at(OPACITY_MIN).body).toBeCloseTo(0.2, 5);
    expect(at(OPACITY_MAX).body).toBe(1);
  });

  test("absent in a STORED record means 100 % (the look it had before the slider)", () => {
    expect(OPACITY_DEFAULT).toBe(100);
    expect(at(undefined).body).toBe(1);
  });

  test("the value is snapped at render too, not only at read", () => {
    expect(at(0).body).toBeCloseTo(0.2, 5);
    expect(at(35).body).toBeCloseTo(0.4, 5);
    expect(at(1000).body).toBe(1);
  });
});

describe("the slider's shown value: the finger's while it drags, the released one until the record catches up", () => {
  test("no gesture → the stored value", () => {
    expect(shownOpacity(null, 60)).toBe(60);
    expect(shownOpacity(null, 35)).toBe(40);
    expect(shownOpacity(null, undefined)).toBe(OPACITY_DEFAULT);
    expect(shownOpacity(null, 0)).toBe(OPACITY_MIN);
    expect(shownOpacity(null, 1000)).toBe(OPACITY_MAX);
    expect(shownOpacity(null, Number.NaN)).toBe(OPACITY_MIN);
  });

  test("a live drag wins over the stored value", () => {
    expect(shownOpacity(40, 100)).toBe(40);
  });

  test("a JUST-RELEASED value wins over a stored one that has not caught up yet", () => {
    // Review round 4, finding 2: the write is one async Keychain round-trip, and
    // the store publishes only after it. Passing `null` here (the round 4 code)
    // showed the OLD stored number for that whole round-trip and then jumped.
    expect(shownOpacity(40, 100)).toBe(40);
    // It is the same value, not a re-derivation: a stored change mid-flight
    // (another surface) does not yank the label away from the finger's pick.
    expect(shownOpacity(40, 20)).toBe(40);
  });

  test("the release settles: once the record holds it, `null` follows the stored value again", () => {
    // The caller drops the held value when `stored === released` (`settledReleased`);
    // then a VoiceOver step after a drag moves again instead of re-writing the same
    // number.
    const storedAfterDrag = 40;
    expect(stepOpacity(shownOpacity(null, storedAfterDrag), 1)).toBe(60);
    expect(stepOpacity(shownOpacity(null, storedAfterDrag), -1)).toBe(20);
    // ...and a later change to the stored value is visible again.
    expect(shownOpacity(null, 80)).toBe(80);
  });

  test("a failed write still settles: it publishes the pick (F22), so the held value matches", () => {
    expect(shownOpacity(40, 40)).toBe(40);
    expect(shownOpacity(40, 40)).toBe(shownOpacity(null, 40));
  });

  test("a held value is snapped like a stored one (never a raw number on the label)", () => {
    expect(shownOpacity(1000, 50)).toBe(OPACITY_MAX);
    expect(shownOpacity(0, 50)).toBe(OPACITY_MIN);
  });
});

describe("when the hold ends: `settledReleased` keeps the released value until the record catches up", () => {
  test("the Keychain round-trip keeps it (the round 4 bug: it was dropped here)", () => {
    // Released 40, the record still says 100 for the length of the write.
    expect(settledReleased(40, 100)).toBe(40);
    // Mid-flight stored changes from another surface do not settle it either.
    expect(settledReleased(40, 20)).toBe(40);
    expect(settledReleased(40, undefined)).toBe(40);
  });

  test("the record catching up ends it — success or a failed write (both publish, F22)", () => {
    expect(settledReleased(40, 40)).toBeNull();
    // The stored record is snapped on read, so a raw off-step one still settles.
    expect(settledReleased(40, 35)).toBeNull();
  });

  test("nothing held stays nothing held", () => {
    expect(settledReleased(null, 80)).toBeNull();
    expect(settledReleased(null, undefined)).toBeNull();
  });

  test("the settled value is what `shownOpacity` then reads from the record", () => {
    const stored = 40;
    expect(shownOpacity(settledReleased(40, stored), stored)).toBe(stored);
    // ...and while it is NOT settled, the released value is what shows.
    expect(shownOpacity(settledReleased(40, 100), 100)).toBe(40);
  });
});

describe("engaged: solid while it is touched or the fan is up", () => {
  for (const gesture of ["pressing", "dragging", "fanTracking", "fanSticky"] as const) {
    test(`${gesture} → 1`, () => {
      expect(at(20).body).toBeCloseTo(0.2, 5);
      expect(
        hubOpacity({ setting: 20, gesture, fanOpen: false, reduceTransparency: false }).body,
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
      setting: 80,
      gesture: "idle",
      fanOpen: true,
      reduceTransparency: false,
    });
    // The fan is solid at any step, the new 80 % default included (owner 2026-11-18).
    expect(open.body).toBe(1);
    expect(at(80).body).toBeCloseTo(0.8, 5);
  });

  test("Reduce Transparency on → 1, even at the 20 % floor", () => {
    expect(
      hubOpacity({
        setting: 20,
        gesture: "idle",
        fanOpen: false,
        reduceTransparency: true,
      }).body,
    ).toBe(1);
  });
});

describe("the arc: always solid, thicker with a halo below 75 %", () => {
  test("60 / 80 / 100: the 80 % default keeps the plain arc", () => {
    expect(at(60).arc).toEqual({ width: 3, halo: true });
    expect(at(80).arc).toEqual({ width: 2, halo: false });
    expect(at(100).arc).toEqual({ width: 2, halo: false });
  });

  test("the floor is low enough to always be thick", () => {
    expect(at(OPACITY_MIN).arc).toEqual({ width: 3, halo: true });
  });

  test("touching it (body 1) thins the arc back, so a solid button is never haloed", () => {
    expect(
      hubOpacity({ setting: 20, gesture: "pressing", fanOpen: false, reduceTransparency: false })
        .arc,
    ).toEqual({ width: 2, halo: false });
  });

  test("the arc has no opacity of its own: it follows the outer fade only", () => {
    // The property the split into two layers exists for — the plan's
    // load-bearing assumption, pinned here so a component regression shows up.
    expect(Object.keys(at(20))).toEqual(["body", "arc"]);
    expect(at(20).arc).not.toHaveProperty("opacity");
  });
});

describe("snapOpacity: the nearest of the five steps, a tie going UP", () => {
  test("the steps are 20 · 40 · 60 · 80 · 100: the floor is 20", () => {
    expect(OPACITY_STEPS).toEqual([20, 40, 60, 80, 100]);
    expect(OPACITY_MIN).toBe(20);
    expect(OPACITY_MAX).toBe(100);
    for (const step of OPACITY_STEPS) {
      expect(snapOpacity(step)).toBe(step);
    }
  });

  test("an off-step value goes to the NEAREST step (the old continuous slider's records)", () => {
    expect(snapOpacity(35)).toBe(40);
    expect(snapOpacity(45)).toBe(40);
    expect(snapOpacity(49.9)).toBe(40);
    expect(snapOpacity(63)).toBe(60);
    expect(snapOpacity(71)).toBe(80);
    expect(snapOpacity(89)).toBe(80);
    expect(snapOpacity(91)).toBe(100);
  });

  test("a tie goes UP: 30 → 40, 50 → 60, 70 → 80, 90 → 100, 10 → 20", () => {
    expect(snapOpacity(30)).toBe(40);
    expect(snapOpacity(50)).toBe(60);
    expect(snapOpacity(70)).toBe(80);
    expect(snapOpacity(90)).toBe(100);
    expect(snapOpacity(10)).toBe(20);
  });

  test("0 and below → the floor; above the top → the top", () => {
    expect(snapOpacity(0)).toBe(20);
    expect(snapOpacity(-40)).toBe(20);
    expect(snapOpacity(29.9)).toBe(20);
    expect(snapOpacity(101)).toBe(100);
    expect(snapOpacity(1e9)).toBe(100);
  });

  test("NaN → the floor (never an invisible button), ±Infinity → its end", () => {
    expect(snapOpacity(Number.NaN)).toBe(20);
    expect(snapOpacity(Number.POSITIVE_INFINITY)).toBe(100);
    expect(snapOpacity(Number.NEGATIVE_INFINITY)).toBe(20);
  });
});

describe("opacityAt: the slider's track position → a step", () => {
  test("both ends", () => {
    expect(opacityAt(0, 200)).toBe(OPACITY_MIN);
    expect(opacityAt(200, 200)).toBe(OPACITY_MAX);
  });

  test("each step owns a band of the track around its mark (200 pt: a mark every 50 pt)", () => {
    expect(opacityAt(24, 200)).toBe(20);
    expect(opacityAt(25, 200)).toBe(40);
    expect(opacityAt(50, 200)).toBe(40);
    expect(opacityAt(100, 200)).toBe(60);
    expect(opacityAt(150, 200)).toBe(80);
    expect(opacityAt(174, 200)).toBe(80);
    expect(opacityAt(175, 200)).toBe(100);
  });

  test("every value it returns is a step", () => {
    for (let x = -20; x <= 220; x += 1) {
      expect(OPACITY_STEPS).toContain(opacityAt(x, 200));
    }
  });

  test("past either end (a drag can overshoot)", () => {
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
  test("±20: one step", () => {
    expect(stepOpacity(60, 1)).toBe(80);
    expect(stepOpacity(60, -1)).toBe(40);
  });

  test("an off-step value snaps first, then steps", () => {
    expect(stepOpacity(35, 1)).toBe(60);
    expect(stepOpacity(35, -1)).toBe(20);
  });

  test("both bounds", () => {
    expect(stepOpacity(OPACITY_MIN, -1)).toBe(OPACITY_MIN);
    expect(stepOpacity(OPACITY_MAX, 1)).toBe(OPACITY_MAX);
  });

  test("a junk value steps from the floor, not from NaN", () => {
    expect(stepOpacity(Number.NaN, 1)).toBe(40);
  });
});

describe("opacityStepHaptic: a tick per step the drag lands on, silence inside one", () => {
  test("another step → the selection tick (the light detent click)", () => {
    expect(opacityStepHaptic(80, 60)).toBe("tick");
    expect(opacityStepHaptic(20, 100)).toBe("tick");
  });

  test("the same step → nothing (moves inside its band are silent)", () => {
    expect(opacityStepHaptic(60, 60)).toBeNull();
    // A raw off-step record compares as its step: 35 IS 40, so landing on 40 is silent.
    expect(opacityStepHaptic(35, 40)).toBeNull();
  });

  test("a drag across the whole track ticks four times, one per step crossed", () => {
    let shown = 20;
    let ticks = 0;
    for (let x = 0; x <= 200; x += 1) {
      const next = opacityAt(x, 200);
      if (opacityStepHaptic(shown, next) !== null) {
        ticks += 1;
      }
      shown = next;
    }
    expect(ticks).toBe(4);
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

  test("a tap OPENS the fan (engaged), and the close after it lands idle", () => {
    // mobile-hub-tap Design 1: a tap is no longer a close path, it is an open
    // one — so it must ride the SAME engaged rule (solid body), and its close
    // must return to the setting, or the body stays solid for good.
    const pressing: GestureState = { kind: "pressing", down: p, t0: 0, last: p };
    const tapped = step(pressing, { type: "up", p, t: 100 }).state;
    expect(tapped.kind).toBe("fanSticky");
    expect(
      hubOpacity({ setting: 40, gesture: tapped.kind, fanOpen: true, reduceTransparency: false })
        .body,
    ).toBe(1);
    // The next touch on the button closes it: back to the setting, not faint-forever.
    const closed = step(tapped, { type: "down", p, t: 900 }).state;
    expect(closed.kind).toBe("idle");
    expect(
      hubOpacity({ setting: 40, gesture: closed.kind, fanOpen: false, reduceTransparency: false })
        .body,
    ).toBeCloseTo(0.4, 5);
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
    expect(step(sticky, { type: "tapOverlay", p: { x: 0, y: 0 }, t: 1 }).state.kind).toBe("idle");
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
        hubOpacity({ setting: 20, gesture: kind, fanOpen: false, reduceTransparency: false }).body,
      ).toBe(1);
    }
  });
});
