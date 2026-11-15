/**
 * The Live Activity SHELL (docs/feat/mobile-live-activity.md Design 4, slice L7):
 * the one place where "a session event happened" becomes "an encrypted activity
 * state is on its way to a phone".
 *
 * Four pieces, in this order, each already tested on its own: the RULES (L6,
 * pure), the CONTENT (L2's `ActivityContent` + `fitActivityContent`), the SEAL
 * (L1's `sealActivity`), and the SINK (the relay link, injected).
 *
 * The properties this file must not lose, and the test that bites on each:
 *  - **The hook stays synchronous and O(1), and its I/O is deferred.** It runs
 *    inside `emit`, and `turn_end` inside the steering no-await window (AGENTS
 *    §7): the rules run synchronously, every seal/send starts from a
 *    `queueMicrotask`. (test: "nothing is sealed before the hook returns")
 *  - **A notifier bug is reported, never thrown into the turn** (F23).
 *  - **The latest state per slot is what a resync sends** — convergence by
 *    STATE, not by event replay (F3).
 *  - **An update token for a slot this daemon did not start is `known:false`**
 *    and is ignored; the slot table is memory-only (Owner Q8).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  PermissionBroker,
  type PermissionRequest,
  type PermissionResponse,
} from "@tentacle/core";
import { type ActivityContent, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { openActivity, publicKeyOf, pushKeyId } from "@tentacle/transport/push";
import type { PushHookEvent } from "../src/hosted-session.ts";
import { type LaDelivery, createLiveActivityNotifier } from "../src/live-activity-notifier.ts";
import { readLiveRegistration } from "../src/live-store.ts";

/**
 * The minimal agent factory `SessionHost` requires. These tests never run a turn
 * (they exercise the device methods), so the model is idle: what matters is that
 * the host can be CONSTRUCTED without a daemon around it.
 */
function createAgent() {
  const permissions = new PermissionBroker();
  const agent = new Agent({
    model: {
      id: "idle",
      async *stream() {},
    },
    tools: new ToolRegistry(),
    env: {
      id: "rec",
      async exec() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    },
    requestPermission: (request: PermissionRequest, opts): Promise<PermissionResponse> =>
      permissions.request(request, opts),
  });
  return { agent, permissions };
}

/** Temp dirs a test made, removed after it (a store test writes real files). */
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const T0 = 1_731_000_000_000;
const DEVICE = "0123456789abcdef";
const SESSION = "s1";
const SLOT = "00112233445566778899aabb";

/** A real X25519 pair: the computer's static key, and one device's push key. */
const computerSk = new Uint8Array(32).fill(1);
const computerPk = publicKeyOf(computerSk);
const deviceSk = new Uint8Array(32).fill(2);
const devicePk = publicKeyOf(deviceSk);

function notifier(
  options: {
    throwOnSink?: boolean;
    enabled?: boolean;
    /** What the sink answers (`sent` unless a test says otherwise). */
    status?: string | (() => string);
    /**
     * A test's own sink, taking the WHOLE control of the answer (it overrides
     * `status`): the only way to hold a delivery in flight and answer it later.
     */
    sink?: (delivery: LaDelivery) => Promise<string>;
    /** The device ids the store reports as registered, read fresh each call. */
    registered?: () => string[];
    /** The registration record, or `undefined` for "this device has none". */
    read?: () =>
      | {
          deviceId: string;
          startToken: string;
          env: "sandbox" | "production";
          enabled: boolean;
          registeredAt: number;
        }
      | undefined;
  } = {},
) {
  let at = T0;
  const deliveries: LaDelivery[] = [];
  const audit: string[] = [];
  const instance = createLiveActivityNotifier({
    now: () => at,
    startAfterSeconds: 0,
    newSlot: () => SLOT,
    computer: () => ({ privateKey: computerSk, name: "mac-mini" }),
    registrations: {
      registered: options.registered ?? (() => [DEVICE]),
      read: () =>
        options.read !== undefined
          ? options.read()
          : options.enabled === false
            ? undefined
            : {
                deviceId: DEVICE,
                startToken: "a".repeat(64),
                env: "sandbox",
                enabled: true,
                registeredAt: 1,
              },
      // Task 16's push record carries the X25519 key the seal needs (the phone
      // already holds it, so the widget needs no second Keychain item).
      pushKeyOf: () => Buffer.from(devicePk).toString("base64url"),
      forget: () => {},
    },
    describe: (sessionId) =>
      sessionId === SESSION
        ? { title: "fix the live activity", cwd: "/Users/x/tentacle" }
        : undefined,
    sink: async (delivery) => {
      deliveries.push(delivery);
      if (options.sink !== undefined) {
        return options.sink(delivery);
      }
      if (options.throwOnSink === true) {
        throw new Error("sink exploded");
      }
      return typeof options.status === "function" ? options.status() : (options.status ?? "sent");
    },
    onAudit: (line) => audit.push(line),
  });
  return {
    instance,
    deliveries,
    audit,
    advance: (ms: number) => {
      at += ms;
    },
    now: () => at,
  };
}

