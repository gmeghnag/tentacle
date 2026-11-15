/**
 * Push registration (docs/feat/mobile-push.md slice P9, Design 7). Every rule is
 * a pure decision or a runner over fakes — no simulator, no Keychain, no OS.
 *
 * Each test names the mutation that must turn it red (§9); Execution records the
 * mutations being run.
 */
import { describe, expect, test } from "bun:test";
import type { PushEnvironment, PushRegisterStatus } from "@tentacle/protocol";
import {
  METHOD_NOT_FOUND,
  type PushFacts,
  type PushMemory,
  type PushPermission,
  type PushRegistration,
  type PushSink,
  type PushState,
  createPushRegistrar,
  initialPushState,
  isDaemonTooOld,
  isPushEnvironment,
  phaseOfStatus,
  planPushRegistration,
  pushFactsHash,
  pushPhaseText,
  shouldAskNotificationPermission,
} from "../src/push-registration.ts";

const TOKEN = "a".repeat(64);
const KEY = "k".repeat(43);
const facts = (over: Partial<PushFacts> = {}): PushFacts => ({
  token: TOKEN,
  env: "sandbox" as PushEnvironment,
  key: KEY,
  ...over,
});

/** A sink that records every call, and answers what the test says. */
interface SpySink extends PushSink {
  readonly calls: readonly { op: "register"; facts: PushFacts }[];
  readonly unregisters: () => number;
}

function spySink(
  answer: () => Promise<{ push: PushRegisterStatus; graceSeconds: number }> = async () => ({
    push: "on",
    graceSeconds: 30,
  }),
): SpySink {
  const calls: { op: "register"; facts: PushFacts }[] = [];
  let unregisters = 0;
  return {
    calls,
    unregisters: () => unregisters,
    register: async (seen) => {
      calls.push({ op: "register", facts: seen });
      return answer();
    },
    unregister: async () => {
      unregisters += 1;
    },
  };
}

/** The per-computer memory, in a Map: the Keychain item's `push` field. */
function memory(
  initial?: PushRegistration,
): PushMemory & { readonly written: () => PushRegistration | undefined } {
  let value = initial;
  return {
    read: async () => value,
    write: async (_id, next) => {
      value = next;
    },
    written: () => value,
  };
}

function registrar(
  options: {
    readonly permission?: PushPermission;
    readonly facts?: PushFacts | undefined;
    readonly last?: PushRegistration;
    readonly initial?: PushState;
  } = {},
) {
  const store = memory(options.last);
  const states: PushState[] = [];
  const created = createPushRegistrar({
    computerId: "c1",
    memory: store,
    permission: async () => options.permission ?? "granted",
    facts: async () => ("facts" in options ? options.facts : facts()),
    now: () => 1_000,
    onChange: (state) => states.push(state),
    ...(options.initial === undefined ? {} : { initial: options.initial }),
  });
  return { created, store, states };
}

describe("pushFactsHash: the fingerprint is `(token, env, key)`", () => {
  test("the same triple is the same hash; each field alone changes it", () => {
    const base = pushFactsHash(facts());
    expect(pushFactsHash(facts())).toBe(base);
    expect(pushFactsHash(facts({ token: "b".repeat(64) }))).not.toBe(base);
    expect(pushFactsHash(facts({ env: "production" }))).not.toBe(base);
    expect(pushFactsHash(facts({ key: "j".repeat(43) }))).not.toBe(base);
  });

  test("fields are length-prefixed, so a shifted boundary is a different hash (mutation: plain concat → red)", () => {
    // `("ab","c")` and `("a","bc")` concatenate identically; the fingerprint must not.
    const left = pushFactsHash({ token: "ab", env: "sandbox", key: "c" });
    const right = pushFactsHash({ token: "a", env: "sandbox", key: "bc" });
    expect(left).not.toBe(right);
  });

  test("isPushEnvironment accepts exactly the two wire environments", () => {
    expect(isPushEnvironment("sandbox")).toBe(true);
    expect(isPushEnvironment("production")).toBe(true);
    expect(isPushEnvironment("staging")).toBe(false);
    expect(isPushEnvironment(undefined)).toBe(false);
  });
});

