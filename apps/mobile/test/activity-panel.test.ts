/**
 * The Activity panel's motion and gates (docs/feat/mobile-activity-panel.md
 * Design 1/4): the two detents, what a released drag does, the open/auto-close
 * gates and the inline two-tap Stop's arm. Every rule is pure, so it is pinned
 * here rather than on a simulator (AGENTS §7).
 */
import { describe, expect, test } from "bun:test";
import {
  PANEL_MIN_LOW,
  type PanelDetents,
  STOP_ARM_MS,
  STOP_IDLE,
  panelAutoClose,
  panelDetentFor,
  panelDetents,
  panelDrag,
  panelFollowsContent,
  panelOpensFor,
  panelRelease,
  pruneArm,
  stopArmed,
  stopTap,
} from "../src/activity-panel.ts";
import { activityView } from "../src/activity.ts";

const IPHONE = { screenHeight: 844, topInset: 47, bottomInset: 34 };
/** A row's height in the sheet (Row's `rowList`). */
const ROW = 50;
/** The header's own height in the model (`PANEL_HEADER`, 62). */
const HEADER = 62;

function metrics(rows: number, screen = IPHONE) {
  return { ...screen, contentHeight: rows * ROW };
}

const EMPTY_VIEW = activityView(
  { subagents: [], jobs: null, finished: [], reports: new Map(), opened: [], schedules: undefined },
  0,
);

const ONE_CHILD = activityView(
  {
    subagents: [
      {
        id: "sa-1",
        callId: "call-1",
        agentType: "general",
        description: "find the mouse handlers",
        state: "running",
        toolUses: 2,
        tokens: 10,
        startedAt: 0,
        tail: ["read x"],
      },
    ],
    jobs: null,
    finished: [],
    reports: new Map(),
    opened: [],
    schedules: undefined,
  },
  0,
);

const detents = (rows: number, screen = IPHONE): PanelDetents =>
  panelDetents(metrics(rows, screen));

describe("the two detents", () => {
  test("one row: the low detent fits it, and there is no tall detent to drag to", () => {
    const d = detents(1);
    // 1 × 50 + header 62 + the home indicator 34 = 146.
    expect(d.low).toBe(ROW + HEADER + IPHONE.bottomInset);
    expect(d.low).toBeGreaterThanOrEqual(PANEL_MIN_LOW);
    expect(d.tall).toBe(d.low);
    expect(d.scrollable).toBe(false);
  });

  test("three rows: the sheet grows with the content and still fits", () => {
    const d = detents(3);
    expect(d.low).toBe(3 * ROW + HEADER + IPHONE.bottomInset);
    expect(d.low).toBeGreaterThan(detents(1).low);
    expect(d.low).toBeLessThanOrEqual(d.tall);
    expect(d.scrollable).toBe(false);
  });

  test("nine rows: `low` stops at the cap, the drag up reaches `tall`, the list scrolls", () => {
    const d = detents(9);
    // 9 × 50 + header 62 + 34 = 546: past the sheet's own cap, so the first
    // detent stops at half the screen and the drag up is what reveals the rest.
    expect(d.low).toBe(Math.round(IPHONE.screenHeight / 2));
    expect(d.low).toBeLessThan(d.tall);
    expect(d.scrollable).toBe(true);
    // The tall detent keeps the top gap (and never eats the status bar).
    expect(d.tall).toBe(IPHONE.screenHeight - IPHONE.topInset - 44);
    expect(d.tall).toBeLessThan(IPHONE.screenHeight);
  });

  test("a content under the minimum still opens at `PANEL_MIN_LOW`", () => {
    expect(detents(0).low).toBe(PANEL_MIN_LOW);
  });

  test("a small screen: the tall detent is smaller, and the content clamps into it", () => {
    const small = { screenHeight: 667, topInset: 20, bottomInset: 0 };
    const many = detents(9, small);
    // Half of 667 is 334 < the 512 the content wants: capped, and scrollable.
    expect(many.low).toBe(334);
    expect(many.tall).toBe(667 - 44 - 44);
    expect(many.scrollable).toBe(true);
    expect(many.tall).toBeLessThan(detents(9).tall);
    // A content that fits keeps ONE detent, however small the screen.
    const three = detents(3, small);
    expect(three.scrollable).toBe(false);
    expect(three.tall).toBe(three.low);
  });

  test("a content TALLER than the tall detent clamps: `low` never passes `tall`", () => {
    const small = { screenHeight: 667, topInset: 20, bottomInset: 0 };
    // 40 rows = 2062 pt of content, far past the 579 the sheet may take.
    const d = detents(40, small);
    expect(d.low).toBeLessThanOrEqual(d.tall);
    expect(d.low).toBeGreaterThanOrEqual(PANEL_MIN_LOW);
    expect(d.scrollable).toBe(true);
    // There is no detent beyond `tall`: the list is what reveals the rest.
    expect(d.tall).toBe(667 - 44 - 44);
  });
});

describe("a drag in flight", () => {
  // Nine rows: the one shape with two detents to move between.
  const d = detents(9);

  test("one detent only: a drag up has nowhere to go, and nothing moves", () => {
    const flat = detents(1);
    expect(panelDrag(flat.low, -120, flat)).toBe(flat.low);
  });

  test("follows the finger and clamps at both ends", () => {
    expect(panelDrag(d.low, -80, d)).toBe(d.low + 80);
    // No rubber band past the tall detent, and nothing below zero.
    expect(panelDrag(d.low, -5000, d)).toBe(d.tall);
    expect(panelDrag(d.low, 5000, d)).toBe(0);
  });
});

