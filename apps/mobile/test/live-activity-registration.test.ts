/**
 * Live Activity REGISTRATION (docs/feat/mobile-live-activity.md Design 7, L11):
 * when the app tells a computer where to start an activity, and when it does not.
 *
 * The two rules that matter:
 *  - **Register only when something CHANGED** (the start token, its environment,
 *    the person's switch): a `device/live_activity_register` on every connect is
 *    one atomic file write per connect per computer, and the daemon's answer is
 *    the same every time. A changed token is exactly what a reinstall produces,
 *    so this is also how F13 converges.
 *  - **`MethodNotFound` is final**: an older computer cannot be told to upgrade
 *    in a loop. One notice, no retry, and the person sees "update tentacle on
 *    <computer>" — the same rule task 16's push registration follows for F16.
 */
import { describe, expect, test } from "bun:test";
import {
  type LaRegistrationState,
  planLiveActivityRegistration,
} from "../src/live-activity-registration.ts";

const COMPUTER = "0123456789abcdef";
const TOKEN = "a".repeat(64);

const state = (over: Partial<LaRegistrationState> = {}): LaRegistrationState => ({
  startToken: TOKEN,
  env: "sandbox",
  enabled: true,
  ...over,
});

describe("planLiveActivityRegistration", () => {
  test("a first connect registers (nothing was ever acked)", () => {
    const plan = planLiveActivityRegistration({
      desired: state(),
      acked: undefined,
      supported: true,
    });
    expect(plan).toEqual({
      do: "register",
      params: { startToken: TOKEN, env: "sandbox", enabled: true },
    });
  });

  test("an identical ack is a NO-OP: no write, no traffic (every connect)", () => {
    const plan = planLiveActivityRegistration({
      desired: state(),
      acked: { startToken: TOKEN, env: "sandbox", enabled: true, status: "on" },
      supported: true,
    });
    expect(plan).toEqual({ do: "skip" });
  });

  test("a NEW start token re-registers (F13: a reinstall, or iOS rotating it)", () => {
    const plan = planLiveActivityRegistration({
      desired: state({ startToken: "b".repeat(64) }),
      acked: { startToken: TOKEN, env: "sandbox", enabled: true, status: "on" },
      supported: true,
    });
    expect(plan.do).toBe("register");
  });

  test("flipping the switch re-registers, in BOTH directions", () => {
    for (const enabled of [false, true]) {
      const plan = planLiveActivityRegistration({
        desired: state({ enabled }),
        acked: { startToken: TOKEN, env: "sandbox", enabled: !enabled, status: "on" },
        supported: true,
      });
      expect(plan.do).toBe("register");
    }
  });

  test("`unsupported` registers nothing: an iPad or a phone with the setting off", () => {
    // The daemon must not be told a token it could only ever fail to use (F24).
    const plan = planLiveActivityRegistration({
      desired: state(),
      acked: undefined,
      supported: false,
    });
    expect(plan).toEqual({ do: "skip" });
  });

  test("a KEPT `relay-no-la` / `relay-off` ack does not re-register every connect", () => {
    // The daemon's answer says why it cannot do it; retrying cannot change that,
    // and a register per connect would be one file write per connect forever.
    for (const status of ["relay-off", "relay-no-la", "unsupported"] as const) {
      const plan = planLiveActivityRegistration({
        desired: state(),
        acked: { startToken: TOKEN, env: "sandbox", enabled: true, status },
        supported: true,
      });
      expect(plan).toEqual({ do: "skip" });
    }
  });
});
