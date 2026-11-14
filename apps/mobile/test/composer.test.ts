/**
 * The composer's truth table (docs/feat/mobile-session-view.md 12c). Every case
 * is behavioural — what a tap DOES — never an implementation detail, so the
 * screen can be rewritten without touching these.
 */
import { describe, expect, test } from "bun:test";
import {
  type ComposerInput,
  FAILED_NOTICE,
  REFUSED_NOTICE,
  composerAction,
  restoreAfterFailure,
} from "../src/composer.ts";
import type { TurnRow } from "../src/transcript-rows.ts";

const OWN: TurnRow = { kind: "turn", key: "r1", turnId: "t-own", own: true };
const FOREIGN: TurnRow = { kind: "turn", key: "r2", turnId: "t-foreign", own: false };

const input = (over: Partial<ComposerInput> = {}): ComposerInput => ({
  link: "up",
  text: "",
  turn: null,
  ended: null,
  ...over,
});

describe("composerAction", () => {
  test("idle + up + text → send, with the text as typed (not trimmed)", () => {
    expect(composerAction(input({ text: " hello " }))).toEqual({ kind: "send", text: " hello " });
  });

  test("idle + up + blank (or whitespace only) → nothing, and blank is why", () => {
    expect(composerAction(input())).toEqual({ kind: "none", why: "blank" });
    expect(composerAction(input({ text: "   \n\t" }))).toEqual({ kind: "none", why: "blank" });
  });

  test("link down → nothing, and the text is KEPT (F12: the field is never cleared)", () => {
    const action = composerAction(input({ link: "down", text: "keep me" }));
    expect(action).toEqual({ kind: "none", why: "link" });
  });

  test("own turn + empty field → Stop for THAT turn (it is the phone's own abort)", () => {
    expect(composerAction(input({ turn: OWN }))).toEqual({
      kind: "stop",
      turnId: "t-own",
      own: true,
    });
  });

  test("FOREIGN turn + empty field → Stop for that turn id (decision 15, F10)", () => {
    expect(composerAction(input({ turn: FOREIGN }))).toEqual({
      kind: "stop",
      turnId: "t-foreign",
      own: false,
    });
  });

  test("a turn runs and something is typed → neither send nor stop: the text waits (steer is task 13)", () => {
    expect(composerAction(input({ turn: OWN, text: "typed" }))).toEqual({
      kind: "none",
      why: "turn",
    });
    expect(composerAction(input({ turn: FOREIGN, text: "typed" }))).toEqual({
      kind: "none",
      why: "turn",
    });
  });

  test("a turn runs on a DEAD link → no Stop (a cancel cannot travel), and it says turn", () => {
    // Cancel is a request over the wire: offering Stop on a dropped link would
    // be a button that does nothing when pressed hardest.
    expect(composerAction(input({ turn: OWN, link: "down" }))).toEqual({
      kind: "none",
      why: "turn",
    });
  });

  test("an ended session offers nothing, whatever else is true (F14)", () => {
    for (const ended of ["closed", "deleted", "gone"] as const) {
      expect(composerAction(input({ ended, text: "hello" }))).toEqual({
        kind: "none",
        why: "ended",
      });
      expect(composerAction(input({ ended, turn: OWN }))).toEqual({ kind: "none", why: "ended" });
    }
  });
});

describe("restoreAfterFailure (F13: a refused send puts the text back)", () => {
  test("an empty field gets the refused text whole", () => {
    expect(restoreAfterFailure("", "the refused words")).toBe("the refused words");
  });

  test("a whitespace-only field is replaced, not appended to", () => {
    expect(restoreAfterFailure("   ", "the refused words")).toBe("the refused words");
  });

  test("text typed SINCE the send is kept, with the refused text after it (never dropped)", () => {
    expect(restoreAfterFailure("new draft", "the refused words")).toBe(
      "new draft\nthe refused words",
    );
    expect(restoreAfterFailure("new draft\n", "the refused words")).toBe(
      "new draft\nthe refused words",
    );
  });

  test("nothing was sent: the field is untouched", () => {
    expect(restoreAfterFailure("as it was", "")).toBe("as it was");
  });

  test("the two notices say what happened, without daemon text", () => {
    expect(REFUSED_NOTICE).toContain("another device");
    expect(FAILED_NOTICE).toContain("back in the field");
  });
});
