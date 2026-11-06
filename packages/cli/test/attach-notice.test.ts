import { describe, expect, test } from "bun:test";
import { ATTACH_TIMEOUT_MS, AttachTimeoutError } from "@tentacle/client";
import { DomainErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { attachFailureNotice, unflushedExitsNotice } from "../src/attach-notice.ts";

// docs/feat/session-settings-apply.md S3: the plain attach's bound is never silent.
describe("attachFailureNotice", () => {
  test("the attach bound: one host notice, the session opens at the first prompt", () => {
    // Mutation: return null for it → the plain path falls back silently.
    expect(attachFailureNotice(new AttachTimeoutError(ATTACH_TIMEOUT_MS))).toBe(
      "Could not attach to the session: no answer from the container within 30s. It opens at your first prompt.",
    );
  });

  test("any other failure keeps today's quiet lazy fallback", () => {
    expect(attachFailureNotice(new RpcError(DomainErrorCode.UnknownSession, "x"))).toBeNull();
    expect(attachFailureNotice(new Error("connection closed"))).toBeNull();
  });
});

// docs/fix/attach-unflushed-exits.md R3.
describe("unflushedExitsNotice", () => {
  test("null for 0, singular for 1, plural above, the count only", () => {
    expect(unflushedExitsNotice(0)).toBeNull();
    expect(unflushedExitsNotice(1)).toBe("1 background job ended while you were away.");
    expect(unflushedExitsNotice(3)).toBe("3 background jobs ended while you were away.");
  });
});
