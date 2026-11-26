/**
 * The lease state machine (docs/feat/session-apps-publish.md D4, F4–F10), table
 * driven: every event on every state.
 */
import { describe, expect, test } from "bun:test";
import type { AppsFailureCode } from "../src/apps-client.ts";
import {
  APPS_BACKOFF_CAP_MS,
  type AppState,
  DEFAULT_LEASE_MS,
  type LeaseEvent,
  type LeaseFailure,
  type LeaseRow,
  appsBackoffMs,
  leaseStep,
  unconfirmedLease,
} from "../src/apps-lease.ts";

const T = 1_000_000;
const LEASE = { leaseMs: 300_000, renewAfterMs: 60_000 };
const row = (over: Partial<LeaseRow> = {}): LeaseRow => ({
  state: "up",
  since: T,
  lastOkSentAt: T,
  leaseMs: 300_000,
  attempt: 0,
  ...over,
});
const failed = (
  failure: LeaseFailure,
  over: Partial<Extract<LeaseEvent, { type: "failed" }>> = {},
): LeaseEvent => ({ type: "failed", failure, canRevive: true, random: 0.5, ...over });
const STATES: AppState[] = ["up", "renewing", "down"];

describe("renewed", () => {
  for (const state of [...STATES, "removed"] as AppState[]) {
    test(`from ${state}: up, no reason, the next renew counted from the SEND time`, () => {
      const step = leaseStep(
        row({ state, reason: "x", attempt: 4 }),
        { type: "renewed", lease: LEASE, sentAt: T + 10_000 },
        T + 12_000,
      );
      expect(step.row.state).toBe("up");
      expect(step.row.reason).toBeUndefined();
      expect(step.row.attempt).toBe(0);
      expect(step.row.lastOkSentAt).toBe(T + 10_000);
      expect(step.action).toEqual({ type: "renewAt", at: T + 70_000 });
      expect(step.row.since).toBe(state === "up" ? T : T + 12_000);
    });
  }

  test("a host clock ten minutes ahead changes nothing", () => {
    const skewed = { ...LEASE, leaseExpiresAt: T + 900_000 };
    const step = leaseStep(row(), { type: "renewed", lease: skewed, sentAt: T }, T);
    expect(step.action).toEqual({ type: "renewAt", at: T + 60_000 });
    expect(step.row.lastOkSentAt).toBe(T);
  });

  test("a reply slower than the interval never renews in a tight loop", () => {
    const step = leaseStep(row(), { type: "renewed", lease: LEASE, sentAt: T }, T + 90_000);
    expect(step.action).toEqual({ type: "renewAt", at: T + 91_000 });
  });
});

describe("transient failure", () => {
  for (const code of [
    "network",
    "timeout",
    "replay",
    "busy",
    "rate_limited",
    "internal",
    "clock_skew",
    "bad_signature",
    "killed",
    "cap_reached",
  ] as AppsFailureCode[]) {
    test(`${code}: renewing, retried, never given up`, () => {
      const step = leaseStep(row(), failed({ code }), T + 60_000);
      expect(step.row.state).toBe("renewing");
      expect(step.row.attempt).toBe(1);
      expect(step.action.type).toBe("renewAt");
      if (step.action.type === "renewAt") expect(step.action.at).toBeGreaterThan(T + 60_000);
    });
  }

  test("down exactly once local time passes lastOkSentAt + leaseMs, still retrying", () => {
    const at = leaseStep(row(), failed({ code: "network" }), T + 300_000);
    expect(at.row.state).toBe("renewing");
    const past = leaseStep(row(), failed({ code: "network" }), T + 300_001);
    expect(past.row.state).toBe("down");
    expect(past.row.reason).toBe("offline: the host has not confirmed it for 5 min");
    expect(past.action.type).toBe("renewAt");
    // A down row stays down (never back to `renewing`) until the host answers.
    const again = leaseStep(past.row, failed({ code: "network" }), T + 480_000);
    expect(again.row.state).toBe("down");
    expect(again.row.reason).toBe("offline: the host has not confirmed it for 8 min");
    expect(again.row.since).toBe(T + 300_001);
  });

  test("retryAfterMs is respected up to the cap", () => {
    const step = leaseStep(row(), failed({ code: "rate_limited", retryAfterMs: 20_000 }), T);
    expect(step.action).toEqual({ type: "renewAt", at: T + 20_000 });
    const long = leaseStep(row(), failed({ code: "rate_limited", retryAfterMs: 9e9 }), T);
    expect(long.action).toEqual({ type: "renewAt", at: T + APPS_BACKOFF_CAP_MS });
  });

  test("backoff: never below 1 s (a random of 0), never above 60 s, growing", () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const random of [0, 0.5, 0.999999]) {
        const ms = appsBackoffMs(attempt, random);
        expect(ms).toBeGreaterThanOrEqual(1000);
        expect(ms).toBeLessThanOrEqual(60_000);
      }
    }
    expect(appsBackoffMs(10, 0.999999)).toBe(60_000);
    expect(appsBackoffMs(3, 0.999999)).toBeGreaterThan(appsBackoffMs(0, 0.999999));
  });
});