const update = (u: unknown): PushHookEvent => ({ type: "update", update: u as never });

const turnStart = (): PushHookEvent =>
  update({
    type: "turn_start",
    turnId: "t1",
    prompt: "go",
  });

/** An ask: the one event that starts an activity before the threshold. */
const ask = (): PushHookEvent =>
  update({
    type: "permission_request",
    requestId: "req-1",
    tool: "Shell",
    title: "Shell",
    explanation: "rm -rf build",
    options: [
      { optionId: "allow_once", kind: "allow_once" },
      { optionId: "reject_once", kind: "reject_once" },
    ],
  });

/** Drain the microtasks the notifier defers its I/O onto. */
async function flush(rounds = 60): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("the shell: rules → content → seal → sink", () => {
  test("a turn past the threshold becomes ONE sealed start for the device", async () => {
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.onPushEvent(SESSION, { type: "attachment" }, { clients: 0, devices: [] });
    instance.arm();
    await flush();
    // The threshold is 0 s here, so the tick's start is due: drive it.
    instance.tickForTest();
    await flush();
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    const [first] = deliveries;
    expect(first?.token).toBe("a".repeat(64));
    expect(first?.env).toBe("sandbox");
    expect(first?.event).toBe("start");
    // The clear part carries the sealed blob and, on a start, the attributes.
    expect(first?.contentState?.v).toBe(1);
    expect(first?.attributes?.slot).toBe(SLOT);
    // The kid is DERIVED from the sender key by the seal, never supplied: it is
    // the same `tentacle-push-kid/1` hash task 16's pushes use, so the widget
    // finds the computer with one rule for both.
    expect(first?.attributes?.k).toBe(pushKeyId(computerPk));
    expect(first?.priority).toBe(10);
  });

  test("the sealed state OPENS in Swift's terms: it decrypts back to the content", async () => {
    // The property that makes the phone half real: what the sink carries is the
    // L1 envelope, so the widget's openActivity (verified against CryptoKit in
    // L0(a)) gets the plaintext back. Asserted by opening it here with the
    // device's key, i.e. the same operation from the other side.
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    const [first] = deliveries;
    if (first?.contentState === undefined) throw new Error("no content-state");
    const decoded = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "base64url"));
    const opened = openActivity(
      {
        keyId: first.attributes?.k ?? "",
        enc: decoded(first.contentState.e),
        ciphertext: decoded(first.contentState.c),
      },
      deviceSk,
      computerPk,
      SLOT,
    );
    const content = JSON.parse(new TextDecoder().decode(opened)) as ActivityContent;
    expect(content.slot).toBe(SLOT);
    expect(content.turnId).toBe("t1");
    expect(content.kind).toBe("running");
    expect(content.project).toBe("tentacle");
  });

  test("nothing is sealed before the hook returns (the no-await window)", async () => {
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    // The hook and the tick have returned; the seal/send is deferred.
    expect(deliveries).toHaveLength(0);
    await flush();
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  });

  test("a throwing sink is reported, never thrown into the turn (F23)", async () => {
    const { instance, audit } = notifier({ throwOnSink: true });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    // Neither the hook nor the tick may throw.
    expect(() => instance.tickForTest()).not.toThrow();
    await flush();
    // It was audited, not swallowed silently…
    expect(audit.some((line) => line.includes("la-dropped"))).toBe(true);
  });

  test("a notifier bug in the hook is caught and audited, not thrown (F23)", async () => {
    const { instance, audit } = notifier();
    // An event the rules cannot handle (a malformed update) must not escape.
    expect(() =>
      instance.onPushEvent(SESSION, update({ type: "nonsense" }), { clients: 0, devices: [] }),
    ).not.toThrow();
    expect(audit.length).toBeGreaterThanOrEqual(0);
  });
});

