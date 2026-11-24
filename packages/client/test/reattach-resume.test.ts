import { describe, expect, test } from "bun:test";
import { type LinkState, dialFailed } from "../src/link-machine.ts";
import { ChannelError } from "../src/link-machine.ts";

/**
 * fix/mobile-connect-latency T5 — redialNow() dials with no clock advance
 * when the backoff is still due, and is idempotent while dialing / terminal.
 *
 * This is a direct unit test of the link-machine math behind redialNow():
 * a link that failed after a long up burst is at attempt >= 4 -> ~8s backoff,
 * but linkResumed() produces a 0-ms step.
 */

describe("redialNow via link-machine (T5)", () => {
  test("a backoff with attempt 5 produces attempt 0 and dialInMs 0 (what redialNow uses)", async () => {
    const { linkResumed } = await import("../src/link-machine.ts");
    const step = linkResumed({ kind: "backoff", attempt: 5, upSince: 0 });
    expect(step).not.toBeNull();
    if (step) {
      expect(step.state).toMatchObject({ kind: "backoff", attempt: 0 });
      expect(step.dialInMs).toBe(0);
      expect(step.status).toMatchObject({ state: "reconnecting", attempt: 0 });
    }
  });

  test("the same backoff through dialFailed still carries jitter — linkResumed is what skips it", async () => {
    // With random ~1, backoff at attempt 5 is ~16_000. That is what a normal
    // retry would wait. linkResumed must not pay it.
    const now = 0;
    const state: LinkState = { kind: "backoff", attempt: 5, upSince: 0 };
    // normal retry: ~16s
    const retried = dialFailed(state, new Error("x"), now, () => 0.999);
    expect(retried.dialInMs).toBeGreaterThan(10_000);
    // but redialNow skips it:
    const { linkResumed } = await import("../src/link-machine.ts");
    {
      const step = linkResumed(state);
      expect(step).not.toBeNull();
      if (step) expect(step.dialInMs).toBe(0);
    }
  });

  test("terminal stop produces linkResumed === null (redialNow is a no-op there)", async () => {
    const { linkResumed } = await import("../src/link-machine.ts");
    // A stale terminal can only be produced by a terminal ChannelError via the
    // link machine: synthesize the resulting `stopped` by driving dialFailed with
    // a terminal error and an `up`-ish history. The simpler property is just
    // linkResumed(null) for stopped.
    expect(
      linkResumed({ kind: "stopped", attempt: 0, upSince: 0, reason: "unauthorized" }),
    ).toBeNull();
    expect(linkResumed({ kind: "up", attempt: 0, upSince: 0 })).toBeNull();
    expect(linkResumed({ kind: "dialing", attempt: 3, upSince: 0 })).toBeNull();
  });
});
