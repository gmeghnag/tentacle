import { describe, expect, test } from "bun:test";
import { ATTACH_TIMEOUT_MS, AttachTimeoutError } from "@tentacle/client";
import { DomainErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import { attachFailureNotice } from "../src/attach-notice.ts";

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
