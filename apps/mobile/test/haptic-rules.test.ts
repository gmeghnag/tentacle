/**
 * When the app taps the person's hand (Owner decision 4, Slice 6): a light tap
 * for a message that leaves, a firmer one for Stop, a success when a turn ends,
 * nothing for a no-op — and the Return key never "feels" like a Stop.
 */
import { describe, expect, test } from "bun:test";
import type { ComposerAction } from "../src/composer.ts";
import { pressHaptic, turnEndHaptic } from "../src/haptic-rules.ts";

const send: ComposerAction = { kind: "send", text: "hi" };
const queue: ComposerAction = { kind: "queue", text: "hi" };
const later: ComposerAction = { kind: "send-later", text: "hi" };
const stop: ComposerAction = { kind: "stop", turnId: "t1", own: true };
const none: ComposerAction = { kind: "none", why: "blank" };

describe("pressHaptic", () => {
  test("the button: a light tap when words leave, a firm one for Stop, nothing for a no-op", () => {
    expect(pressHaptic(send, "button")).toBe("light");
    expect(pressHaptic(queue, "button")).toBe("light");
    expect(pressHaptic(later, "button")).toBe("light");
    expect(pressHaptic(stop, "button")).toBe("firm");
    expect(pressHaptic(none, "button")).toBeNull();
  });

  test("Return: the same as the button for what it sends, but never for a Stop it does not do", () => {
    expect(pressHaptic(send, "return")).toBe("light");
    expect(pressHaptic(queue, "return")).toBe("light");
    expect(pressHaptic(stop, "return")).toBeNull();
    expect(pressHaptic(none, "return")).toBeNull();
  });
});

describe("turnEndHaptic", () => {
  test("a turn that was running and now is not: success", () => {
    expect(turnEndHaptic(true, false)).toBe("success");
  });

  test("no change, or a turn starting: nothing", () => {
    expect(turnEndHaptic(false, false)).toBeNull();
    expect(turnEndHaptic(true, true)).toBeNull();
    expect(turnEndHaptic(false, true)).toBeNull();
  });
});
