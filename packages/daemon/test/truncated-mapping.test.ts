/**
 * Both ends of the two new notices, round-tripped through the wire
 * (docs/fix/truncated-reply-silent.md; AGENTS §7: a new `session/update` variant
 * needs a union member AND its reverse mapping).
 *
 * RED before the fix: neither event nor update existed, so both directions had
 * no arm at all (a `never` assignment error, or a null update).
 */
import { describe, expect, test } from "bun:test";
import { KNOWN_UPDATE_TYPES, SessionUpdateSchema, UPDATE_CLASS } from "@tentacle/protocol";
import { eventToUpdate, toUpdateParams } from "../src/mapping.ts";

describe("daemon: AgentEvent → SessionUpdate", () => {
  test("a cut reply is its own display kind, reason carried", () => {
    expect(eventToUpdate({ type: "truncated_reply", reason: "length" })).toEqual({
      type: "truncated_reply",
      reason: "length",
    });
    expect(eventToUpdate({ type: "truncated_reply", reason: "cut" })).toEqual({
      type: "truncated_reply",
      reason: "cut",
    });
    expect(UPDATE_CLASS.truncated_reply).toBe("display");
  });

  test("an empty turn is its own display kind", () => {
    expect(eventToUpdate({ type: "empty_turn" })).toEqual({ type: "empty_turn" });
    expect(UPDATE_CLASS.empty_turn).toBe("display");
  });

  test("both pass the wire schema, and a mandatory frame is never needed for them", () => {
    for (const update of [
      { type: "truncated_reply", reason: "length" } as const,
      { type: "empty_turn" } as const,
    ]) {
      expect(SessionUpdateSchema.safeParse(update).success).toBe(true);
      expect(KNOWN_UPDATE_TYPES).toContain(update.type);
      const params = toUpdateParams("s1", 3, update);
      expect(params.update).toEqual(update);
      // Nothing waits on a notice.
      expect(params.mandatory).toBeUndefined();
    }
  });
});