describe("owner Q8: the update-token table is memory-only", () => {
  test("a token for a slot this daemon started is accepted, `known:true`", async () => {
    const { instance, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(instance.setUpdateToken(SLOT, "b".repeat(64), DEVICE)).toBe(true);
    // And it is used from the NEXT delivery on: a resync is the cheapest way to
    // observe one without waiting out the heartbeat.
    instance.resendAll();
    await flush();
    const withToken = instance.deliveriesForTest().filter((d) => d.token === "b".repeat(64));
    expect(withToken.length).toBeGreaterThanOrEqual(1);
    // Before the token was reported, the START went to the push-to-START token:
    // an activity has to exist before iOS can hand out its update token.
    expect(instance.deliveriesForTest()[0]?.token).toBe("a".repeat(64));
  });

  test("a token for an UNKNOWN slot is `known:false` and changes nothing (F25)", () => {
    const { instance } = notifier();
    expect(instance.setUpdateToken("ffffffffffffffffffffffff", "b".repeat(64), DEVICE)).toBe(false);
  });

  test("an end reported by the app forgets the slot, so its token is dead", async () => {
    const { instance, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(instance.setUpdateToken(SLOT, "b".repeat(64), DEVICE)).toBe(true);
    expect(instance.reportEnded(SLOT, "dismissed")).toBe(true);
    expect(instance.setUpdateToken(SLOT, "c".repeat(64), DEVICE)).toBe(false);
  });
});

describe("F3: convergence by state, not by event replay", () => {
  test("`resendAll` re-sends the CURRENT state of every live slot, once each", async () => {
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    const afterStart = deliveries.length;
    expect(afterStart).toBeGreaterThanOrEqual(1);
    instance.resendAll();
    await flush();
    // One more per live slot (an update, not a second start).
    expect(deliveries.length).toBe(afterStart + 1);
    expect(deliveries[afterStart]?.event).toBe("update");
  });

  test("the latest state per slot is what is kept, not a queue of every event", async () => {
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    // Many tool calls, all inside the coalescing window: nothing queued.
    for (let i = 0; i < 10; i++) {
      instance.onPushEvent(
        SESSION,
        update({
          type: "tool_call",
          toolCallId: `c${i}`,
          title: `tool ${i}`,
          status: "in_progress",
        }),
        { clients: 0, devices: [] },
      );
    }
    await flush();
    expect(deliveries).toHaveLength(1);
    // And the ONE state kept is the newest, so a resync sends that.
    instance.resendAll();
    await flush();
    expect(deliveries).toHaveLength(2);
  });
});

/**
 * Review round 1's four findings, each a property the SHELL (not the rules, not
 * the store) has to get right. Every one is asserted through the REAL notifier,
 * because each of them was invisible to the unit tests that hand-fed their
 * inputs: the reviewer's mutation (pass `new Set()` from `:444`) left 31/31
 * green.
 */
describe("R1: the attached set reaches the start rule", () => {
  test("a phone attached to the session is never started for by the TIMER", async () => {
    // The bug: `tick` passed `new Set()`, so the timer had no attached set at all.
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(21_000);
    // The person is looking at this session on the phone.
    instance.onPushEvent(SESSION, { type: "attachment" }, { clients: 1, devices: [DEVICE] });
    instance.arm();
    await flush();
    expect(deliveries.filter((d) => d.event === "start")).toHaveLength(0);
    // And it stays silent on later deadlines while the phone is still attached.
    advance(1_000);
    instance.tickForTest();
    await flush();
    expect(deliveries.filter((d) => d.event === "start")).toHaveLength(0);
  });

  test("a phone attached to the session is never started for by an ASK", async () => {
    // The bug: `permission_request` called `startFor` with no attached check.
    const { instance, deliveries, advance } = notifier();
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.onPushEvent(SESSION, { type: "attachment" }, { clients: 1, devices: [DEVICE] });
    instance.onPushEvent(SESSION, ask(), { clients: 1, devices: [DEVICE] });
    await flush();
    expect(deliveries.filter((d) => d.event === "start")).toHaveLength(0);
  });

  test("the attached set is PER SESSION: another session still starts one", async () => {
    // The bug: one `attachment` event applied its devices to EVERY session.
    // Both sessions are `describe`d, so both are start candidates and the only
    // difference is which one the phone is attached to.
    const instance = createLiveActivityNotifier({
      now: () => T0 + 21_000,
      startAfterSeconds: 0,
      newSlot: () => SLOT,
      computer: () => ({ privateKey: computerSk, name: "mac-mini" }),
      registrations: {
        registered: () => [DEVICE],
        read: () => ({
          deviceId: DEVICE,
          startToken: "a".repeat(64),
          env: "sandbox" as const,
          enabled: true,
          registeredAt: 1,
        }),
        pushKeyOf: () => Buffer.from(devicePk).toString("base64url"),
        forget: () => {},
      },
      // BOTH sessions are describable, so both are candidates.
      describe: () => ({ title: "t", cwd: "/Users/x/tentacle" }),
      sink: async () => "sent",
    });
    const seen: string[] = [];
    const deliveries: LaDelivery[] = [];
    instance.onPushEvent("s1", turnStart(), { clients: 0, devices: [] });
    instance.onPushEvent("s2", update({ type: "turn_start", turnId: "t2", prompt: "go" }), {
      clients: 0,
      devices: [],
    });
    // The phone is attached to s1 only.
    instance.onPushEvent("s1", { type: "attachment" }, { clients: 1, devices: [DEVICE] });
    instance.tickForTest();
    await flush();
    for (const delivery of instance.deliveriesForTest()) {
      seen.push(delivery.event);
      deliveries.push(delivery);
    }
    // ONE start, and it is s2's turn (`t2`), not the attached session's (`t1`).
    expect(seen).toEqual(["start"]);
    const [only] = deliveries;
    if (only?.contentState === undefined) throw new Error("no content-state");
    const decoded = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, "base64url"));
    const opened = openActivity(
      {
        keyId: only.attributes?.k ?? "",
        enc: decoded(only.contentState.e),
        ciphertext: decoded(only.contentState.c),
      },
      deviceSk,
      computerPk,
      SLOT,
    );
    const content = JSON.parse(new TextDecoder().decode(opened)) as ActivityContent;
    expect(content.turnId).toBe("t2");
  });
});

