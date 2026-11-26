/**
 * The composer's SHAPE (docs/feat/mobile-composer-compact.md): empty and
 * untouched the field is ONE row (OD1), it opens on focus and stays open while
 * it holds something (OD3/D1), and the dimmed ↑ that did nothing is not drawn on
 * the resting row (OD2). The rule is `composer-shape.ts`'s, React-free, so the
 * whole truth table is pinned here without a simulator (AGENTS §7).
 */
import { describe, expect, test } from "bun:test";
import { type ComposerShapeInput, composerHolds, composerShape } from "../src/composer-shape.ts";
import type { SendSlot } from "../src/composer.ts";
import type { MicButton } from "../src/dictation.ts";

const HINT = "Message tentacle";

const input = (over: Partial<ComposerShapeInput> = {}): ComposerShapeInput => ({
  focused: false,
  draft: "",
  attachments: 0,
  mic: "idle",
  editing: false,
  slot: "up-dim",
  sendNow: false,
  placeholder: HINT,
  ...over,
});

const shapeOf = (over: Partial<ComposerShapeInput> = {}) => composerShape(input(over));

describe("one row at rest (OD1), today's two rows once it holds anything (OD3)", () => {
  test("empty, untouched, nothing to send: compact — and the dimmed ↑ is gone (OD2)", () => {
    expect(shapeOf()).toEqual({ shape: "compact", slotShown: false, placeholder: HINT });
  });

  test("focused and empty: open, with today's dimmed ↑ (D2: the open shape is unchanged)", () => {
    expect(shapeOf({ focused: true })).toEqual({
      shape: "open",
      slotShown: true,
      placeholder: HINT,
    });
  });

  test("a draft keeps it open, blur or not — whitespace counts (D1)", () => {
    for (const draft of ["x", " ", "\n", "a longer thought"]) {
      expect(shapeOf({ draft })).toEqual({ shape: "open", slotShown: true, placeholder: HINT });
    }
  });

  test("an attachment keeps it open whatever the chip's state (D1)", () => {
    expect(shapeOf({ attachments: 1 }).shape).toBe("open");
    expect(shapeOf({ attachments: 3 }).shape).toBe("open");
  });

  test("a dictation keeps it open while it is not idle (D1, D5)", () => {
    for (const mic of ["preparing", "listening", "finalizing"] as const) {
      expect(shapeOf({ mic }).shape).toBe("open");
    }
    for (const mic of ["idle", "hidden"] as const) {
      expect(shapeOf({ mic }).shape).toBe("compact");
    }
  });

  test("editing a pending message keeps it open (D1: the banner is above the field)", () => {
    expect(shapeOf({ editing: true }).shape).toBe("open");
  });
});

describe("the resting row still carries every ACTION, and drops only the dead one", () => {
  test("■ Stop sits on the compact row and does not open the field (D3)", () => {
    expect(shapeOf({ slot: "stop" })).toEqual({
      shape: "compact",
      slotShown: true,
      placeholder: HINT,
    });
  });

  test("↑ (a draft) and the clock (outbox) are actions too: shown on any shape", () => {
    // A draft ⇒ open anyway; the clock can rest on a compact row only while a
    // link is down and nothing is typed… which is a compact row with an action.
    expect(shapeOf({ slot: "clock" })).toEqual({
      shape: "compact",
      slotShown: true,
      placeholder: HINT,
    });
  });

  test("Send now keeps the pill and drops the hint on a compact row (D4)", () => {
    expect(shapeOf({ sendNow: true, slot: "stop" })).toEqual({
      shape: "compact",
      slotShown: true,
      placeholder: "",
    });
    // Open: the hint is the screen's, pill or not (D4 is about the closed row).
    expect(shapeOf({ sendNow: true, focused: true }).placeholder).toBe(HINT);
  });

  test("the open shape is today, always: every slot is shown (D2)", () => {
    const slots: readonly SendSlot[] = ["up", "up-dim", "stop", "clock"];
    for (const slot of slots) {
      for (const over of [
        { focused: true, slot },
        { draft: "x", slot },
        { attachments: 1, slot },
        { mic: "listening" as MicButton, slot },
        { editing: true, slot },
      ]) {
        expect(composerShape(input(over))).toMatchObject({ shape: "open", slotShown: true });
      }
    }
  });
});

describe("`composerHolds` is the only definition of “holds something” (D1)", () => {
  test("it agrees with the table, one field at a time", () => {
    expect(composerHolds({ draft: "", attachments: 0, mic: "idle", editing: false })).toBe(false);
    expect(composerHolds({ draft: " ", attachments: 0, mic: "idle", editing: false })).toBe(true);
    expect(composerHolds({ draft: "", attachments: 1, mic: "idle", editing: false })).toBe(true);
    for (const mic of ["preparing", "listening", "finalizing"] as const) {
      expect(composerHolds({ draft: "", attachments: 0, mic, editing: false })).toBe(true);
    }
    expect(composerHolds({ draft: "", attachments: 0, mic: "hidden", editing: false })).toBe(false);
    expect(composerHolds({ draft: "", attachments: 0, mic: "idle", editing: true })).toBe(true);
  });

  test("the shape never opens for a state `composerHolds` denies, nor closes for one it holds", () => {
    const states: readonly ComposerShapeInput[] = [
      input({ focused: true }),
      input({ draft: "x" }),
      input({ attachments: 2 }),
      input({ mic: "preparing" }),
      input({ mic: "finalizing" }),
      input({ editing: true }),
      input(),
      input({ mic: "hidden" }),
    ];
    for (const state of states) {
      const holds = composerHolds(state);
      expect(composerShape(state).shape === "open").toBe(state.focused || holds);
    }
  });
});