describe("tick", () => {
  for (const state of ["up", "renewing"] as AppState[]) {
    test(`${state}: down only after the lapse`, () => {
      expect(leaseStep(row({ state }), { type: "tick" }, T + 300_000).row.state).toBe(state);
      const past = leaseStep(row({ state }), { type: "tick" }, T + 300_001);
      expect(past.row.state).toBe("down");
      expect(past.action).toEqual({ type: "none" });
    });
  }
  test("a down row keeps its reason", () => {
    const down = row({ state: "down", reason: "publish again" });
    expect(leaseStep(down, { type: "tick" }, T + 999_999).row).toEqual(down);
  });
});

describe("expired", () => {
  test("with the bytes held: revive", () => {
    const step = leaseStep(row(), failed({ code: "expired" }), T);
    expect(step.action).toEqual({ type: "revive" });
    expect(step.row.state).toBe("renewing");
  });

  test("without them: down, «publish again», stop", () => {
    const step = leaseStep(row(), failed({ code: "expired" }, { canRevive: false }), T);
    expect(step.action).toEqual({ type: "stop" });
    expect(step.row.state).toBe("down");
    expect(step.row.reason).toContain("publish again");
  });

  test("a revival answered `expired` is retried later, never in a loop", () => {
    const step = leaseStep(row(), failed({ code: "expired" }, { revival: true }), T);
    expect(step.action.type).toBe("renewAt");
  });
});

describe("terminal answers", () => {
  for (const state of STATES) {
    test(`${state}: taken_down / blocked → removed with the operator's reason, stop`, () => {
      for (const code of ["taken_down", "blocked"] as const) {
        const step = leaseStep(row({ state }), failed({ code, reason: "phishing" }), T);
        expect(step.row.state).toBe("removed");
        expect(step.row.reason).toContain("phishing");
        expect(step.row.gone).toBeUndefined();
        expect(step.action).toEqual({ type: "stop" });
      }
    });
    test(`${state}: deleted / not_found / forbidden → removed, gone, stop`, () => {
      for (const code of ["deleted", "not_found", "forbidden"] as const) {
        const step = leaseStep(row({ state }), failed({ code }), T);
        expect(step.row.state).toBe("removed");
        expect(step.row.reason).toBe("no longer on the host");
        expect(step.row.gone).toBe(true);
        expect(step.action).toEqual({ type: "stop" });
      }
    });
  }

  test("a removed row ignores later failures and ticks", () => {
    const removed = row({ state: "removed", reason: "taken down" });
    for (const event of [failed({ code: "network" }), { type: "tick" } as const]) {
      expect(leaseStep(removed, event, T + 999_999)).toEqual({
        row: removed,
        action: { type: "stop" },
      });
    }
  });
});

test("an unconfirmed row (a restart) is renewing and lapses one default lease later", () => {
  const start = unconfirmedLease(T);
  expect(start.state).toBe("renewing");
  expect(leaseStep(start, { type: "tick" }, T + DEFAULT_LEASE_MS + 1).row.state).toBe("down");
});