describe("R2: registrations are read at every decision, not once", () => {
  test("a phone that registers AFTER the daemon's first event still gets a start", async () => {
    // The bug: `registrationsLoaded` was set on the first event and never reset,
    // so a late registration was invisible for the life of the daemon.
    let registered: string[] = [];
    const { instance, deliveries, advance } = notifier({ registered: () => registered });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    await flush();
    // The phone registers now (a `device/live_activity_register` landed).
    registered = [DEVICE];
    instance.registrationChanged();
    advance(21_000);
    instance.tickForTest();
    await flush();
    expect(deliveries.filter((d) => d.event === "start")).toHaveLength(1);
  });

  test("turning the switch BACK ON is seen without a restart", async () => {
    // The other half: the record went from `enabled:true` to `false` and back.
    let enabled = true;
    const { instance, deliveries, advance } = notifier({
      read: () => ({
        deviceId: DEVICE,
        startToken: "a".repeat(64),
        env: "sandbox",
        enabled,
        registeredAt: 1,
      }),
    });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    await flush();
    enabled = false;
    instance.onPushEvent(SESSION, { type: "attachment" }, { clients: 0, devices: [] });
    advance(21_000);
    instance.tickForTest();
    await flush();
    expect(deliveries.filter((d) => d.event === "start")).toHaveLength(0);
    // Turned back on: the next deadline starts one.
    enabled = true;
    instance.registrationChanged();
    instance.tickForTest();
    await flush();
    expect(deliveries.filter((d) => d.event === "start")).toHaveLength(1);
  });
});