describe("a released drag", () => {
  const d = detents(9);

  test("a downward flick closes from the LOW detent (no resistance)", () => {
    expect(panelRelease(d.low, 1.2, d)).toBe("close");
  });

  test("a downward flick closes from the TALL detent too", () => {
    expect(panelRelease(d.tall, 0.9, d)).toBe("close");
  });

  test("an upward flick reaches the tall detent", () => {
    expect(panelRelease(d.low + 20, -1.1, d)).toBe("tall");
  });

  test("an upward flick with no tall detent settles back on `low`", () => {
    const flat = detents(1);
    expect(panelRelease(flat.low - 30, -1.4, flat)).toBe("low");
  });

  test("a slow drag below 0.6 × low closes", () => {
    expect(panelRelease(d.low * 0.5, 0, d)).toBe("close");
    expect(panelRelease(d.low * 0.7, 0, d)).toBe("low");
  });

  test("a slow drag nearer the tall detent settles on it", () => {
    expect(panelRelease(d.tall - 10, 0.1, d)).toBe("tall");
  });
});

describe("whether the sheet follows a changed content", () => {
  const d = detents(9);

  test("resting at `low`, a changed low is followed (grown or shrunk)", () => {
    expect(panelFollowsContent(d.low, d.low, d.low + 50)).toBe(true);
    expect(panelFollowsContent(d.low, d.low, d.low - 20)).toBe(true);
  });

  test("a sheet dragged up to `tall` stays where it was put", () => {
    expect(panelFollowsContent(d.tall, d.low, d.low + 50)).toBe(false);
  });

  test("a first measure has no previous low to follow", () => {
    expect(panelFollowsContent(0, 0, d.low)).toBe(false);
  });

  test("an unchanged low settles nothing: there is nothing to move", () => {
    expect(panelFollowsContent(d.low, d.low, d.low)).toBe(false);
  });
});

describe("whether the panel opens", () => {
  test("an empty list never opens", () => {
    expect(panelOpensFor(EMPTY_VIEW, null)).toBe(false);
  });

  test("a list with a row opens", () => {
    expect(panelOpensFor(ONE_CHILD, null)).toBe(true);
  });

  test("a detail asked for by id opens even on an empty list (an agent card)", () => {
    expect(panelOpensFor(EMPTY_VIEW, { kind: "child", id: "sa-9" })).toBe(true);
  });
});

describe("whether the panel closes itself", () => {
  test("the list auto-closes when the last item ends", () => {
    expect(panelAutoClose(EMPTY_VIEW, null)).toBe(true);
  });

  test("the list stays while anything is shown", () => {
    expect(panelAutoClose(ONE_CHILD, null)).toBe(false);
  });

  test("a detail never auto-closes", () => {
    expect(panelAutoClose(EMPTY_VIEW, { kind: "child", id: "sa-1" })).toBe(false);
  });
});

describe("which detent it opens at", () => {
  test("the list at `low`, a detail at `tall`", () => {
    expect(panelDetentFor(null)).toBe("low");
    expect(panelDetentFor({ kind: "child", id: "sa-1" })).toBe("tall");
    expect(panelDetentFor({ kind: "job", id: "bg-1" })).toBe("tall");
  });
});

describe("the inline two-tap Stop", () => {
  test("tap 1 arms, tap 2 fires and disarms", () => {
    const first = stopTap(STOP_IDLE, "sa-1", 1000);
    expect(first.fire).toBe(false);
    expect(stopArmed(first.state, "sa-1", 1000)).toBe(true);
    const second = stopTap(first.state, "sa-1", 1400);
    expect(second.fire).toBe(true);
    expect(second.state.id).toBeNull();
  });

  test("tap 2 after the window is a fresh tap 1, never a fire", () => {
    const first = stopTap(STOP_IDLE, "sa-1", 1000);
    const late = stopTap(first.state, "sa-1", 1000 + STOP_ARM_MS);
    expect(late.fire).toBe(false);
    expect(stopArmed(late.state, "sa-1", 1000 + STOP_ARM_MS)).toBe(true);
  });

  test("a tap on another row moves the arm, it does not fire the first", () => {
    const first = stopTap(STOP_IDLE, "sa-1", 1000);
    const other = stopTap(first.state, "bg-1", 1100);
    expect(other.fire).toBe(false);
    expect(stopArmed(other.state, "sa-1", 1100)).toBe(false);
    expect(stopArmed(other.state, "bg-1", 1100)).toBe(true);
  });

  test("a row that left the view between the taps loses its arm", () => {
    const armed = stopTap(STOP_IDLE, "sa-1", 1000).state;
    expect(pruneArm(armed, ["sa-1", "bg-1"]).id).toBe("sa-1");
    expect(pruneArm(armed, ["bg-1"]).id).toBeNull();
    // ...and the re-arriving row starts unarmed: a tap on it is a fresh tap 1.
    const back = stopTap(pruneArm(armed, ["bg-1"]), "sa-1", 1200);
    expect(back.fire).toBe(false);
  });

  test("an idle arm is not armed for anything", () => {
    expect(stopArmed(STOP_IDLE, "sa-1", 0)).toBe(false);
  });
});
