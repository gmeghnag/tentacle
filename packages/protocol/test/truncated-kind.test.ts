/**
 * The two new notices are DISPLAY kinds, so no `PROTOCOL_VERSION` bump
 * (docs/fix/truncated-reply-silent.md, owner Q3a/Q5a; AGENTS §7 "display: free
 * to add").
 *
 * The trap this pins — the same one `dsml-leak-kind.test.ts` pins for its own
 * notice — is emitting either as a new `context_note.reason`: an older client
 * then sees a KNOWN kind whose member fails its schema and reports
 * `malformed context_note` mid-turn, an error. A new display KIND is skipped as
 * `unsupported` instead, once.
 *
 * RED before the fix: neither tag existed, so this build's union refused the
 * frames and `PROTOCOL_VERSION` had nothing to protect.
 */
import { describe, expect, test } from "bun:test";
import {
  KNOWN_UPDATE_TYPES,
  PROTOCOL_VERSION,
  SessionUpdateOrUnknownSchema,
  SessionUpdateSchema,
  UPDATE_CLASS,
  UnknownSessionUpdateSchema,
  clientSupportsUpdate,
} from "../src/index.ts";

const FRAMES = [
  { type: "truncated_reply", reason: "length" },
  { type: "truncated_reply", reason: "cut" },
  { type: "empty_turn" },
];

describe("the truncation and empty-turn notices are their own display KINDS", () => {
  test("this build knows both: in the union, class display", () => {
    for (const frame of FRAMES) {
      expect(SessionUpdateSchema.safeParse(frame).success).toBe(true);
    }
    expect(UPDATE_CLASS.truncated_reply).toBe("display");
    expect(UPDATE_CLASS.empty_turn).toBe("display");
    expect(KNOWN_UPDATE_TYPES).toContain("truncated_reply");
    expect(KNOWN_UPDATE_TYPES).toContain("empty_turn");
  });

  test("no protocol bump: a display kind is free to add", () => {
    // Display only, so no bump by this kind (AGENTS §7). A FLOOR: the exact
    // number is assigned at merge (docs/feat/protocol-version-at-merge.md).
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(23);
  });

  test("`context_note` keeps an OLDER client's reason enum: no member was added", () => {
    for (const reason of ["continue", "background_exit", "hook"]) {
      expect(
        SessionUpdateSchema.safeParse({ type: "context_note", text: "x", reason }).success,
      ).toBe(true);
    }
    for (const reason of ["truncated_reply", "empty_turn", "length", "cut"]) {
      expect(
        SessionUpdateSchema.safeParse({ type: "context_note", text: "x", reason }).success,
      ).toBe(false);
    }
  });

  test("an OLDER client skips both as `unsupported`, never fails on them", () => {
    const older = KNOWN_UPDATE_TYPES.filter(
      (type) => type !== "truncated_reply" && type !== "empty_turn",
    );
    for (const frame of FRAMES) {
      expect(clientSupportsUpdate(older, frame.type)).toBe(false);
      expect(UnknownSessionUpdateSchema.safeParse(frame).success).toBe(true);
      expect(SessionUpdateOrUnknownSchema.safeParse(frame).success).toBe(true);
    }
  });

  test("a truncated_reply needs its reason: an unknown one is malformed, not skipped", () => {
    // A KNOWN tag with a bad member is `malformed` (an error) — the tag must not
    // be reused for a future shape without a version bump.
    expect(SessionUpdateSchema.safeParse({ type: "truncated_reply" }).success).toBe(false);
    expect(SessionUpdateSchema.safeParse({ type: "truncated_reply", reason: "x" }).success).toBe(
      false,
    );
  });

  test("`retrying` is OPTIONAL on the kind: an older daemon's frame still parses (Review MEDIUM-2)", () => {
    // An extra field on a display kind is free (AGENTS §7), and the reverse —
    // a frame that lacks it — must keep parsing: a new client never refuses an
    // older daemon's notice over a field it can live without.
    for (const reason of ["length", "cut"]) {
      expect(SessionUpdateSchema.safeParse({ type: "truncated_reply", reason }).success).toBe(true);
      expect(
        SessionUpdateSchema.safeParse({ type: "truncated_reply", reason, retrying: true }).success,
      ).toBe(true);
    }
    expect(
      SessionUpdateSchema.safeParse({ type: "truncated_reply", reason: "length", retrying: "yes" })
        .success,
    ).toBe(false);
  });
});
