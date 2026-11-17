/**
 * `hub-gesture.ts` — the hub button's gesture machine (docs/feat/mobile-hub.md
 * Design 1, failure modes M3/M4/M12/M13/M16): tap vs drag vs long-press, the
 * slide selection with its haptics, release → commit / cancel / sticky.
 */
import { describe, expect, test } from "bun:test";
import type { FanItem, FanLayout, Point } from "../src/hub-fan.ts";
import {
  type GestureEffect,
  type GestureEvent,
  type GestureState,
  type HubMenu,
  IDLE,
  LONG_MS,
  SLOP,
  type Step,
  classifyPress,
  reduce,
} from "../src/hub-gesture.ts";

/** A right-edge button at (300, 400) with three items on one ring of R = 100, pointing left. */
const ANCHOR = { x: 300, y: 400 };
const R = 100;
const STEP = 2 * Math.asin(28 / R);
const ANGLES = [Math.PI - STEP, Math.PI, Math.PI + STEP];
const ITEMS: FanItem[] = ANGLES.map((angle) => ({
  x: ANCHOR.x + R * Math.cos(angle),
  y: ANCHOR.y + R * Math.sin(angle),
  angle,
  R,
  ring: 0,
}));
const LAYOUT: FanLayout = {
  kind: "fan",
  anchor: ANCHOR,
  edge: "right",
  radii: [R],
  steps: [STEP],
  items: ITEMS,
};
const MENU: HubMenu = { layout: LAYOUT, ids: ["stop", "steer", "activity"], dimmed: [] };
const solve = () => MENU;

function item(i: number): Point {
  const it = ITEMS[i];
  return it === undefined ? ANCHOR : { x: it.x, y: it.y };
}

