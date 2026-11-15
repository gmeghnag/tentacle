/**
 * Live Activity REGISTRATION (docs/feat/mobile-live-activity.md Design 7, L11):
 * whether the app should (re)tell a computer where to start an activity.
 *
 * Pure: the token, the environment, the switch and the last ACK are all inputs,
 * so every rule here is a table test rather than a connect-and-observe.
 *
 * Two rules, each with the failure it prevents:
 *
 *  - **Register only when something changed.** The ack is stored per computer, so
 *    an unchanged `(startToken, env, enabled)` produces no traffic and no daemon
 *    write on every connect. A changed token is exactly what a reinstall or an
 *    iOS rotation produces, which is how F13 converges.
 *  - **A kept negative answer does not retry.** `relay-off`, `relay-no-la` and
 *    `unsupported` describe the DAEMON's or the DEVICE's situation; re-registering
 *    cannot change either, and would be one atomic write per connect forever.
 *    `MethodNotFound` is the same rule one level up: an older computer is told
 *    once ("update tentacle"), never in a loop (F16/F22).
 */
import type { LiveActivityStatus } from "@tentacle/protocol";

/** What the app wants the computer to know right now. */
export interface LaRegistrationState {
  /** The push-to-START token, or `undefined` when iOS offers none. */
  readonly startToken: string | undefined;
  readonly env: "sandbox" | "production";
  /** The person's switch (Settings). */
  readonly enabled: boolean;
}

/** What the computer last said, as the app stored it (per computer). */
export interface LaRegistrationAck {
  readonly startToken: string;
  readonly env: "sandbox" | "production";
  readonly enabled: boolean;
  readonly status: LiveActivityStatus;
}

export type LaRegistrationPlan =
  | {
      readonly do: "register";
      readonly params: {
        readonly startToken: string;
        readonly env: "sandbox" | "production";
        readonly enabled: boolean;
      };
    }
  | { readonly do: "skip" };

/**
 * What to do on a connect. `supported` is the DEVICE's own answer
 * (`areActivitiesEnabled`): an iPad, or a phone with Live Activities switched off
 * in Settings, has nothing to register and the daemon must not be given a token
 * it could only ever fail to use (F24).
 */
export function planLiveActivityRegistration(input: {
  readonly desired: LaRegistrationState;
  readonly acked: LaRegistrationAck | undefined;
  readonly supported: boolean;
}): LaRegistrationPlan {
  if (!input.supported) {
    return { do: "skip" };
  }
  const token = input.desired.startToken;
  if (token === undefined) {
    // iOS has not handed us a push-to-start token yet (it arrives on a later
    // launch, sometimes only after the app has been backgrounded): nothing to say.
    return { do: "skip" };
  }
  const acked = input.acked;
  if (
    acked !== undefined &&
    acked.startToken === token &&
    acked.env === input.desired.env &&
    acked.enabled === input.desired.enabled
  ) {
    // Already acknowledged, whatever the verdict: a negative one is the daemon's
    // situation, and retrying it cannot change it.
    return { do: "skip" };
  }
  return {
    do: "register",
    params: { startToken: token, env: input.desired.env, enabled: input.desired.enabled },
  };
}
