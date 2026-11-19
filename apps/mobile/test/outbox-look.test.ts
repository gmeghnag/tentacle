/**
 * The outbox rows' look (Slice 5, mockup `Offline`; the upload states added by
 * feat/mobile-thinking-images S4): every state of `OutboxRowView` gets a cue,
 * only a row a person must settle offers the options button, the group caption
 * speaks for the waiting ones, and an upload in flight reads its own percent
 * ("Sending… 62 %") or an indeterminate spinner.
 *
 * Each test names the mutation it is red on (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import { outboxCaption, outboxRowLook } from "../src/outbox-look.ts";
import type { OutboxRowView } from "../src/session-view.ts";

function row(over: Partial<OutboxRowView> = {}): OutboxRowView {
  const state = over.state ?? "waiting";
  return {
    itemId: state,
    text: "hi",
    state,
    decide: state === "needs-decision",
    photos: [],
    progress: null,
    unsentPhotos: false,
    ...over,
  };
}

describe("outboxRowLook", () => {
  test("a waiting row is the plain dashed bubble: no cue, the group caption explains it", () => {
    expect(outboxRowLook(row())).toEqual({
      cue: "none",
      status: null,
      options: false,
      retry: false,
      percent: null,
    });
  });

  test("sending and uploading show a spinner with their own words", () => {
    expect(outboxRowLook(row({ state: "sending" }))).toEqual({
      cue: "spinner",
      status: "Sending…",
      options: false,
      retry: false,
      percent: null,
    });
    // No report yet: indeterminate, never a fake 0 % (mutation: default 0 → a ring
    // that never moves while the bytes are going up).
    expect(outboxRowLook(row({ state: "uploading" }))).toEqual({
      cue: "spinner",
      status: "Uploading photos…",
      options: false,
      retry: false,
      percent: null,
    });
  });

  test("an upload with a reported fraction says its percent (mutation: drop `progress` → the row never says how far it is)", () => {
    expect(outboxRowLook(row({ state: "uploading", progress: 0.62 }))).toEqual({
      cue: "spinner",
      status: "Sending… 62%",
      options: false,
      retry: false,
      percent: 62,
    });
  });

  test("the percent is a whole, clamped number (a daemon may confirm more bytes than it was told)", () => {
    expect(outboxRowLook(row({ state: "uploading", progress: 0 })).percent).toBe(0);
    expect(outboxRowLook(row({ state: "uploading", progress: 0 })).status).toBe("Sending… 0%");
    expect(outboxRowLook(row({ state: "uploading", progress: 1 })).percent).toBe(100);
    expect(outboxRowLook(row({ state: "uploading", progress: 1.4 })).percent).toBe(100);
    expect(outboxRowLook(row({ state: "uploading", progress: -0.2 })).percent).toBe(0);
    expect(outboxRowLook(row({ state: "uploading", progress: Number.NaN })).percent).toBeNull();
  });

  test("a row that needs a decision is marked and offers the options button", () => {
    expect(outboxRowLook(row({ state: "needs-decision" }))).toEqual({
      cue: "attention",
      status: "Needs your answer",
      options: true,
      retry: false,
      percent: null,
    });
  });

  test("a photo that never reached the daemon reads 'Not sent' and offers Retry (mutation: label every decision 'Needs your answer' → no way to retry the upload)", () => {
    expect(outboxRowLook(row({ state: "needs-decision", unsentPhotos: true }))).toEqual({
      cue: "attention",
      status: "Not sent",
      options: true,
      retry: true,
      percent: null,
    });
  });

  test("a row given back to the field says so (no cue, no options)", () => {
    expect(outboxRowLook(row({ state: "back-to-draft" }))).toEqual({
      cue: "none",
      status: "Back in the message field",
      options: false,
      retry: false,
      percent: null,
    });
  });

  test("the options button follows `decide`, never the state alone", () => {
    const undecidable = row({ state: "needs-decision", decide: false });
    expect(outboxRowLook(undecidable).options).toBe(false);
  });

  test("a percent on a row that is not uploading changes nothing (it is the upload's reading)", () => {
    expect(outboxRowLook(row({ state: "sending", progress: 0.5 }))).toEqual({
      cue: "spinner",
      status: "Sending…",
      options: false,
      retry: false,
      percent: 50,
    });
    expect(outboxRowLook(row({ state: "waiting", progress: 0.5 })).status).toBeNull();
  });
});

describe("outboxCaption", () => {
  test("no rows, no caption", () => {
    expect(outboxCaption([])).toBeNull();
  });

  test("any waiting row: the mockup's caption", () => {
    expect(outboxCaption([row({ itemId: "a" }), row({ itemId: "b", state: "sending" })])).toBe(
      "Waiting for network · sent on reconnect if nothing changed",
    );
  });

  test("no waiting row: no caption (each row carries its own status)", () => {
    expect(
      outboxCaption([
        row({ itemId: "a", state: "sending" }),
        row({ itemId: "b", state: "needs-decision" }),
      ]),
    ).toBeNull();
  });
});