describe("planPushRegistration: when one connect registers", () => {
  test("first connect with a granted permission and a token → register", () => {
    const plan = planPushRegistration({
      state: initialPushState(),
      permission: "granted",
      facts: facts(),
      last: undefined,
    });
    expect(plan).toEqual({ kind: "register", hash: pushFactsHash(facts()) });
  });

  test("the SAME fingerprint already accepted → skip `same` (mutation: register regardless → red)", () => {
    const plan = planPushRegistration({
      state: initialPushState(),
      permission: "granted",
      facts: facts(),
      last: { hash: pushFactsHash(facts()), registeredAt: 1 },
    });
    expect(plan).toEqual({ kind: "skip", reason: "same" });
  });

  test("a rotated TOKEN re-registers (F11)", () => {
    const plan = planPushRegistration({
      state: initialPushState(),
      permission: "granted",
      facts: facts({ token: "c".repeat(64) }),
      last: { hash: pushFactsHash(facts()), registeredAt: 1 },
    });
    expect(plan.kind).toBe("register");
  });

  test("a regenerated push KEY re-registers, and so does a different environment (F12)", () => {
    for (const changed of [facts({ key: "j".repeat(43) }), facts({ env: "production" })]) {
      expect(
        planPushRegistration({
          state: initialPushState(),
          permission: "granted",
          facts: changed,
          last: { hash: pushFactsHash(facts()), registeredAt: 1 },
        }).kind,
      ).toBe("register");
    }
  });

  test("the toggle off skips `disabled`, and `daemon too old` is terminal (F16)", () => {
    expect(
      planPushRegistration({
        state: { enabled: false, phase: "unknown" },
        permission: "granted",
        facts: facts(),
        last: undefined,
      }),
    ).toEqual({ kind: "skip", reason: "disabled" });
    // Even a NEW token does not re-ask: an older daemon never grows the method.
    expect(
      planPushRegistration({
        state: { enabled: true, phase: "daemon-too-old" },
        permission: "granted",
        facts: facts({ token: "d".repeat(64) }),
        last: undefined,
      }),
    ).toEqual({ kind: "skip", reason: "daemon-too-old" });
  });

  test("no permission or no token skips instead of sending a half registration (F26)", () => {
    for (const permission of ["denied", "undetermined", "unavailable"] as const) {
      expect(
        planPushRegistration({
          state: initialPushState(),
          permission,
          facts: facts(),
          last: undefined,
        }),
      ).toEqual({ kind: "skip", reason: "no-permission" });
    }
    expect(
      planPushRegistration({
        state: initialPushState(),
        permission: "granted",
        facts: undefined,
        last: undefined,
      }),
    ).toEqual({ kind: "skip", reason: "no-token" });
  });
});

describe("the runner: one registration per fingerprint per computer", () => {
  test("two syncs with the same facts send ONE register (mutation: drop the stored hash → red)", async () => {
    const { created, store } = registrar();
    const sink = spySink();
    await created.sync(sink);
    await created.sync(sink);
    expect(sink.calls.length).toBe(1);
    expect(store.written()?.hash).toBe(pushFactsHash(facts()));
    expect(created.state().phase).toBe("on");
  });

  test("a token change after a successful registration re-registers, with the new token", async () => {
    let current = facts();
    const store = memory();
    const created = createPushRegistrar({
      computerId: "c1",
      memory: store,
      permission: async () => "granted",
      facts: async () => current,
      now: () => 1_000,
      onChange: () => {},
    });
    const sink = spySink();
    await created.sync(sink);
    current = facts({ token: "e".repeat(64) });
    await created.sync(sink);
    expect(sink.calls.length).toBe(2);
    expect(sink.calls[1]?.facts.token).toBe("e".repeat(64));
  });

  test("a registration stored by an EARLIER app run is honoured (the hash lives in the Keychain)", async () => {
    const { created } = registrar({ last: { hash: pushFactsHash(facts()), registeredAt: 5 } });
    const sink = spySink();
    await created.sync(sink);
    expect(sink.calls).toEqual([]);
  });

  test("concurrent syncs do not double-register (mutation: drop the queue → red)", async () => {
    const { created } = registrar();
    const sink = spySink();
    await Promise.all([created.sync(sink), created.sync(sink), created.sync(sink)]);
    expect(sink.calls.length).toBe(1);
  });

  test("a REFUSED status is not remembered, so the next connect asks again (F3/F4)", async () => {
    let answer: PushRegisterStatus = "relay-no-push";
    const { created, store } = registrar();
    const sink = spySink(async () => ({ push: answer, graceSeconds: 30 }));
    await created.sync(sink);
    expect(created.state().phase).toBe("relay-no-push");
    expect(store.written()).toBeUndefined();
    answer = "on";
    await created.sync(sink);
    expect(sink.calls.length).toBe(2);
    expect(created.state().phase).toBe("on");
  });

  test("a denied permission is shown as `notifications-off` and nothing is sent", async () => {
    const { created } = registrar({ permission: "denied" });
    const sink = spySink();
    await created.sync(sink);
    expect(sink.calls).toEqual([]);
    expect(created.state().phase).toBe("notifications-off");
  });

  test("no token (a build with no entitlement) sends nothing and claims nothing", async () => {
    const { created } = registrar({ facts: undefined });
    const sink = spySink();
    await created.sync(sink);
    expect(sink.calls).toEqual([]);
    // Not `on`: the row must not promise notifications this build cannot get.
    expect(created.state().phase).toBe("unknown");
  });
});