/** Runs events from `from`, collecting every effect. */
function run(events: GestureEvent[], from: GestureState = IDLE, s: () => HubMenu = solve): Step {
  let state = from;
  const effects: GestureEffect[] = [];
  for (const event of events) {
    const step = reduce(state, event, s);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const down = (p: Point, t = 0): GestureEvent => ({ type: "down", p, t });
const move = (p: Point, t: number): GestureEvent => ({ type: "move", p, t });
const up = (p: Point, t: number): GestureEvent => ({ type: "up", p, t });
const timer = (t: number): GestureEvent => ({ type: "timer", t });
const at = (dx: number, dy = 0): Point => ({ x: ANCHOR.x + dx, y: ANCHOR.y + dy });
const haptics = (effects: readonly GestureEffect[]) =>
  effects.flatMap((e) => (e.kind === "haptic" ? [e.cue] : []));
const kinds = (effects: readonly GestureEffect[]) => effects.map((e) => e.kind);

/** Pressed and held: the fan is open, the finger still on the button. */
const OPEN = [down(ANCHOR), timer(LONG_MS)];

describe("thresholds (Q-H3, pinned)", () => {
  test("SLOP = 10 pt, LONG_MS = 400 ms", () => {
    expect(SLOP).toBe(10);
    expect(LONG_MS).toBe(400);
  });
});

describe("classifyPress", () => {
  test("9 pt in 390 ms → tap", () => {
    expect(classifyPress({ dx: 9, dy: 0, ms: 390 })).toBe("tap");
  });
  test("exactly 10 pt → drag (the slop is exclusive)", () => {
    expect(classifyPress({ dx: 6, dy: 8, ms: 100 })).toBe("drag");
  });
  test("still for 400 ms → long", () => {
    expect(classifyPress({ dx: 0, dy: 0, ms: 400 })).toBe("long");
  });
  test("moved AND held → drag, never a fan (M4)", () => {
    expect(classifyPress({ dx: 30, dy: 0, ms: 900 })).toBe("drag");
  });
});

describe("tap and drag", () => {
  test("9 pt / 390 ms → the sticky fan: open(layout) + firm, solve called once", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return MENU;
    };
    const r = run([down(ANCHOR), move(at(-9), 200), up(at(-9), 390)], IDLE, counting);
    expect(r.effects).toEqual([
      { kind: "haptic", cue: "firm" },
      { kind: "open", layout: LAYOUT },
    ]);
    expect(r.state.kind).toBe("fanSticky");
    expect(calls).toBe(1);
  });

  test("a tap then a tap on an item commits it; a tap elsewhere closes", () => {
    const tapped = run([down(ANCHOR), up(at(-2), 120)]).state;
    expect(tapped.kind).toBe("fanSticky");
    const hit = run([{ type: "tapOverlay", p: item(1) }], tapped);
    expect(hit.effects).toEqual([
      { kind: "haptic", cue: "commit" },
      { kind: "commit", id: "steer" },
      { kind: "close" },
    ]);
    expect(hit.state).toEqual(IDLE);
    const miss = run([{ type: "tapOverlay", p: { x: 40, y: 80 } }], tapped);
    expect(miss.effects).toEqual([{ kind: "close" }]);
    expect(miss.state).toEqual(IDLE);
  });

  test("a tap then touching the button again closes; its release is ignored", () => {
    const tapped = run([down(ANCHOR), up(at(-2), 120)]).state;
    const r = run([down(ANCHOR, 900), up(ANCHOR, 950)], tapped);
    expect(r.effects).toEqual([{ kind: "close" }]);
    expect(r.state).toEqual(IDLE);
  });

  test("a tap where the fan does not fit → the menu + firm (the ActionSheet takes over)", () => {
    const menu: HubMenu = { layout: { kind: "menu" }, ids: ["activity"], dimmed: [] };
    const r = run([down(ANCHOR), up(at(-2), 120)], IDLE, () => menu);
    expect(r.effects).toEqual([
      { kind: "haptic", cue: "firm" },
      { kind: "open", layout: { kind: "menu" } },
    ]);
    expect(r.state).toEqual(IDLE);
  });

  test("a tap with no actions at all → nothing opens, silent", () => {
    const empty: HubMenu = { layout: { kind: "menu" }, ids: [], dimmed: [] };
    const r = run([down(ANCHOR), up(ANCHOR, 120)], IDLE, () => empty);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(IDLE);
  });

  test("10 pt at 100 ms → drag; held past 400 ms it never opens (M4)", () => {
    const r = run([down(ANCHOR), move(at(-10), 100), timer(LONG_MS), move(at(-40, 5), 600)]);
    expect(r.state.kind).toBe("dragging");
    expect(kinds(r.effects)).toEqual(["dragTo", "dragTo"]);
    expect(r.effects.at(-1)).toEqual({ kind: "dragTo", delta: { x: -40, y: 5 } });
    expect(haptics(r.effects)).toEqual([]);
  });

  test("a drag ends in drop(delta), silent", () => {
    const r = run([down(ANCHOR), move(at(-30), 100), up(at(-50, 20), 300)]);
    expect(r.effects.at(-1)).toEqual({ kind: "drop", delta: { x: -50, y: 20 } });
    expect(r.state).toEqual(IDLE);
  });

  test("a wobble out past SLOP and back is still a drag (travel is the farthest point)", () => {
    const r = run([down(ANCHOR), move(at(-12), 100), move(at(-2), 150), up(at(-2), 200)]);
    expect(kinds(r.effects)).not.toContain("open");
    expect(r.effects.at(-1)?.kind).toBe("drop");
  });

  test("a 9 pt wobble before 400 ms is still a press: the fan opens (M3)", () => {
    const r = run([down(ANCHOR), move(at(-9), 100), timer(LONG_MS)]);
    expect(r.state.kind).toBe("fanTracking");
  });
});

