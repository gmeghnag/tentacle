import { describe, expect, test } from "bun:test";
import {
  type ChatFacts,
  chatStatus,
  ringArcs,
  ringHalfRotation,
  ringLabel,
} from "../src/chat-header.ts";

const open: ChatFacts = { phase: "open", link: "up", running: false, closed: null };

describe("chatStatus (the chat header's status line)", () => {
  test("idle and running, with their tones", () => {
    expect(chatStatus(open)).toEqual({ text: "Idle", tone: "online" });
    expect(chatStatus({ ...open, running: true })).toEqual({ text: "Running", tone: "running" });
  });

  test("the link down wins over a running turn (the phone cannot see it run)", () => {
    expect(chatStatus({ ...open, running: true, link: "down" })).toEqual({
      text: "Offline",
      tone: "offline",
    });
  });

  test("an attach in flight or failed says so before anything else", () => {
    expect(chatStatus({ ...open, phase: "opening", link: "down" }).text).toBe("Connecting…");
    expect(chatStatus({ ...open, phase: "failed" })).toEqual({
      text: "Not connected",
      tone: "attention",
    });
  });

  test("an ended session is Ended, not Idle", () => {
    expect(chatStatus({ ...open, closed: "deleted" }).text).toBe("Ended");
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