describe("an older daemon is terminal, never a loop (F16)", () => {
  test("MethodNotFound → `daemon too old`, and later syncs send NOTHING (mutation: treat it as transient → red)", async () => {
    const { created } = registrar();
    let attempts = 0;
    const sink: PushSink = {
      register: async () => {
        attempts += 1;
        throw Object.assign(new Error("no such method"), { code: METHOD_NOT_FOUND });
      },
      unregister: async () => {},
    };
    await created.sync(sink);
    expect(created.state().phase).toBe("daemon-too-old");
    await created.sync(sink);
    await created.sync(sink);
    expect(attempts).toBe(1);
    expect(pushPhaseText(created.state().phase, "MacBook")).toContain("Update tentacle on MacBook");
  });

  test("a TRANSIENT failure says `failed` and the next connect retries (F25)", async () => {
    let fail = true;
    const { created, store } = registrar();
    const sink = spySink(async () => {
      if (fail) {
        throw new Error("every push registration failed");
      }
      return { push: "on", graceSeconds: 30 };
    });
    await created.sync(sink);
    expect(created.state().phase).toBe("failed");
    expect(store.written()).toBeUndefined();
    fail = false;
    await created.sync(sink);
    expect(sink.calls.length).toBe(2);
    expect(created.state().phase).toBe("on");
  });

  test("isDaemonTooOld is the exact code, not a message match", () => {
    expect(isDaemonTooOld({ code: METHOD_NOT_FOUND })).toBe(true);
    expect(isDaemonTooOld(new Error("MethodNotFound"))).toBe(false);
    expect(isDaemonTooOld({ code: -32001 })).toBe(false);
    expect(isDaemonTooOld(undefined)).toBe(false);
  });
});

describe("the Settings toggle", () => {
  test("off UNREGISTERS and forgets the fingerprint (mutation: only flip the flag → red)", async () => {
    const { created, store } = registrar();
    const sink = spySink();
    await created.sync(sink);
    expect(store.written()).toBeDefined();
    await created.setEnabled(false, sink);
    expect(sink.unregisters()).toBe(1);
    expect(store.written()).toBeUndefined();
    expect(created.state()).toEqual({ enabled: false, phase: "off" });
    // And a sync while off sends nothing.
    await created.sync(sink);
    expect(sink.calls.length).toBe(1);
  });

  test("off with no link keeps a DEBT for the next connect, and forgets the fingerprint", async () => {
    const { created, store } = registrar({
      last: { hash: pushFactsHash(facts()), registeredAt: 1 },
    });
    await created.setEnabled(false, undefined);
    // Review round 1 (H2): the OLD fingerprint is gone (so turning it back on
    // registers), but the daemon still had to be told — that debt is written.
    expect(store.written()).toEqual({ hash: "", registeredAt: 1_000, off: true });
  });

  test("back on with a live link registers AT ONCE; with none it stays `unknown` (H3)", async () => {
    const { created } = registrar();
    const sink = spySink();
    await created.sync(sink);
    await created.setEnabled(false, sink);
    // No link: no claim about the daemon, just the person's decision.
    await created.setEnabled(true, undefined);
    expect(created.state().phase).toBe("unknown");
    // A live link: the toggle registers now (H3), so the row gets the real answer
    // instead of `unknown` for the rest of the session.
    await created.setEnabled(true, sink);
    expect(created.state().phase).toBe("on");
    expect(sink.calls.length).toBe(2);
  });
});

describe("the permission prompt is asked once, after the first pairing (decision 10)", () => {
  test("asked only on the pairing that succeeds with a computer stored and nothing asked yet", () => {
    expect(
      shouldAskNotificationPermission({
        pairedNow: true,
        hasComputer: true,
        permission: "undetermined",
        asked: false,
      }),
    ).toBe(true);
  });

  test("never without a successful pairing, and never twice (mutation: drop `asked` → red)", () => {
    const base = {
      pairedNow: true,
      hasComputer: true,
      permission: "undetermined" as const,
      asked: false,
    };
    expect(shouldAskNotificationPermission({ ...base, pairedNow: false })).toBe(false);
    expect(shouldAskNotificationPermission({ ...base, hasComputer: false })).toBe(false);
    expect(shouldAskNotificationPermission({ ...base, asked: true })).toBe(false);
    expect(shouldAskNotificationPermission({ ...base, permission: "granted" })).toBe(false);
    expect(shouldAskNotificationPermission({ ...base, permission: "denied" })).toBe(false);
    expect(shouldAskNotificationPermission({ ...base, permission: "unavailable" })).toBe(false);
  });
});

describe("the row's copy", () => {
  test("every phase says something a person can act on", () => {
    expect(pushPhaseText("on")).toContain("On");
    expect(pushPhaseText("relay-off")).toContain("no relay");
    expect(pushPhaseText("daemon-too-old", "Mac")).toContain("Mac");
    // A status this build does not know is `failed`, never a guess.
    expect(phaseOfStatus("maybe")).toBe("failed");
    expect(phaseOfStatus("relay-no-push")).toBe("relay-no-push");
  });
});