describe("long-press → fan", () => {
  test("400 ms still → open(layout) + firm", () => {
    const r = run(OPEN);
    expect(r.effects).toEqual([
      { kind: "haptic", cue: "firm" },
      { kind: "open", layout: LAYOUT },
    ]);
    expect(r.state.kind).toBe("fanTracking");
  });

  test("solve is called once, at the open (the snapshot)", () => {
    let calls = 0;
    const counting = () => {
      calls += 1;
      return MENU;
    };
    run([down(ANCHOR), move(at(-3), 100), timer(LONG_MS)], IDLE, counting);
    expect(calls).toBe(1);
  });

  test("slide across three items → three highlights + three ticks; back to centre → highlight(null), no tick", () => {
    const r = run([...OPEN, move(item(0), 500), move(item(1), 550), move(item(2), 600)]);
    const after = r.effects.slice(2);
    expect(after).toEqual([
      { kind: "highlight", index: 0 },
      { kind: "haptic", cue: "tick" },
      { kind: "highlight", index: 1 },
      { kind: "haptic", cue: "tick" },
      { kind: "highlight", index: 2 },
      { kind: "haptic", cue: "tick" },
    ]);
    const back = run([move(ANCHOR, 700)], r.state);
    expect(back.effects).toEqual([{ kind: "highlight", index: null }]);
  });

  test("staying on one item emits nothing more", () => {
    const r = run([...OPEN, move(item(1), 500)]);
    const again = run([move({ x: item(1).x + 2, y: item(1).y + 1 }, 520)], r.state);
    expect(again.effects).toEqual([]);
  });

  test("release on an item → commit(id) + commit haptic + close", () => {
    const r = run([...OPEN, move(item(0), 500), move(item(1), 550), up(item(1), 600)]);
    expect(r.effects.slice(-3)).toEqual([
      { kind: "haptic", cue: "commit" },
      { kind: "commit", id: "steer" },
      { kind: "close" },
    ]);
    expect(r.state).toEqual(IDLE);
  });

  test("release far away → close, no haptic, no commit", () => {
    const r = run([
      ...OPEN,
      move(item(1), 500),
      move(at(-400, -300), 550),
      up(at(-400, -300), 600),
    ]);
    const tail = r.effects.slice(
      r.effects.findIndex((e) => e.kind === "highlight" && e.index === null),
    );
    expect(tail).toEqual([{ kind: "highlight", index: null }, { kind: "close" }]);
    expect(kinds(r.effects)).not.toContain("commit");
    expect(haptics(r.effects)).toEqual(["firm", "tick"]);
    expect(r.state).toEqual(IDLE);
  });

  test("slid out and back to the button → close (cancel), not sticky", () => {
    const r = run([...OPEN, move(at(-30), 500), move(ANCHOR, 550), up(ANCHOR, 600)]);
    expect(r.effects.at(-1)).toEqual({ kind: "close" });
    expect(r.state).toEqual(IDLE);
  });

  test("released < 10 pt after the open → sticky; no close, no haptic", () => {
    const r = run([...OPEN, move(at(-9), 500), up(at(-9), 600)]);
    expect(r.state.kind).toBe("fanSticky");
    expect(r.effects.slice(2)).toEqual([]);
  });

  test("the open point, not the down point, is the sticky origin (M3)", () => {
    // 9 pt before the open, then 9 pt more the same way: 18 from down, 9 from the open.
    const r = run([down(ANCHOR), move(at(-9), 100), timer(LONG_MS), up(at(-18), 600)]);
    expect(r.state.kind).toBe("fanSticky");
  });

  test("sticky: tapOverlay on an item → commit; elsewhere → close", () => {
    const sticky = run([...OPEN, up(ANCHOR, 600)]).state;
    const hit = run([{ type: "tapOverlay", p: { x: item(2).x + 20, y: item(2).y } }], sticky);
    expect(hit.effects).toEqual([
      { kind: "haptic", cue: "commit" },
      { kind: "commit", id: "activity" },
      { kind: "close" },
    ]);
    expect(hit.state).toEqual(IDLE);
    const miss = run([{ type: "tapOverlay", p: { x: 40, y: 80 } }], sticky);
    expect(miss.effects).toEqual([{ kind: "close" }]);
    expect(miss.state).toEqual(IDLE);
  });

  test("sticky: touching the button again closes; its release is ignored", () => {
    const sticky = run([...OPEN, up(ANCHOR, 600)]).state;
    const r = run([down(ANCHOR, 900), up(ANCHOR, 950)], sticky);
    expect(r.effects).toEqual([{ kind: "close" }]);
    expect(r.state).toEqual(IDLE);
  });

  test("released late without the timer (a late JS timer) → the fan opens sticky", () => {
    const r = run([down(ANCHOR), up(at(-2), 450)]);
    expect(r.effects).toEqual([
      { kind: "haptic", cue: "firm" },
      { kind: "open", layout: LAYOUT },
    ]);
    expect(r.state.kind).toBe("fanSticky");
  });

  test("no fit → open(menu) + firm, and the machine is done (the ActionSheet takes over)", () => {
    const menu: HubMenu = { layout: { kind: "menu" }, ids: ["activity"], dimmed: [] };
    const r = run([...OPEN, move(at(-50), 500), up(at(-50), 600)], IDLE, () => menu);
    expect(r.effects).toEqual([
      { kind: "haptic", cue: "firm" },
      { kind: "open", layout: { kind: "menu" } },
    ]);
    expect(r.state).toEqual(IDLE);
  });

  test("no actions at all → nothing opens, silent", () => {
    const empty: HubMenu = { layout: { kind: "menu" }, ids: [], dimmed: [] };
    const r = run(OPEN, IDLE, () => empty);
    expect(r.effects).toEqual([]);
    expect(r.state).toEqual(IDLE);
  });
});

