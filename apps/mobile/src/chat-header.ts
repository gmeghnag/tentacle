/**
 * The chat header's status line (mockup `Conversation`: `Running` with an
 * accent dot, `Offline`, …), from facts the screen already holds — the attach
 * phase, the link, the running turn, the session's end — plus the context ring's
 * geometry (docs/feat/mobile-chrome.md A1/S2). Pure and React-free (AGENTS §7);
 * `SessionScreen.tsx` only draws the dot, the word and the ring.
 */
import type { StatusTone } from "./ui/StatusDot.tsx";

export interface ChatFacts {
  readonly phase: "opening" | "open" | "failed";
  readonly link: "up" | "down";
  readonly running: boolean;
  /** The session ended (closed / deleted / archived): its reason, or null. */
  readonly closed: string | null;
}

export interface ChatStatus {
  readonly text: string;
  readonly tone: StatusTone;
}

/** Most specific first: an attach problem, then the link, then the session. */
export function chatStatus(facts: ChatFacts): ChatStatus {
  if (facts.phase === "opening") {
    return { text: "Connecting…", tone: "offline" };
  }
  if (facts.phase === "failed") {
    return { text: "Not connected", tone: "attention" };
  }
  if (facts.link === "down") {
    return { text: "Offline", tone: "offline" };
  }
  if (facts.closed !== null) {
    return { text: "Ended", tone: "offline" };
  }
  if (facts.running) {
    return { text: "Running", tone: "running" };
  }
  return { text: "Idle", tone: "online" };
}

/** The ring's arc colour: `accent`, or `orange` from 80% up (the bar's old rule). */
export type RingTone = "accent" | "orange";

export interface RingArcs {
  /** Rotation of the right half-ring, 0–180. */
  readonly rightDeg: number;
  /** Rotation of the left half-ring, 0–180 (0 until the right half is full). */
  readonly leftDeg: number;
  readonly tone: RingTone;
}

/**
 * The header's 20 pt context ring, as two half-ring rotations
 * (docs/feat/mobile-chrome.md Design 2). The ring is built from plain `View`s —
 * no `react-native-svg`, so no native rebuild — and a half-ring clipped to a
 * 180° window reads as a fraction of the circle. The first 50% fills the right
 * half, the rest the left, so the two rotations never overdraw; that keeps the
 * mapping monotonic and each arc readable on its own.
 *
 * `percent` is the same number the old flat bar read
 * (`state.view.headerContext.percent`). Anything unreadable — NaN, a negative —
 * is 0 rather than a broken transform; over 100 clamps to a full ring.
 */
export function ringArcs(percent: number): RingArcs {
  const pct = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const rightDeg = Math.min(pct, 50) * 3.6;
  const leftDeg = Math.max(0, pct - 50) * 3.6;
  return { rightDeg, leftDeg, tone: pct >= 80 ? "orange" : "accent" };
}

/**
 * The ring's VoiceOver label (F11: the ring must say what it means). Rounded like
 * the bar's own reading; an absent figure is 0, never a made-up number.
 */
export function ringLabel(percent: number): string {
  const pct = Number.isFinite(percent) ? Math.round(Math.min(100, Math.max(0, percent))) : 0;
  return `Context ${pct}%`;
}

export interface RingHalfRotation {
  /** Clockwise rotation of the right half's 180° arc, in degrees. */
  readonly right: number;
  /** Clockwise rotation of the left half's 180° arc, in degrees. */
  readonly left: number;
}

/**
 * The two rotations `ContextRing` applies, derived once here so the geometry is
 * pinned by a test instead of living as magic numbers in a component (§7).
 *
 * Each half is ONE clipped 180° window over a full-size box whose arc — a ring
 * with `borderTopColor` + `borderLeftColor`, i.e. the 10:30-centred 180° arc —
 * is rotated about the ring's centre. Rotating that arc by `θ` makes its overlap
 * with a fixed 180° window equal to `θ` over `θ ∈ [0, 180]`, monotonically (at 0
 * the arc is exactly the window's opposite half — nothing visible; at 180 it is
 * the window — all of it visible).
 *
 * Verified numerically, not by eye: sampling all 36 000 half-degrees of the
 * circle for the right window (12 → 6 o'clock, base 315) and the left
 * (6 → 12 o'clock, base 135) gives `[0, 90, 180, 90, 180]` visible degrees at
 * `[0, 25, 50, 75, 100]`% — i.e. `visible = rightDeg` and `= leftDeg` exactly, sum
 * `= 3.6 × percent`. The sweep therefore grows clockwise from 12 o'clock down the
 * right side, then continues from 6 o'clock up the left.
 */
export function ringHalfRotation(arcs: RingArcs): RingHalfRotation {
  return { right: 315 + arcs.rightDeg, left: 135 + arcs.leftDeg };
}
