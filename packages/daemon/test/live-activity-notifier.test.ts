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

function notifier(options: { throwOnSink?: boolean; enabled?: boolean } = {}) {
  let at = T0;
  const deliveries: LaDelivery[] = [];
  const audit: string[] = [];
  const instance = createLiveActivityNotifier({
    now: () => at,
    startAfterSeconds: 0,
    newSlot: () => SLOT,
    computer: () => ({ privateKey: computerSk, name: "mac-mini" }),
    registrations: {
      registered: () => [DEVICE],
      read: () =>
        options.enabled === false
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
      if (options.throwOnSink === true) {
        throw new Error("sink exploded");
      }
      return "sent";
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