describe("a dimmed item still commits, with the light cue (Design 3)", () => {
  /** Activity is dimmed (nothing running): it keeps its slot and its commit. */
  const DIMMED: HubMenu = { ...MENU, dimmed: ["activity"] };
  const dim = () => DIMMED;

  test("commit of a dimmed id → light + commit + close, never the commit cue", () => {
    const r = run([...OPEN, up(ANCHOR, 600)], IDLE, dim);
    const hit = run([{ type: "tapOverlay", p: { x: item(2).x + 20, y: item(2).y } }], r.state);
    expect(hit.effects).toEqual([
      { kind: "haptic", cue: "light" },
      { kind: "commit", id: "activity" },
      { kind: "close" },
    ]);
    expect(hit.state).toEqual(IDLE);
  });

  test("a lifted-on commit of a dimmed item is also light (the slide path)", () => {
    const r = run([...OPEN, move(item(2), 500), up(item(2), 600)], IDLE, dim);
    expect(haptics(r.effects)).toEqual(["firm", "tick", "light"]);
    expect(r.effects.slice(-2)).toEqual([{ kind: "commit", id: "activity" }, { kind: "close" }]);
  });

  test("a live id next to it keeps the commit cue", () => {
    const r = run([...OPEN, move(item(1), 500), up(item(1), 600)], IDLE, dim);
    expect(haptics(r.effects)).toEqual(["firm", "tick", "commit"]);
    expect(r.effects.at(-2)).toEqual({ kind: "commit", id: "steer" });
  });
});

describe("timers, extra touches and cancels", () => {
  test("M13: a timer after up does nothing (a tap already opened the fan sticky)", () => {
    const r = run([down(ANCHOR), up(ANCHOR, 100), timer(LONG_MS)]);
    expect(r.effects).toEqual([
      { kind: "haptic", cue: "firm" },
      { kind: "open", layout: LAYOUT },
    ]);
    expect(r.state.kind).toBe("fanSticky");
  });

  test("M13: a stale timer (an earlier press's) that fires early in a new press is ignored", () => {
    const r = run([down(ANCHOR, 1000), timer(1100)]);
    expect(r.effects).toEqual([]);
    expect(r.state.kind).toBe("pressing");
  });

  test("M13: a timer in any open state does nothing", () => {
    const tracking = run(OPEN).state;
    expect(reduce(tracking, timer(900), solve)).toEqual({ state: tracking, effects: [] });
    const sticky = run([...OPEN, up(ANCHOR, 600)]).state;
    expect(reduce(sticky, timer(900), solve)).toEqual({ state: sticky, effects: [] });
  });

  test("M16: a second down while pressing / dragging / tracking is ignored", () => {
    const pressing = run([down(ANCHOR)]).state;
    const dragging = run([down(ANCHOR), move(at(-20), 50)]).state;
    const tracking = run(OPEN).state;
    for (const s of [pressing, dragging, tracking]) {
      expect(reduce(s, down(at(-100, -100), 700), solve)).toEqual({ state: s, effects: [] });
    }
  });

  test("events with no meaning in idle are ignored", () => {
    for (const e of [move(ANCHOR, 1), up(ANCHOR, 1), timer(LONG_MS), { type: "cancel" } as const]) {
      expect(reduce(IDLE, e, solve)).toEqual({ state: IDLE, effects: [] });
    }
    expect(reduce(IDLE, { type: "tapOverlay", p: ANCHOR }, solve)).toEqual({
      state: IDLE,
      effects: [],
    });
  });

  test("M12: cancel from every state → idle, silent; it closes an open fan and undoes a drag", () => {
    const cases: [GestureEvent[], GestureEffect[]][] = [
      [[down(ANCHOR)], []],
      [[down(ANCHOR), move(at(-20), 50)], [{ kind: "dragCancel" }]],
      [OPEN, [{ kind: "close" }]],
      [[...OPEN, move(item(0), 500)], [{ kind: "close" }]],
      [[...OPEN, up(ANCHOR, 600)], [{ kind: "close" }]],
    ];
    for (const [events, expected] of cases) {
      const r = reduce(run(events).state, { type: "cancel" }, solve);
      expect(r).toEqual({ state: IDLE, effects: expected });
    }
  });
});
