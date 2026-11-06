import { describe, expect, test } from "bun:test";
import { unflushedExitsNotice } from "../src/attach-notice.ts";

describe("unflushedExitsNotice", () => {
  test("null for 0, singular for 1, plural above, the count only", () => {
    expect(unflushedExitsNotice(0)).toBeNull();
    expect(unflushedExitsNotice(1)).toBe("1 background job ended while you were away.");
    expect(unflushedExitsNotice(3)).toBe("3 background jobs ended while you were away.");
  });
});