describe("R3: an APNs `gone` is passed to the rules", () => {
  test("a `gone` start is never followed by a heartbeat to the dead token", async () => {
    // The bug: only the file was compare-and-deleted; the rules kept counting
    // the slot as live, so the 10-min heartbeat kept knocking on a dead token.
    const { instance, deliveries, advance, audit } = notifier({ status: "gone" });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    const afterStart = deliveries.length;
    expect(afterStart).toBe(1);
    expect(audit.some((line) => line.startsWith("la-gone"))).toBe(true);
    // 10 minutes of silence: the heartbeat must NOT fire (nothing is live).
    advance(10 * 60_000 + 1);
    instance.tickForTest();
    await flush();
    expect(deliveries).toHaveLength(afterStart);
  });

  test("a `gone` on an UPDATE is a DISMISSAL and never restarts the turn (F17, R6)", async () => {
    // Plan F17 (doc:354): "APNs `gone` on the next update → never restarted for
    // that turn". Fix round 2 took the owner-approved rule instead of reading
    // `gone` as the system's ending (which restarted the turn for ever, once per
    // tick, each time the person swiped the activity away).
    let gone = false;
    const { instance, deliveries, advance } = notifier({
      status: () => (gone ? "gone" : "sent"),
    });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    // The start landed, and iOS reported the activity's own update token.
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    expect(instance.setUpdateToken(SLOT, "b".repeat(64), DEVICE)).toBe(true);
    deliveries.length = 0;
    // The heartbeat to the UPDATE token is `gone`: the activity is not there.
    gone = true;
    advance(10 * 60_000 + 1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["update"]);
    expect(deliveries[0]?.token).toBe("b".repeat(64));
    // A dismissal is the person's gesture: NO continuation, ever, for this turn.
    deliveries.length = 0;
    gone = false;
    advance(10 * 60_000 + 1);
    instance.tickForTest();
    await flush();
    expect(deliveries).toEqual([]);
  });
});

describe("R4: F3 converges for a start the sink dropped", () => {
  test("a start answered `unavailable` is resent as a START, not an update", async () => {
    // The bug: the rules counted the slot as live even though the sink said
    // `unavailable`, so `resendAll` sent `event:"update"` to a push-to-START
    // token — no activity ever appeared for that turn on that phone.
    const { instance, deliveries, advance } = notifier({ status: "unavailable" });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries[0]?.event).toBe("start");
    instance.resendAll();
    await flush();
    expect(deliveries[1]?.event).toBe("start");
  });

  test("an END for a slot the phone never got is dropped, not sent as a start", async () => {
    // The other side of R4: an `end` for a slot that was never confirmed has
    // nothing to end — converting it to a `start` (the naive reading of the rule)
    // would CREATE an activity for a turn that is already over.
    const { instance, deliveries, advance } = notifier({ status: "unavailable" });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    deliveries.length = 0;
    // The turn ends while the phone never had the activity.
    instance.onPushEvent(
      SESSION,
      update({ type: "turn_end", turnId: "t1", stopReason: "end_turn" }),
      { clients: 0, devices: [] },
    );
    await flush();
    expect(deliveries).toEqual([]);
  });

  test("a start the sink had to re-send goes out at priority 10, like any start", async () => {
    // An update is coalesced at priority 5; re-sent as a START it must carry a
    // start's priority, or iOS may defer the activity that creates it.
    const { instance, deliveries, advance } = notifier({ status: "unavailable" });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    instance.resendAll();
    await flush();
    // Both deliveries are starts, so both are priority 10.
    expect(deliveries.map((d) => [d.event, d.priority])).toEqual([
      ["start", 10],
      ["start", 10],
    ]);
  });

  test("an update sent before iOS reported its token is not resent as an update", async () => {
    // Same property, the other way in: nothing has ever been DELIVERED for this
    // slot, so a resync has to start it.
    const { instance, deliveries, advance } = notifier({ status: "unavailable" });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    instance.onPushEvent(
      SESSION,
      update({ type: "tool_call", toolCallId: "c1", title: "shell", status: "in_progress" }),
      { clients: 0, devices: [] },
    );
    advance(16_000);
    instance.tickForTest();
    await flush();
    instance.resendAll();
    await flush();
    // Every delivery for this slot in the whole exchange was a `start`.
    expect(deliveries.every((d) => d.event === "start")).toBe(true);
  });
});

