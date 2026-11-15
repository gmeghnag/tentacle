/**
 * `createPushSteps` (docs/feat/mobile-push.md P10). The test that matters is the
 * one M7 names: the payload placed on the simulator is the object the local APNs
 * reported, never a literal the harness built. The first version of this code
 * survived that mutation, because it had no test at all — which is why the
 * orchestration moved out of `run.ts` and behind injected effects.
 */
import { describe, expect, test } from "bun:test";
import { type ApnsPayload, HARNESS_APNS_TOKEN, createPushSteps } from "../e2e/push-steps.ts";

/** A payload of the shape the relay + `sealPush` produce (the checker's own tests cover content). */
function sealed(kind = "ask"): ApnsPayload {
  return {
    aps: { alert: { title: "tentacle" }, "mutable-content": 1 },
    tp: { v: 1, k: "a".repeat(12), e: "b".repeat(43), c: "c".repeat(704), kind },
  };
}

interface Rig {
  readonly placed: ApnsPayload[];
  readonly registrations: {
    deviceId: string;
    token: string;
    env: string;
    key: string;
  }[];
  readonly prompts: () => number;
  readonly steps: ReturnType<typeof createPushSteps>;
  /** Let the "daemon" push: the APNs then reports one more request. */
  pushNow(payload: ApnsPayload): void;
}

/**
 * The rig. `sleep` yields a MACROTASK per poll, so a test's own `pushNow` (queued
 * behind a `Bun.sleep(0)`) gets a turn between polls; an `async () => {}` sleep
 * once drained the whole wait in one microtask chain and every "it arrived" case
 * timed out.
 */
function rig(over: { paired?: string | undefined; timeoutMs?: number } = {}): Rig {
  const placed: ApnsPayload[] = [];
  const registrations: Rig["registrations"] = [];
  let pushes: ApnsPayload[] = [];
  let prompts = 0;
  const steps = createPushSteps({
    pairedDeviceId: () => ("paired" in over ? over.paired : "device-1"),
    pushKey: () => "k".repeat(43),
    register: (input) => {
      registrations.push(input);
    },
    promptOnce: async () => {
      prompts += 1;
    },
    apnsCount: () => pushes.length,
    lastApnsPayload: () => (pushes.length === 0 ? undefined : pushes[pushes.length - 1]),
    place: async (payload) => {
      placed.push(payload);
    },
    pollMs: 1,
    timeoutMs: over.timeoutMs ?? 5_000,
    sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  });
  return {
    placed,
    registrations,
    prompts: () => prompts,
    steps,
    pushNow: (payload) => {
      pushes = [...pushes, payload];
    },
  };
}

describe("the payload placed on iOS is the daemon's, never a literal", () => {
  test("a push that never arrived THROWS (M7: a hand-written fallback dies here)", async () => {
    // The mutation replaced `await waitForPush(before)` with an inline object, so
    // the flow "succeeded" while nothing had gone through the chain. With no push
    // reported, `place` must fail — and it must not have placed anything.
    const r = rig({ timeoutMs: 4 });
    await expect(r.steps.place()).rejects.toThrow(/sent no push/);
    expect(r.placed).toEqual([]);
  });

  test("it places EXACTLY the object the APNs reported (identity, not equality)", async () => {
    // Identity is the property: a harness that RECONSTRUCTED a payload — even an
    // identical-looking one — cannot pass by an accident of deep equality.
    const r = rig();
    const fromDaemon = sealed("turn_done");
    const started = r.steps.place();
    await Bun.sleep(0);
    r.pushNow(fromDaemon);
    const placed = await started;
    expect(r.placed).toHaveLength(1);
    expect(r.placed[0]).toBe(fromDaemon);
    expect(placed.payload).toBe(fromDaemon);
  });

  test("it registers the PAIRED device, under the harness token, before pushing", async () => {
    const r = rig();
    const started = r.steps.place();
    await Bun.sleep(0);
    r.pushNow(sealed());
    await started;
    expect(r.registrations).toEqual([
      { deviceId: "device-1", token: HARNESS_APNS_TOKEN, env: "sandbox", key: "k".repeat(43) },
    ]);
    expect(r.prompts()).toBe(1);
  });

  test("no pairing yet → it refuses instead of writing a registration for nobody", async () => {
    const r = rig({ paired: undefined });
    await expect(r.steps.place()).rejects.toThrow(/no pairing/);
    expect(r.registrations).toEqual([]);
  });

  test("an EARLIER push is not mistaken for this one (the count, not `last`)", async () => {
    // A previous flow's push is still the APNs' "last": a harness that read
    // `lastApnsPayload()` without the count would place a STALE envelope, and the
    // banner would be for an ask nobody just raised.
    const r = rig();
    r.pushNow(sealed("stale"));
    const started = r.steps.place();
    await Bun.sleep(0);
    r.pushNow(sealed("fresh"));
    const placed = await started;
    expect((placed.payload.tp as { kind: string }).kind).toBe("fresh");
  });

  test("`last()` reports what was placed, and is undefined until then", async () => {
    const r = rig();
    expect(r.steps.last()).toBeUndefined();
    const started = r.steps.place();
    await Bun.sleep(0);
    r.pushNow(sealed());
    await started;
    expect(r.steps.last()?.token).toBe(HARNESS_APNS_TOKEN);
    expect(r.steps.last()?.payload).toBe(r.placed[0] as ApnsPayload);
  });
});
