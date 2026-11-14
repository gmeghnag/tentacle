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
    expect(sendNowOffered(input({ ownQueue: 2 }))).toBe(false);
    expect(sendNowOffered(input({ ownQueue: 2, turn: OWN }))).toBe(true);
  });

  test("offered when my queue is non-empty, or when the field has text", () => {
    expect(sendNowOffered(input({ turn: OWN }))).toBe(false);
    expect(sendNowOffered(input({ turn: OWN, ownQueue: 1 }))).toBe(true);
    expect(sendNowOffered(input({ turn: OWN, text: "typed" }))).toBe(true);
  });

  test("NOT offered with photos and no text: a send-now cannot carry them (P4)", () => {
    // Mutation: ignore `photos` → red (a tap would silently drop the image).
    expect(sendNowOffered(input({ turn: OWN, photos: 1 }))).toBe(false);
    expect(sendNowOffered(input({ turn: OWN, photos: 1, ownQueue: 1 }))).toBe(true);
  });

  test("not offered when the session ended, or when the link is down", () => {
    expect(sendNowOffered(input({ turn: OWN, ownQueue: 1, ended: "closed" }))).toBe(false);
    expect(sendNowOffered(input({ turn: OWN, ownQueue: 1, link: "down" }))).toBe(false);
  });
});

describe("the photo notice (D1 row 4)", () => {
  test("it says what happens to the chips, not why the protocol forbids it", () => {
    expect(PHOTOS_NEXT_PROMPT).toContain("next prompt");
  });
});