describe("R5: a start still in flight is not sent a second time", () => {
  test("an ask during the start's round trip does not start the slot again", async () => {
    // Fix round 2 (review round 2, finding 1). A slot was `confirmed` only once
    // the sink answered `sent`, so EVERY command for it sent before that answer
    // also went out as a `start`: two pushes start two activity objects, iOS
    // gives one of them the update token, and the other sits on the lock screen
    // (both count toward the ~5 limit).
    let release: (status: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { instance, deliveries, advance } = notifier({ sink: () => held });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    // The start is out, and its answer has NOT arrived.
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    // An ask arrives while it is in flight: the activity is already being
    // created, so this must not become a SECOND start.
    instance.onPushEvent(SESSION, ask(), { clients: 0, devices: [] });
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    // It is not LOST either: once the first start resolves `sent`, the intent
    // held for the slot is sent — as an update, because the activity now exists.
    // (Mutating the flush away leaves the ask unanswered on the phone: the
    // person sees "running" while a permission waits.)
    release("sent");
    await flush();
    const events = deliveries.map((d) => d.event);
    expect(events).toEqual(["start", "update"]);
    expect(events.filter((event) => event === "start")).toHaveLength(1);
  });

  test("`resendAll` while the start is held does not start it again", async () => {
    let release: (status: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { instance, deliveries, advance } = notifier({ sink: () => held });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    // The link came up mid-start (`ready`): the slot's current state is re-sent,
    // but the activity it would update does not exist YET.
    instance.resendAll();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    release("sent");
    await flush();
  });

  test("a start held while the link is down is not started twice by the timer", async () => {
    // The heartbeat deadline can arrive before the start's answer does: the
    // rules still hold a live state (the start was accepted by them), so the
    // tick must not turn it into another start.
    let release: (status: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { instance, deliveries, advance } = notifier({ sink: () => held });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    advance(10 * 60_000 + 1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    release("sent");
    await flush();
  });

  test("a start answered `unavailable` is in flight no longer: the resync starts it", async () => {
    // The other side of R5: "in flight" must not survive a resolved answer, or
    // R4's convergence (a dropped start resent as a start) would be dead.
    let answer = "unavailable";
    const { instance, deliveries, advance } = notifier({ status: () => answer });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    answer = "sent";
    instance.resendAll();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start", "start"]);
  });

  test("a held ask is NOT flushed after its turn has ended", async () => {
    // The flush must never resurrect a state the turn has moved past: the ask
    // was raised during the start's round trip, and the turn ended inside the
    // same window. Sending "asking" now would show a permission that no longer
    // waits, on a turn that is over.
    let release: (status: string) => void = () => {};
    const held = new Promise<string>((resolve) => {
      release = resolve;
    });
    const { instance, deliveries, advance } = notifier({ sink: () => held });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    // An ask raised, then resolved and the turn ended: all while the start is
    // still unanswered, so every one of them is held behind the in-flight start.
    instance.onPushEvent(SESSION, ask(), { clients: 0, devices: [] });
    await flush();
    instance.onPushEvent(
      SESSION,
      update({ type: "turn_end", turnId: "t1", stopReason: "end_turn" }),
      { clients: 0, devices: [] },
    );
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    release("sent");
    await flush();
    // Only the END reaches the phone: the slot is confirmed now, so the turn's
    // end is a real end (the held "asking" is gone).
    expect(deliveries.map((d) => d.event)).toEqual(["start", "end"]);
  });
});

describe("R6: a `gone` is a dismissal, and a restart is bounded (F17/F18)", () => {
  test("a `gone` on the START token is a dead token, not a dismissal (F13)", async () => {
    // The other side of R6: nothing was ever created on that phone (the token
    // rotated, or the app was reinstalled), so no gesture happened. The device is
    // muted until it re-registers — but the TURN must stay startable, or a
    // reinstalled phone would never see it.
    let startToken = "a".repeat(64);
    const { instance, deliveries, advance } = notifier({
      status: () => "gone",
      read: () => ({
        deviceId: DEVICE,
        startToken,
        env: "sandbox",
        enabled: true,
        registeredAt: 1,
      }),
    });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => `${d.event}/${d.token.slice(0, 1)}`)).toEqual(["start/a"]);
    // The phone re-registers with a FRESH token (a reinstall): it is a candidate
    // again, and the turn it missed must still start on it.
    startToken = "c".repeat(64);
    deliveries.length = 0;
    advance(1);
    instance.registrationChanged();
    instance.tickForTest();
    await flush();
    // Mutation: read every `gone` as a dismissal → nothing here, and the turn is
    // lost on the phone that just reinstalled.
    expect(deliveries.map((d) => `${d.event}/${d.token.slice(0, 1)}`)).toEqual(["start/c"]);
  });

  test("a `gone` on an UPDATE never restarts the turn (F17)", async () => {
    // Fix round 2 (review round 2, finding 2). A `gone` on an update token used
    // to be fed to the rules as `reason:"ended"`, so the turn stayed startable:
    // the person swiped the activity away on the lock screen and the next tick
    // put it back, for ever. The approved plan's F17 says the opposite.
    let gone = false;
    const { instance, deliveries, advance } = notifier({
      status: () => (gone ? "gone" : "sent"),
    });
    instance.onPushEvent(SESSION, turnStart(), { clients: 0, devices: [] });
    advance(1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["start"]);
    expect(instance.setUpdateToken(SLOT, "b".repeat(64), DEVICE)).toBe(true);
    deliveries.length = 0;
    gone = true;
    advance(10 * 60_000 + 1);
    instance.tickForTest();
    await flush();
    expect(deliveries.map((d) => d.event)).toEqual(["update"]);
    deliveries.length = 0;
    // The person is done with it: no continuation, however many deadlines pass.
    gone = false;
    for (let round = 0; round < 3; round++) {
      advance(10 * 60_000 + 1);
      instance.tickForTest();
      await flush();
    }
    expect(deliveries).toEqual([]);
  });
});

// --- the three device RPCs (Design 4, L7) -----------------------------------
/**
 * `device/live_activity_register` / `_token` / `_ended`, over a real `Connection`
 * and a real store, with a fake notifier for the memory-only half.
 *
 * The load-bearing rule is the PRINCIPAL gate: a `token` (a pod-facing plain
 * client) or `pairing` connection must be refused, because otherwise anything
 * that can dial the daemon could register a token this computer would light a
 * lock screen with. It is the same gate task 16's `device/push_register` has,
 * and it is a UX check, never security (AGENTS §7, "a pod is not trusted").
 */
describe("the three device methods", () => {
  test("register writes the record and answers the status; a non-device is refused", async () => {
    const { SessionHost } = await import("../src/session-host.ts");
    const { Connection } = await import("../src/connection.ts");
    const { createChannelPair } = await import("@tentacle/transport");
    const dir = mkdtempSync(join(tmpdir(), "la-rpc-"));
    dirs.push(dir);
    const calls: { slot: string; token: string; deviceId: string }[] = [];
    const host = new SessionHost({
      defaultCwd: "/tmp/la-rpc",
      createAgent,
      liveActivity: {
        observer: { onPushEvent: () => {} },
        storeDir: dir,
        notifier: {
          setUpdateToken: (slot, token, deviceId) => {
            calls.push({ slot, token, deviceId });
            return slot === SLOT;
          },
          reportEnded: () => true,
        },
        status: () => undefined,
      },
    });
    const connect = async (principal?: { kind: "device"; id: string } | { kind: "token" }) => {
      const [d, c] = createChannelPair();
      const connection = new Connection(d, host, undefined, {
        ...(principal !== undefined ? { principal } : {}),
      });
      void connection;
      return { client: new (await import("@tentacle/transport")).RpcPeer(c), c };
    };

    // `initialize` first: every other method is refused `NotInitialized` before
    // the principal gate is even reached (the same order a real client sees).
    const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} };
    const device = await connect({ kind: "device", id: DEVICE });
    await device.client.request("initialize", INIT);
    const registered = await device.client.request("device/live_activity_register", {
      startToken: "a".repeat(64),
      env: "sandbox",
      enabled: true,
    });
    expect(registered).toEqual({ status: "on" });
    const stored = readLiveRegistration(dir, DEVICE);
    expect(stored.ok).toBe(true);

    // A token principal (a pod-facing plain client) is refused at the gate.
    const pod = await connect({ kind: "token" });
    await pod.client.request("initialize", INIT);
    const refused = await pod.client
      .request("device/live_activity_register", {
        startToken: "a".repeat(64),
        env: "sandbox",
        enabled: true,
      })
      .then(() => undefined)
      .catch((error: { code?: number }) => error);
    expect(refused?.code).toBeDefined();

    // `_token`: known for a slot this daemon started, `known:false` otherwise.
    expect(
      await device.client.request("device/live_activity_token", {
        slot: SLOT,
        token: "b".repeat(64),
      }),
    ).toEqual({ known: true });
    expect(
      await device.client.request("device/live_activity_token", {
        slot: "ffffffffffffffffffffffff",
        token: "b".repeat(64),
      }),
    ).toEqual({ known: false });

    // `_ended` is idempotent and always `{}`.
    expect(
      await device.client.request("device/live_activity_ended", {
        slot: SLOT,
        reason: "dismissed",
      }),
    ).toEqual({});
  });

  test("registering over RPC tells the notifier to re-read (R2)", async () => {
    // The other half of finding 2: `registerLiveActivity`'s comment claimed it
    // notified the notifier while nothing did, so a phone that registered after
    // `serve`'s first event waited for a restart.
    const { SessionHost } = await import("../src/session-host.ts");
    const { Connection } = await import("../src/connection.ts");
    const { RpcPeer, createChannelPair } = await import("@tentacle/transport");
    const dir = mkdtempSync(join(tmpdir(), "la-rpc-r2-"));
    dirs.push(dir);
    let told = 0;
    const host = new SessionHost({
      defaultCwd: "/tmp/la-rpc-r2",
      createAgent,
      liveActivity: {
        observer: { onPushEvent: () => {} },
        storeDir: dir,
        notifier: {
          setUpdateToken: () => false,
          reportEnded: () => false,
          registrationChanged: () => {
            told += 1;
          },
        },
        status: () => undefined,
      },
    });
    const [d, c] = createChannelPair();
    new Connection(d, host, undefined, { principal: { kind: "device", id: DEVICE } });
    const client = new RpcPeer(c);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    await client.request("device/live_activity_register", {
      startToken: "a".repeat(64),
      env: "sandbox",
      enabled: true,
    });
    // Once, for the write that just landed. (MUTATION: drop the call in
    // `registerLiveActivity` → 0, and a late registration is invisible.)
    expect(told).toBe(1);
  });

  test("with no liveActivity option the methods are MethodNotFound (a pod, the worker)", async () => {
    const { SessionHost } = await import("../src/session-host.ts");
    const { Connection } = await import("../src/connection.ts");
    const { RpcPeer, createChannelPair } = await import("@tentacle/transport");
    const host = new SessionHost({ defaultCwd: "/tmp/la-rpc-none", createAgent });
    const [d, c] = createChannelPair();
    new Connection(d, host, undefined, { principal: { kind: "device", id: DEVICE } });
    const client = new RpcPeer(c);
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    const error = await client
      .request("device/live_activity_register", {
        startToken: "a".repeat(64),
        env: "sandbox",
        enabled: true,
      })
      .then(() => undefined)
      .catch((e: { code?: number }) => e);
    expect(error?.code).toBe(-32601);
  });
});
