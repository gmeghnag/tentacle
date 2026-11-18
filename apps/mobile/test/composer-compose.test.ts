/**
 * The composer's compose truth table (docs/feat/mobile-compose.md 13d, D1):
 * what the ONE button does when a turn runs, when the link is down, and when
 * photo chips are attached — plus whether Send now is offered beside it.
 *
 * Pure: the screen maps this value to elements, nothing is decided there.
 */
import { describe, expect, test } from "bun:test";
import {
  type ComposerInput,
  PHOTOS_NEXT_PROMPT,
  composerAction,
  sendNowOffered,
  sendSlot,
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

describe("D1: with the link UP", () => {
  test("idle + text → Send", () => {
    expect(composerAction(input({ text: "hi" }))).toEqual({ kind: "send", text: "hi" });
  });

  test("idle + only photos → Send (the chips go with it)", () => {
    // Mutation: require text for `send` → red (a photo alone could never be sent).
    expect(composerAction(input({ photos: 1 }))).toEqual({ kind: "send", text: "" });
  });

  test("a turn runs + text → Queue that text as a steer (13c's field rule is over)", () => {
    // Mutation: return `none`/`turn` → red.
    expect(composerAction(input({ turn: OWN, text: "typed" }))).toEqual({
      kind: "queue",
      text: "typed",
    });
    // A FOREIGN turn is steerable too (decision 5: any device may steer it).
    expect(composerAction(input({ turn: FOREIGN, text: "typed" }))).toEqual({
      kind: "queue",
      text: "typed",
    });
  });

  test("a turn runs + photos → Queue is DISABLED with the notice (P4: steers are text-only)", () => {
    // Mutation: allow `queue` with photos → red.
    expect(composerAction(input({ turn: OWN, text: "typed", photos: 1 }))).toEqual({
      kind: "none",
      why: "photos",
    });
    expect(composerAction(input({ turn: OWN, photos: 2 }))).toEqual({
      kind: "none",
      why: "photos",
    });
  });

  test("a turn runs + an empty field + no photos → Stop for that turn", () => {
    expect(composerAction(input({ turn: FOREIGN }))).toEqual({
      kind: "stop",
      turnId: "t-foreign",
      own: false,
    });
  });

  test("whitespace is not a message: a blank field is still Stop", () => {
    expect(composerAction(input({ turn: OWN, text: "  \n " }))).toEqual({
      kind: "stop",
      turnId: "t-own",
      own: true,
    });
  });
});

describe("D1: with the link DOWN", () => {
  test("text → Send later (the outbox item), never a lost tap (decision 16)", () => {
    // Mutation: answer `none`/`link` → red. The text is not lost either way, but
    // only Send later turns it into an item that goes out when the link returns.
    expect(composerAction(input({ link: "down", text: "later" }))).toEqual({
      kind: "send-later",
      text: "later",
    });
  });

  test("photos alone → Send later too", () => {
    expect(composerAction(input({ link: "down", photos: 1 }))).toEqual({
      kind: "send-later",
      text: "",
    });
  });

  test("a turn runs but its Stop cannot travel: an empty field does nothing", () => {
    // `session/cancel` is a request over the wire; on a dead link it cannot go.
    expect(composerAction(input({ link: "down", turn: OWN }))).toEqual({
      kind: "none",
      why: "turn",
    });
  });

  test("nothing typed → nothing, and the reason names the field", () => {
    expect(composerAction(input({ link: "down" }))).toEqual({ kind: "none", why: "link" });
  });
});

describe("an ended session offers nothing at all (F14)", () => {
  test("whatever else is true", () => {
    for (const ended of ["closed", "deleted", "gone"] as const) {
      expect(composerAction(input({ ended, text: "hi", photos: 2 }))).toEqual({
        kind: "none",
        why: "ended",
      });
      expect(composerAction(input({ ended, turn: OWN }))).toEqual({ kind: "none", why: "ended" });
      expect(composerAction(input({ ended, link: "down", text: "x" }))).toEqual({
        kind: "none",
        why: "ended",
      });
    }
  });
});

describe("Send now (D1's secondary button)", () => {
  test("offered only while a turn runs", () => {
    expect(sendNowOffered(input({ ownPending: 2 }))).toBe(false);
    expect(sendNowOffered(input({ ownPending: 2, turn: OWN }))).toBe(true);
  });

  test("offered when MY pending (queued) rows exist — the typed text NO longer offers it", () => {
    // Owner Q2: Send now appears ONLY while a message of mine is pending, not
    // merely while typing during a turn. Mutation: keep the `text` trigger → red.
    expect(sendNowOffered(input({ turn: OWN }))).toBe(false);
    expect(sendNowOffered(input({ turn: OWN, ownPending: 1 }))).toBe(true);
    expect(sendNowOffered(input({ turn: OWN, text: "typed" }))).toBe(false);
  });

  test("a row already in flight does not offer it: `ownPending` counts `queued` only", () => {
    // The `sending` rows are the send-now's own: it "left the composer". The
    // COUNT is the caller's (compose-controller/session-view filter `queued`).
    expect(sendNowOffered(input({ turn: OWN, ownPending: 0 }))).toBe(false);
  });

  test("photos alone never offer it, and no longer block it when a row is pending", () => {
    // Mutation: bring back the photo clause → red.
    expect(sendNowOffered(input({ turn: OWN, photos: 1 }))).toBe(false);
    expect(sendNowOffered(input({ turn: OWN, photos: 1, ownPending: 1 }))).toBe(true);
  });

  test("not offered when the session ended, or when the link is down", () => {
    expect(sendNowOffered(input({ turn: OWN, ownPending: 1, ended: "closed" }))).toBe(false);
    expect(sendNowOffered(input({ turn: OWN, ownPending: 1, link: "down" }))).toBe(false);
  });
});

describe("the send slot (D4, owner Q5)", () => {
  test("is a TOTAL map of composerAction: every kind has its glyph", () => {
    // Mutation: make the default return "up-dim" for `stop` too → red (a running
    // turn with an empty field would look like a dead ↑, not ■).
    expect(sendSlot({ kind: "send", text: "x" })).toBe("up");
    expect(sendSlot({ kind: "queue", text: "x" })).toBe("up");
    expect(sendSlot({ kind: "send-later", text: "x" })).toBe("clock");
    expect(sendSlot({ kind: "stop", turnId: "t", own: true })).toBe("stop");
    expect(sendSlot({ kind: "none", why: "blank" })).toBe("up-dim");
  });

  test("agrees with the real truth table in every state it can be asked in", () => {
    const states: readonly Partial<ComposerInput>[] = [
      { text: "hi" },
      { photos: 1 },
      { turn: OWN, text: "typed" },
      { turn: OWN },
      { turn: OWN, ownPending: 1 },
      { link: "down", text: "kept" },
      { link: "down", turn: OWN },
      { link: "down" },
      { ended: "closed", text: "x" },
    ];
    for (const over of states) {
      const action = composerAction(input(over));
      const slot = sendSlot(action);
      // Q5: typed text while a turn runs stays ↑ (queue), never ■.
      if (action.kind === "queue") {
        expect(slot).toBe("up");
      }
      // ■ only on a running turn with an EMPTY field.
      if (slot === "stop") {
        expect(action.kind).toBe("stop");
        expect((over.text ?? "").trim()).toBe("");
      }
    }
  });
});

describe("the photo notice (D1 row 4)", () => {
  test("it says what happens to the chips, not why the protocol forbids it", () => {
    expect(PHOTOS_NEXT_PROMPT).toContain("next prompt");
  });
});
