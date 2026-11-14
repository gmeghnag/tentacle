/**
 * OD6 (docs/feat/session-hop-ux): after a move, the session CONTINUES by itself.
 * The owner's requirement is that no typing is needed — the model is woken with
 * one short message naming where it now is (the laptop's `hopWakeLine`), so it
 * does not sit idle guessing whether the move happened.
 *
 * This module is the DECISION only (AGENTS §7: logic in a pure module, the
 * component renders): given where the hop came from and what happened, do we
 * wake, or hold the line for the user's next prompt? The executor (`App` /
 * `useHop`) does the sending, because only it owns the turn.
 *
 * The rules, in order:
 *   - a `/move` typed at TRUE IDLE does not wake anybody: the user is there, and
 *     the next thing they type carries the line (today's behaviour, unchanged);
 *   - a MODEL-proposed move, or a `/move` typed mid-task (a queued turn, D4),
 *     wakes: the work was in flight, and the move must not silently end it;
 *   - a chain of 3 wakes with no user prompt between them stops (`HOP_WAKE_CHAIN_MAX`):
 *     a model that proposes a move on every wake must not spin forever.
 */
import { describe, expect, test } from "bun:test";
import { HOP_WAKE_CHAIN_MAX, HOP_WAKE_ROW, HOP_WAKE_TEXT, hopWakeStep } from "../src/hop-wake.ts";

// docs/feat/session-hop-ux OD6: when a settled hop wakes the model by itself.
describe("hopWakeStep", () => {
  test("proposal × {moved, failed, declined} ⇒ wake", () => {
    for (const outcome of ["moved", "failed", "declined"] as const) {
      expect(hopWakeStep({ origin: "proposal", outcome, chain: 0 })).toBe("wake");
    }
  });

  test("queued (a /move typed mid-task) moved/failed ⇒ wake; declined ⇒ hold", () => {
    // A REFUSED typed hop is the owner's own doing and they are looking at it.
    expect(hopWakeStep({ origin: "queued", outcome: "moved", chain: 0 })).toBe("wake");
    expect(hopWakeStep({ origin: "queued", outcome: "failed", chain: 0 })).toBe("wake");
    expect(hopWakeStep({ origin: "queued", outcome: "declined", chain: 0 })).toBe("hold");
  });

  test("idle (a /move typed with nothing pending) ⇒ hold, whatever happened", () => {
    // Mutation: wake on `idle` → this whole row fails (and a plain `/move` at
    // rest would start a turn nobody asked for).
    for (const outcome of ["moved", "failed", "declined"] as const) {
      expect(hopWakeStep({ origin: "idle", outcome, chain: 0 })).toBe("hold");
    }
  });

  test("the chain cap: the Nth consecutive wake still fires, the next holds", () => {
    // Mutation: drop the cap → `chain: 3` wakes and a bad model can loop forever.
    expect(
      hopWakeStep({ origin: "proposal", outcome: "moved", chain: HOP_WAKE_CHAIN_MAX - 1 }),
    ).toBe("wake");
    expect(hopWakeStep({ origin: "proposal", outcome: "moved", chain: HOP_WAKE_CHAIN_MAX })).toBe(
      "hold",
    );
    expect(hopWakeStep({ origin: "proposal", outcome: "moved", chain: 99 })).toBe("hold");
  });

  test("the wake prompt and the row it paints are one short line each", () => {
    expect(HOP_WAKE_TEXT).toBe("Continue the task from here.");
    expect(HOP_WAKE_TEXT).not.toContain("\n");
    expect(HOP_WAKE_ROW).not.toContain("\n");
    // The row says what happened, so a reader is not surprised by a turn starting.
    expect(HOP_WAKE_ROW).toContain("continu");
  });
});
