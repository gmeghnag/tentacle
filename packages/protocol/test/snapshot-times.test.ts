/**
 * `SnapshotResult.times` (docs/fix/mobile-open-at-end.md, slice B): each
 * message's ARRIVAL time, index-aligned with `messages`, `0` = not known.
 * A strip schema: an older daemon sends none (free new field, AGENTS §7), and a
 * client that does not know it drops it. Display-only — nothing is persisted
 * from it.
 */
import { describe, expect, test } from "bun:test";
import { SnapshotResultSchema } from "../src/session.ts";

const message = (content: string) => ({ role: "user" as const, content });

describe("SnapshotResult.times", () => {
  test("parses with the arrival times", () => {
    const snap = SnapshotResultSchema.parse({
      messages: [message("a"), message("b")],
      times: [1_700_000_000_000, 0],
    });
    expect(snap.times).toEqual([1_700_000_000_000, 0]);
  });

  test("parses without it (an older daemon), and without the key at all", () => {
    expect(SnapshotResultSchema.parse({ messages: [message("a")] }).times).toBeUndefined();
    expect(
      SnapshotResultSchema.parse({ messages: [message("a")], times: undefined }).times,
    ).toBeUndefined();
  });

  test("rejects a non-integer, a negative, and a non-number", () => {
    for (const times of [[1.5], [-1], ["1"]]) {
      expect(SnapshotResultSchema.safeParse({ messages: [message("a")], times }).success).toBe(
        false,
      );
    }
  });

  test("a length mismatch is NOT the schema's business (the client drops the pairing)", () => {
    // The schema cannot know how many rows a page holds; `readSnapshotPages`
    // refuses the whole array when a page's length differs (snapshot-times.test.ts).
    const snap = SnapshotResultSchema.parse({ messages: [message("a")], times: [1, 2] });
    expect(snap.times).toEqual([1, 2]);
  });
});
