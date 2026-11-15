/**
 * docs/feat/app-decomposition.md S11 — `hopReady`, the ONE turn-boundary rule
 * (docs/feat/session-hop.md D4).
 *
 * The rule existed twice before this slice: once inside `hopStep` (which decides
 * what a TYPED `/move` does now) and once inline in `hopIfQueued` (which re-checks
 * it at the first true idle, then starts the queued hop). Two copies of "may a hop
 * start now?" is how the queued path and the typed path drift into disagreeing —
 * and a disagreement here starts a hop in the middle of a turn, or leaves a
 * queued one forgotten forever.
 *
 * The cases below are the ones that actually go wrong, not the happy path
 * (AGENTS §9): the queue is the half a naive implementation drops, `> 0` is not
 * truthiness (a negative is not rows), and "busy" must be the SAME answer on both
 * callers or the boundary is not shared.
 */
import { describe, expect, test } from "bun:test";
import { hopReady } from "../src/hop-command.ts";

describe("S11 `hopReady`: the one turn-boundary rule", () => {
  test("idle and empty: a hop may start", () => {
    expect(hopReady({ running: false, queued: 0 })).toBe(true);
  });

  test("a turn in flight defers it", () => {
    expect(hopReady({ running: true, queued: 0 })).toBe(false);
  });

  test("the daemon's queue is FULL even with no turn running (queued messages run first)", () => {
    // The half a naive `if (running)` drops: the daemon still owes a turn, so a
    // hop started now would move the session out from under it.
    expect(hopReady({ running: false, queued: 2 })).toBe(false);
    expect(hopReady({ running: false, queued: 1 })).toBe(false);
  });

  test("both busy is still one answer", () => {
    expect(hopReady({ running: true, queued: 3 })).toBe(false);
  });

  test("`queued` is a COUNT, compared to zero — not a truthiness test", () => {
    // A `queued > 0` written as `queued` would make a negative "busy" (nothing
    // counts negatives, but the predicate must be the number's sign, not its
    // truth): 0 rows is idle, in both directions.
    expect(hopReady({ running: false, queued: 0 })).toBe(true);
    expect(hopReady({ running: false, queued: -1 })).toBe(true);
  });
});
