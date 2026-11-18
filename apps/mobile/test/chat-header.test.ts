import { describe, expect, test } from "bun:test";
import {
  type ChatFacts,
  chatStatus,
  dotLook,
  ringArcs,
  ringHalfRotation,
  ringLabel,
  titleLabel,
} from "../src/chat-header.ts";

const open: ChatFacts = {
  phase: "open",
  link: "up",
  running: false,
  asking: false,
  closed: null,
};

describe("chatStatus (the dot before the title; no status word)", () => {
  test("idle has NO dot and a plain title", () => {
    expect(chatStatus(open)).toEqual({ dot: null, state: "idle", dimTitle: false });
  });

  test("every state maps to its dot", () => {
    expect(chatStatus({ ...open, running: true }).dot).toBe("running");
    expect(chatStatus({ ...open, asking: true }).dot).toBe("ask");
    expect(chatStatus({ ...open, phase: "opening", link: "down" }).dot).toBe("connecting");
    expect(chatStatus({ ...open, link: "down" }).dot).toBe("offline");
    expect(chatStatus({ ...open, phase: "failed" }).dot).toBe("attention");
  });

  test("an ask wins over the running turn it suspends", () => {
    expect(chatStatus({ ...open, running: true, asking: true })).toEqual({
      dot: "ask",
      state: "waiting for approval",
      dimTitle: false,
    });
  });

  test("the link down wins over a running turn and an ask (the phone cannot see or answer)", () => {
    expect(chatStatus({ ...open, running: true, asking: true, link: "down" }).dot).toBe("offline");
  });

  test("an attach in flight or failed says so before anything else", () => {
    expect(chatStatus({ ...open, phase: "opening", running: true }).state).toBe("connecting");
    expect(chatStatus({ ...open, phase: "failed", link: "down" }).state).toBe("not connected");
  });

  test("an ended session has no dot and a dimmed title, even mid-turn", () => {
    expect(chatStatus({ ...open, closed: "deleted", running: true, asking: true })).toEqual({
      dot: null,
      state: "ended",
      dimTitle: true,
    });
  });
});

describe("dotLook (what the component draws, decided here)", () => {
  test("running pulses in the accent, filled", () => {
    expect(dotLook("running")).toEqual({ tone: "running", hollow: false, pulse: true });
  });
  test("ask is amber and steady", () => {
    expect(dotLook("ask")).toEqual({ tone: "attention", hollow: false, pulse: false });
  });
  test("connecting is grey hollow and pulses; offline is grey hollow and steady", () => {
    expect(dotLook("connecting")).toEqual({ tone: "offline", hollow: true, pulse: true });
    expect(dotLook("offline")).toEqual({ tone: "offline", hollow: true, pulse: false });
  });
  test("not connected is amber hollow", () => {
    expect(dotLook("attention")).toEqual({ tone: "attention", hollow: true, pulse: false });
  });
});

describe("titleLabel (VoiceOver: the dot is visual only)", () => {
  test("the state rides the title", () => {
    expect(titleLabel("Test", chatStatus({ ...open, running: true }))).toBe("Test, running");
    expect(titleLabel("Test", chatStatus({ ...open, asking: true }))).toBe(
      "Test, waiting for approval",
    );
    expect(titleLabel("Test", chatStatus({ ...open, closed: "ended" }))).toBe("Test, ended");
  });
  test("idle is the bare title", () => {
    expect(titleLabel("Test", chatStatus(open))).toBe("Test");
  });
});

/**
 * S2 (docs/feat/mobile-chrome.md, A1 + F11): the header's context ring. The ring
 * is drawn with plain `View`s — no `react-native-svg` dependency — so its
 * geometry is a pure function here: two half-ring views, each rotated by its own
 * share of 180° (Design 2). `ContextRing.tsx` only maps the result to styles.
 */
describe("ringArcs (the header's 20 pt context ring, A1)", () => {
  test("0% draws nothing", () => {
    expect(ringArcs(0)).toEqual({ rightDeg: 0, leftDeg: 0, tone: "accent" });
  });

  test("the half mark hands the whole arc to the right half", () => {
    // Up to 50 the right half carries everything and the left stays at 0; past
    // 50 the left half starts, so the two rotations never overdraw each other.
    const at49 = ringArcs(49);
    expect(at49.leftDeg).toBe(0);
    expect(at49.rightDeg).toBeCloseTo(176.4, 6);
    expect(ringArcs(50)).toEqual({ rightDeg: 180, leftDeg: 0, tone: "accent" });
    const at51 = ringArcs(51);
    expect(at51.rightDeg).toBe(180);
    expect(at51.leftDeg).toBeCloseTo(3.6, 6);
  });

  test("a full ring is both halves, and over 100 clamps", () => {
    expect(ringArcs(100)).toEqual({ rightDeg: 180, leftDeg: 180, tone: "orange" });
    expect(ringArcs(140)).toEqual(ringArcs(100));
  });

  test("the tone turns orange at 80, exactly as the bar did", () => {
    expect(ringArcs(79).tone).toBe("accent");
    expect(ringArcs(80).tone).toBe("orange");
  });

  test("NaN and negatives read as 0 (never a broken transform)", () => {
    expect(ringArcs(Number.NaN)).toEqual({ rightDeg: 0, leftDeg: 0, tone: "accent" });
    expect(ringArcs(-10)).toEqual({ rightDeg: 0, leftDeg: 0, tone: "accent" });
  });

  test("the ring's VoiceOver label is the percentage (F11)", () => {
    expect(ringLabel(34)).toBe("Context 34%");
    // A rounded reading of an estimate is still a reading; no fake value at NaN.
    expect(ringLabel(Number.NaN)).toBe("Context 0%");
  });

  test("the two half-ring rotations tile one clockwise sweep (no overdraw)", () => {
    // The bases are the two windows' empty positions (right 315, left 135); the
    // arc grows by exactly the degrees each half owns. Verified against a
    // 36 000-sample model of the circle in the task doc's Execution.
    expect(ringHalfRotation(ringArcs(0))).toEqual({ right: 315, left: 135 });
    expect(ringHalfRotation(ringArcs(50))).toEqual({ right: 495, left: 135 });
    expect(ringHalfRotation(ringArcs(100))).toEqual({ right: 495, left: 315 });
    // A quarter ring is a quarter: the right half carries it, the left stays out.
    expect(ringHalfRotation(ringArcs(25)).right).toBeCloseTo(405, 6);
    expect(ringHalfRotation(ringArcs(75)).left).toBeCloseTo(225, 6);
  });
});
