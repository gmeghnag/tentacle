import { describe, expect, test } from "bun:test";
import { DomainErrorCode } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";
import {
  BACKOFF_CAP_MS,
  ChannelError,
  LIVENESS_MS,
  STABLE_UP_MS,
  backoffMs,
  dialFailed,
  initialLink,
  linkDropped,
  linkUp,
  liveness,
  turnRecovery,
} from "../src/link-machine.ts";

const max = () => 1;

describe("link machine (pure)", () => {
  test("backoff doubles from 0.5 s, caps at 30 s, full jitter", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((a) => backoffMs(a, max))).toEqual([
      500, 1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
    expect(backoffMs(3, () => 0)).toBe(0);
    expect(backoffMs(3, () => 0.5)).toBe(2000);
    expect(backoffMs(1000, max)).toBe(BACKOFF_CAP_MS); // no overflow
  });

  test("flap guard: the attempt counter resets only after a link stayed up 10 s", () => {
    // Dial fails twice, then up for 1 s, then drops: still backing off from attempt 2.
    let s = linkDropped(initialLink, STABLE_UP_MS, max); // stable initial link → attempt 0
    expect(s.dialInMs).toBe(500);
    s = dialFailed(s.state, new ChannelError("unreachable", "x"), 0, max);
    expect(s.dialInMs).toBe(1000);
    s = linkUp(s.state, 100_000);
    s = linkDropped(s.state, 101_000, max); // up only 1 s
    expect(s.dialInMs).toBe(2000);
    expect(s.status).toEqual({ state: "reconnecting", attempt: 3, nextAtMs: 103_000 });
    s = linkUp(s.state, 200_000);
    s = linkDropped(s.state, 200_000 + STABLE_UP_MS, max); // stable → reset
    expect(s.dialInMs).toBe(500);
  });

  test("terminal: unauthorized and VersionMismatch stop; anything else retries", () => {
    const unauthorized = dialFailed(initialLink, new ChannelError("unauthorized", "401"), 0, max);
    expect(unauthorized.state.kind).toBe("stopped");
    expect(unauthorized.dialInMs).toBeUndefined();
    expect(unauthorized.status.state).toBe("stopped");
    const skew = dialFailed(
      initialLink,
      new RpcError(DomainErrorCode.VersionMismatch, "client 6, daemon 7"),
      0,
      max,
    );
    expect(skew.status).toEqual({
      state: "stopped",
      reason: "incompatible daemon: client 6, daemon 7",
    });
    for (const error of [
      new ChannelError("rejected", "502"),
      new ChannelError("unreachable", "refused"),
      new Error("exec failed"),
    ]) {
      expect(dialFailed(initialLink, error, 0, max).state.kind).toBe("backoff");
    }
    // Stopped is final: a later drop schedules nothing.
    expect(linkDropped(unauthorized.state, 0, max).dialInMs).toBeUndefined();
  });

  test("turn recovery: an acked unfinished turn re-sends its prompt; a recreated one never does", () => {
    const base = { recreated: false, ended: false, acked: true };
    expect(turnRecovery(base)).toEqual({ resendPrompt: true });
    // Not acked: its own retry re-sends it.
    expect(turnRecovery({ ...base, acked: false })).toEqual({ resendPrompt: false });
    expect(turnRecovery({ ...base, recreated: true })).toEqual({ resendPrompt: false });
    expect(turnRecovery({ ...base, ended: true })).toEqual({ resendPrompt: false });
  });

  test("a gone target (deleted pod) is terminal, like unauthorized", () => {
    const gone = dialFailed(initialLink, new ChannelError("gone", 'pod "p" not found'), 0, max);
    expect(gone.state.kind).toBe("stopped");
    expect(gone.dialInMs).toBeUndefined();
    expect(gone.status).toEqual({
      state: "stopped",
      reason: 'the connection target is gone: pod "p" not found',
    });
  });

  test("a failed dial says why on the reconnecting status; a plain drop does not", () => {
    const failed = dialFailed(initialLink, new ChannelError("rejected", "HTTP 502"), 0, max);
    expect(failed.status).toEqual({
      state: "reconnecting",
      attempt: 1,
      nextAtMs: 500,
      error: "HTTP 502",
    });
    expect(linkDropped(initialLink, 0, max).status).toEqual({
      state: "reconnecting",
      attempt: 1,
      nextAtMs: 500,
    });
  });

  test("liveness: dead only after LIVENESS_MS of inbound silence while a request is outstanding", () => {
    // Nothing outstanding: never dead, however quiet.
    expect(liveness({ now: 1_000_000, lastInboundAt: 0, watchedSince: null })).toEqual({
      kind: "idle",
    });
    // A request issued after a long idle: the clock starts at the request, not at the last frame.
    expect(liveness({ now: 100_000, lastInboundAt: 0, watchedSince: 100_000 })).toEqual({
      kind: "alive",
      checkInMs: LIVENESS_MS,
    });
    // Any inbound frame restarts it.
    expect(liveness({ now: 120_000, lastInboundAt: 110_000, watchedSince: 100_000 })).toEqual({
      kind: "alive",
      checkInMs: LIVENESS_MS - 10_000,
    });
    // Boundary: exactly LIVENESS_MS of silence is dead; one ms less is not.
    expect(
      liveness({ now: 100_000 + LIVENESS_MS - 1, lastInboundAt: 0, watchedSince: 100_000 }),
    ).toEqual({ kind: "alive", checkInMs: 1 });
    expect(
      liveness({ now: 100_000 + LIVENESS_MS, lastInboundAt: 0, watchedSince: 100_000 }),
    ).toEqual({ kind: "dead" });
  });
});
