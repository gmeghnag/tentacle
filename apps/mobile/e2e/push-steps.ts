/**
 * The push half of the E2E harness (docs/feat/mobile-push.md P10), as a PURE
 * orchestration over injected effects.
 *
 * Why it is a module rather than inline in `run.ts`: the property the flow exists
 * for is *"the payload that reaches iOS came out of the daemon's own chain"*, and
 * the first version of this code had no test that could fail if that stopped being
 * true — a mutation that replaced the captured payload with a hand-written literal
 * survived every guard (the task doc records it as M7). With the effects injected,
 * "the payload is the one the APNs reported" is a unit test.
 *
 * Three facts shape the steps, all MEASURED on this machine (the task doc's
 * Execution has the transcripts; scratch is `.tentacle/tmp/mobile-push/`):
 *
 *  1. **A simulator build has no remote-notification device token.** Registering
 *     needs `aps-environment` in a signed profile (owner step D2a), so
 *     `getDevicePushTokenAsync` never resolves and the APP cannot register itself.
 *     The harness therefore writes the same per-device file `device/push_register`
 *     writes, for the device `tentacle pair` already admitted.
 *  2. **`simctl push` bypasses APNs entirely** — it hands the payload to the
 *     bundle, so a banner proves the entitlement and the plugin wiring, never
 *     Apple's path. That is exactly what the plan claims for this flow.
 *  3. **`--push-grace 0` makes an ask push at once**, so the flow does not wait out
 *     the 30 s default. The rules push to every registered device NOT attached to
 *     the session, and the harness's own client is a client, not a device.
 */

/** The object APNs carries: the relay's fixed `aps` and the daemon's sealed `tp`. */
export interface ApnsPayload {
  readonly aps: unknown;
  readonly tp: unknown;
}

/** What the harness placed, and the device token it registered. */
export interface PlacedPush {
  readonly payload: ApnsPayload;
  readonly token: string;
}

/** The token the harness registers: a plausible sandbox APNs token (hex, 64+). */
export const HARNESS_APNS_TOKEN = "ab".repeat(32);

/**
 * What a push round needs. Every one is an effect, so a test drives the whole
 * orchestration with no daemon, no relay and no simulator.
 */
export interface PushStepDeps {
  /** The device id `tentacle pair` registered — the push key is written for it. */
  readonly pairedDeviceId: () => string | undefined;
  /** The device's push key, as the wire carries it (unpadded b64url, 32 bytes). */
  readonly pushKey: () => string;
  /** Write one device's registration into the daemon's own store. */
  readonly register: (input: {
    readonly deviceId: string;
    readonly token: string;
    readonly env: "sandbox" | "production";
    readonly key: string;
  }) => void;
  /** Raise one ask, so the daemon pushes to the registered device. */
  readonly promptOnce: () => Promise<void>;
  /** How many requests the local APNs has answered so far. */
  readonly apnsCount: () => number;
  /** The last payload the local APNs received, if any. */
  readonly lastApnsPayload: () => ApnsPayload | undefined;
  /** Hand a payload to the simulator, as APNs would. */
  readonly place: (payload: ApnsPayload) => Promise<void>;
  /** Polling interval while waiting for the push (a test passes 1). */
  readonly pollMs?: number;
  /** How long to wait for the push to arrive. */
  readonly timeoutMs?: number;
  /** The wait between polls, injected so a test does not sleep for real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface PushSteps {
  /**
   * Register the paired device, make the daemon push once, and place the push it
   * produced. Throws — it never returns a literal — when no push arrived: a flow
   * that silently pushed something hand-written would prove nothing.
   */
  place(): Promise<PlacedPush>;
  /** What the last `place` put on the simulator. */
  last(): PlacedPush | undefined;
}

export function createPushSteps(deps: PushStepDeps): PushSteps {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = deps.pollMs ?? 25;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  let placed: PlacedPush | undefined;

  /**
   * Wait until the fake APNs has answered one MORE request than `before`.
   *
   * Bounded by POLLS, not by a clock: a caller injects the sleep, and a wait that
   * advanced on an injected clock could spin forever while a fake held time still
   * (the first version did exactly that, and the test timed out).
   */
  const waitForPush = async (before: number): Promise<ApnsPayload> => {
    const polls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)));
    const seen = (): ApnsPayload | undefined =>
      deps.apnsCount() > before ? deps.lastApnsPayload() : undefined;
    for (let attempt = 0; attempt < polls; attempt += 1) {
      const payload = seen();
      if (payload !== undefined) {
        return payload;
      }
      await sleep(pollMs);
    }
    const payload = seen();
    if (payload !== undefined) {
      return payload;
    }
    throw new Error(
      `the daemon sent no push within ${timeoutMs}ms: the local relay must announce "push" (its APNs client) and push.enabled must not be false — check the run's serve.err.log for a "push off:" line`,
    );
  };

  return {
    last: () => placed,
    async place() {
      const deviceId = deps.pairedDeviceId();
      if (deviceId === undefined) {
        throw new Error("no pairing has completed yet: this flow must run after `_pair`");
      }
      deps.register({
        deviceId,
        token: HARNESS_APNS_TOKEN,
        env: "sandbox",
        key: deps.pushKey(),
      });
      const before = deps.apnsCount();
      await deps.promptOnce();
      // THE property: the payload is what the APNs answered with, never a literal
      // built here. `push-steps.test.ts`'s "a push that never arrived throws" is
      // the test that kills a hand-written fallback.
      const payload = await waitForPush(before);
      await deps.place(payload);
      placed = { payload, token: HARNESS_APNS_TOKEN };
      return placed;
    },
  };
}
