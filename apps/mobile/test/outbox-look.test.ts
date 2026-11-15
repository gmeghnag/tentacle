/**
 * The outbox rows' look (Slice 5, mockup `Offline`): every state of
 * `OutboxRowView` gets a cue, only a row a person must settle offers the
 * options button, and the group caption speaks for the waiting ones.
 */
import { describe, expect, test } from "bun:test";
import { outboxCaption, outboxRowLook } from "../src/outbox-look.ts";
import type { OutboxRowView } from "../src/session-view.ts";

function row(state: OutboxRowView["state"], itemId: string = state): OutboxRowView {
  return { itemId, text: "hi", state, decide: state === "needs-decision" };
}

describe("outboxRowLook", () => {
  test("a waiting row is the plain dashed bubble: no cue, the group caption explains it", () => {
    expect(outboxRowLook(row("waiting"))).toEqual({ cue: "none", status: null, options: false });
  });

  test("sending and uploading show a spinner with their own words", () => {
    expect(outboxRowLook(row("sending"))).toEqual({
      cue: "spinner",
      status: "Sending…",
      options: false,
    });
    expect(outboxRowLook(row("uploading"))).toEqual({
      cue: "spinner",
      status: "Uploading photos…",
      options: false,
    });
  });

  test("a row that needs a decision is marked and offers the options button", () => {
    expect(outboxRowLook(row("needs-decision"))).toEqual({
      cue: "attention",
      status: "Needs your answer",
      options: true,
    });
  });

  test("a row given back to the field says so (no cue, no options)", () => {
    expect(outboxRowLook(row("back-to-draft"))).toEqual({
      cue: "none",
      status: "Back in the message field",
      options: false,
    });
  });

  test("the options button follows `decide`, never the state alone", () => {
    const undecidable = { ...row("needs-decision"), decide: false };
    expect(outboxRowLook(undecidable).options).toBe(false);
  });
});

describe("outboxCaption", () => {
  test("no rows, no caption", () => {
    expect(outboxCaption([])).toBeNull();
  });

  test("any waiting row: the mockup's caption", () => {
    expect(outboxCaption([row("waiting", "a"), row("sending", "b")])).toBe(
      "Waiting for network · sent on reconnect if nothing changed",
    );
  });

  test("no waiting row: no caption (each row carries its own status)", () => {
    expect(outboxCaption([row("sending", "a"), row("needs-decision", "b")])).toBeNull();
  });
});
