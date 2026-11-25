/**
 * The push SHELL (docs/feat/mobile-push.md Design 5, slice P7): `PushNotifier`
 * turns the rules' commands into sealed envelopes and hands them to a sink.
 *
 * The property that matters here, and every block bites on one: the envelope a
 * phone receives OPENS with the device's push key and the computer's own key —
 * everything else (a relay, Apple, a replay) cannot make one that does.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PushMessage,
  PushMessageSchema,
  decodeBase64Url,
  encodeBase64Url,
} from "@tentacle/protocol";
import type {
  PermissionRequestUpdate,
  QuestionRequestUpdate,
  WorkflowRow,
} from "@tentacle/protocol";
import { openPush, publicKeyOf } from "@tentacle/transport/push";
import type { PushWatchedUpdate } from "../src/hosted-session.ts";
import {
  type PushDelivery,
  type PushNotifier,
  type PushRegistrationsSource,
  createPushNotifier,
  pushRegisterStatus,
} from "../src/push-notifier.ts";
import {
  type PushRegistration,
  clearPushRegistrations,
  forgetPushRegistration,
  readPushRegistrations,
  writePushRegistration,
} from "../src/push-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const COMPUTER = key(9);
const COMPUTER_PUBLIC = publicKeyOf(COMPUTER);
const DEVICE = key(3);

/** A clock a test moves by hand. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (at: number) => {
      t = at;
    },
  };
}

/** Timers that record and fire only when the test says so. */
function manualTimers() {
  const pending: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  return {
    pending,
    setTimeout: (fn: () => void, ms: number) => {
      const entry = { fn, ms, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      const entry = handle as { cancelled: boolean } | undefined;
      if (entry !== undefined) entry.cancelled = true;
    },
    /** Fire every live timer once (the rules' one deadline). */
    fire(): void {
      for (const entry of pending.splice(0)) {
        if (!entry.cancelled) entry.fn();
      }
    },
  };
}

/** A real P5 store on disk, read through the shape the notifier wants. */
function storeSource(configDir: string, allowed: () => readonly string[]) {
  const readOne = (deviceId: string): PushRegistration | undefined => {
    const all = readPushRegistrations(configDir);
    return all.registrations.get(deviceId);
  };
  const source: PushRegistrationsSource = {
    registered: () => allowed().filter((id) => readOne(id) !== undefined),
    read: readOne,
    forget: (deviceId, token) => {
      // Compare-and-delete, as P5's own `deletePushRegistration` does.
      const current = readOne(deviceId);
      if (current !== undefined && current.token === token) {
        forgetPushRegistration(configDir, deviceId);
      }
    },
  };
  return source;
}

interface Rig {
  readonly notifier: PushNotifier;
  readonly deliveries: PushDelivery[];
  readonly audit: string[];
  readonly timers: ReturnType<typeof manualTimers>;
  readonly clock: ReturnType<typeof clock>;
  readonly configDir: string;
  /** What the authority snapshot says (the push-time filter). */
  allow(...ids: string[]): void;
  /** Answer the NEXT sink call with this status (default `sent`). */
  answer(status: string): void;
}

function rig(options: { graceMs?: number; registrations?: readonly string[] } = {}): Rig {
  const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
  dirs.push(configDir);
  const deliveries: PushDelivery[] = [];
  const audit: string[] = [];
  const timers = manualTimers();
  const time = clock();
  let allowed: string[] = [...(options.registrations ?? [])];
  const statuses: string[] = [];
  const registrations = storeSource(configDir, () => allowed);
  const notifier = createPushNotifier({
    now: time.now,
    registrations,
    describe: (sessionId) => ({ title: `title of ${sessionId}`, cwd: "/proj/one" }),
    computer: () => ({ privateKey: COMPUTER, name: "gabriel-mac" }),
    sink: (delivery) => {
      deliveries.push(delivery);
      return Promise.resolve(statuses.shift() ?? "sent");
    },
    onAudit: (line) => audit.push(line),
    timers,
    // Deterministic: every random byte is 7 (HPKE's ephemeral and the message id).
    random: (length) => new Uint8Array(length).fill(7),
    ...(options.graceMs !== undefined ? { graceMs: options.graceMs } : {}),
  });
  // A registered device: the store row the notifier reads at push time.
  for (const deviceId of options.registrations ?? []) {
    const written = writePushRegistration(configDir, {
      deviceId,
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(DEVICE)),
      registeredAt: 1,
    });
    if (!written.ok) throw new Error(written.reason);
  }
  return {
    notifier,
    deliveries,
    audit,
    timers,
    clock: time,
    configDir,
    allow: (...ids: string[]) => {
      allowed = ids;
    },
    answer: (status: string) => statuses.push(status),
  };
}

const DEVICE_A = "aaaaaaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbbbbbbbbbb";

const askUpdate = (requestId: string): PermissionRequestUpdate => ({
  type: "permission_request",
  requestId,
  toolCallId: "c1",
  tool: "shell",
  title: "run a command",
  explanation: "rm -rf build",
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "reject_once", kind: "reject_once", name: "Deny" },
  ],
  reply: { maxChars: 500 },
});

const NOBODY = { clients: 0, devices: [] as string[] };

/** Open a sealed delivery with the DEVICE's key and the computer's public key. */
function open(delivery: PushDelivery): PushMessage {
  const envelope = delivery.payload.tp;
  const sealed = {
    keyId: envelope.k,
    enc: decodeBase64Url(envelope.e) as Uint8Array,
    ciphertext: decodeBase64Url(envelope.c) as Uint8Array,
  };
  const plaintext = openPush(sealed, DEVICE, COMPUTER_PUBLIC);
  const parsed = PushMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
  if (!parsed.success) throw new Error(`not a PushMessage: ${parsed.error.message}`);
  return parsed.data;
}

/** Let the deferred (microtask) seal/send run. */
async function settled(rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

/** One `workflows` update's row (docs/feat/agent-workflows.md D5), minimal for a push. */
function runRow(over: {
  runId: string;
  name: string;
  state: string;
  stopReason?: string;
  reason?: string;
  endedAt?: number;
}): WorkflowRow {
  return {
    runId: over.runId,
    name: over.name,
    version: 1,
    hash: "a".repeat(64),
    state: over.state,
    ...(over.stopReason !== undefined ? { stopReason: over.stopReason } : {}),
    ...(over.reason !== undefined ? { reason: over.reason } : {}),
    tokens: 0,
    startedAt: 1,
    ...(over.endedAt !== undefined ? { endedAt: over.endedAt } : {}),
    history: [],
    historyDropped: 0,
    steps: [
      {
        id: "plan",
        kind: "agent",
        where: "local",
        state: "ok",
        attempt: 1,
        round: 0,
        next: null,
        onFail: null,
        retry: 0,
      },
    ],
  };
}

const workflowsUpdate = (runs: WorkflowRow[]): PushWatchedUpdate => ({ type: "workflows", runs });
describe("the sealed envelope opens with the device key + the computer key", () => {
  test("an unanswered ask reaches the registered device, and it OPENS", async () => {
    // Mutation: seal to the COMPUTER's key instead of the device's, or drop
    // Auth mode's `skS` → `openPush` throws and this fails.
    const r = rig({ graceMs: 30_000, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    expect(r.deliveries).toEqual([]);
    r.clock.advance(30_000);
    r.timers.fire();
    await settled();
    expect(r.deliveries).toHaveLength(1);
    const delivery = r.deliveries[0];
    if (delivery === undefined) throw new Error("no delivery");
    expect(delivery.deviceId).toBe(DEVICE_A);
    expect(delivery.token).toBe("a".repeat(64));
    expect(delivery.env).toBe("sandbox");
    expect(delivery.ttl).toBe(3_600);
    const message = open(delivery);
    expect(message.kind).toBe("ask");
    expect(message.sessionId).toBe("S");
    expect(message.computer).toBe("gabriel-mac");
    expect(message.cwd).toBe("/proj/one");
    expect(message.title).toBe("title of S");
    expect(message.ask).toMatchObject({
      requestId: "r1",
      tool: "shell",
      title: "run a command",
      preview: "rm -rf build",
      reply: { maxChars: 500 },
    });
    expect(message.ask?.options.map((o) => o.optionId)).toEqual(["allow_once", "reject_once"]);
    expect(r.audit).toContain(`push-sent ask ${DEVICE_A.slice(0, 8)}`);
  });

  test("another computer's key cannot open it (a relay cannot forge a push, F6)", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    await settled();
    const delivery = r.deliveries[0];
    if (delivery === undefined) throw new Error("no delivery");
    const envelope = delivery.payload.tp;
    const sealed = {
      keyId: envelope.k,
      enc: decodeBase64Url(envelope.e) as Uint8Array,
      ciphertext: decodeBase64Url(envelope.c) as Uint8Array,
    };
    expect(() => openPush(sealed, DEVICE, publicKeyOf(key(11)))).toThrow();
  });

  test("an answered-before-the-grace ask never pushes at all", async () => {
    // The desk case: you answer, the phone stays silent.
    const r = rig({ graceMs: 30_000, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    r.clock.advance(29_900);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "permission_resolved",
          requestId: "r1",
          outcome: { outcome: "selected", optionId: "allow_once" },
        },
      },
      NOBODY,
    );
    r.clock.advance(1_000);
    r.timers.fire();
    await settled();
    expect(r.deliveries).toEqual([]);
  });

  test("an ask answered AFTER a push sends ask_resolved under the SAME collapse id", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    await settled();
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "permission_resolved",
          requestId: "r1",
          outcome: { outcome: "selected", optionId: "allow_once" },
        },
      },
      NOBODY,
    );
    await settled();
    expect(r.deliveries).toHaveLength(2);
    const [ask, resolved] = r.deliveries;
    expect(resolved?.collapse).toBe(ask?.collapse as string);
    const message = open(resolved as PushDelivery);
    expect(message.kind).toBe("ask_resolved");
    expect(message.ask?.requestId).toBe("r1");
  });

  test("a turn end with nobody watching pushes turn_failed, with the error line", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "turn_end",
          turnId: "t1",
          stopReason: "error",
          error: { message: "provider exploded" },
        },
      },
      NOBODY,
    );
    await settled();
    expect(r.deliveries).toHaveLength(1);
    const message = open(r.deliveries[0] as PushDelivery);
    expect(message.kind).toBe("turn_failed");
    expect(message.turn).toEqual({ turnId: "t1", error: "provider exploded" });
  });
});

describe("who is pushed to (the authority's snapshot at push time)", () => {
  test("a REVOKED device is not pushed even though its file is still there (F14)", async () => {
    // Mutation: read the store alone (`registered()` ignoring the snapshot) → the
    // revoked device is pushed to.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A, DEVICE_B] });
    r.allow(DEVICE_A); // B is in the store, absent from the snapshot
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    await settled();
    expect(r.deliveries.map((d) => d.deviceId)).toEqual([DEVICE_A]);
  });

  test("a device attached to the session is not pushed; a phone locked mid-grace IS (F17)", async () => {
    // Mutation: drop the `attachment` event from the notifier (or the exclusion
    // in the rules) → the locked phone is never told.
    const r = rig({ graceMs: 30_000, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    const attached = { clients: 1, devices: [DEVICE_A] };
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, attached);
    // The phone locks: the foreground gate closes its socket.
    r.notifier.onPushEvent("S", { type: "attachment" }, NOBODY);
    r.clock.advance(30_000);
    r.timers.fire();
    await settled();
    expect(r.deliveries).toHaveLength(1);
  });

  test("every registered device is pushed to for a turn end (nothing to exclude)", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A, DEVICE_B] });
    r.allow(DEVICE_A, DEVICE_B);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" },
      },
      NOBODY,
    );
    await settled();
    expect(r.deliveries.map((d) => d.deviceId).sort()).toEqual([DEVICE_A, DEVICE_B]);
  });

  test("EVERY device of a fan-out gets the ask's content, not just the first", async () => {
    // The bug this pins (Review round 1, finding 2): `deliver` awaited each
    // device's sink in turn and built the message INSIDE that loop, while
    // `consume`'s `after` deletes the ask once the deliveries are queued. So a
    // fan-out is only safe while no ask is deleted before its LAST device is
    // built. Here device 1's sink is held open while the ask is answered: the
    // settle's `after` runs, and device 2 must still get `tool:"shell"`.
    // Mutation: build the message per device → device B's ask is blank.
    const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
    dirs.push(configDir);
    for (const deviceId of [DEVICE_A, DEVICE_B]) {
      writePushRegistration(configDir, {
        deviceId,
        token: "a".repeat(64),
        env: "sandbox",
        key: encodeBase64Url(publicKeyOf(DEVICE)),
        registeredAt: 1,
      });
    }
    const deliveries: PushDelivery[] = [];
    let open1: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      open1 = () => resolve();
    });
    let first = true;
    const notifier = createPushNotifier({
      now: () => 1_000,
      registrations: storeSource(configDir, () => [DEVICE_A, DEVICE_B]),
      describe: () => ({ title: "t", cwd: "/p" }),
      computer: () => ({ privateKey: COMPUTER, name: "c" }),
      sink: async (delivery) => {
        deliveries.push(delivery);
        if (first) {
          first = false;
          await held; // device 1's sink is in flight while the ask settles
        }
        return "sent";
      },
      onAudit: () => {},
      timers: manualTimers(),
      graceMs: 0,
      random: (length) => new Uint8Array(length).fill(7),
    });
    notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    await settled();
    // The fan-out is stuck on device 1, exactly where the old loop would resume.
    expect(deliveries.map((d) => d.deviceId)).toEqual([DEVICE_A]);
    notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "permission_resolved",
          requestId: "r1",
          outcome: { outcome: "selected", optionId: "allow_once" },
        },
      },
      NOBODY,
    );
    await settled();
    open1();
    await settled();
    const asks = deliveries
      .map((d) => ({ deviceId: d.deviceId, message: open(d) }))
      .filter((entry) => entry.message.kind === "ask");
    expect(asks.map((entry) => entry.deviceId).sort()).toEqual([DEVICE_A, DEVICE_B]);
    for (const entry of asks) {
      expect(entry.message.ask).toMatchObject({ requestId: "r1", tool: "shell" });
      expect(entry.message.ask?.options).toHaveLength(2);
    }
    notifier.stop();
  });

  test("ask_resolved carries the ask's content to EVERY device of the fold", async () => {
    // Same root cause, on the settle path: the `ask` push is fine (it is built at
    // the deadline), but `ask_resolved` names the request a banner refers to, so
    // a blank one leaves every phone but the first unable to place it.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A, DEVICE_B] });
    r.allow(DEVICE_A, DEVICE_B);
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    await settled();
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "permission_resolved",
          requestId: "r1",
          outcome: { outcome: "selected", optionId: "allow_once" },
        },
      },
      NOBODY,
    );
    await settled();
    const resolved = r.deliveries
      .map((d) => ({ deviceId: d.deviceId, message: open(d) }))
      .filter((entry) => entry.message.kind === "ask_resolved");
    expect(resolved.map((entry) => entry.deviceId).sort()).toEqual([DEVICE_A, DEVICE_B]);
    for (const entry of resolved) {
      expect(entry.message.ask).toMatchObject({ requestId: "r1", tool: "shell" });
      expect(entry.message.ask?.options).toHaveLength(2);
    }
  });
});

describe("a delivery status becomes one audit line (and only `gone` deletes)", () => {
  test("`gone` removes the registration it names, and nothing else (F11)", async () => {
    // Mutation: delete unconditionally (no compare) → a phone that re-registered
    // with a fresh token loses it.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A, DEVICE_B] });
    r.allow(DEVICE_A, DEVICE_B);
    r.answer("gone"); // the first device's answer
    r.notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    await settled();
    const left = readPushRegistrations(r.configDir).registrations;
    expect(left.has(DEVICE_A)).toBe(false);
    expect(left.has(DEVICE_B)).toBe(true);
    expect(r.audit.some((line) => line.startsWith(`push-gone ${DEVICE_A.slice(0, 8)}`))).toBe(true);
  });

  test("a late `gone` for an OLD token keeps the freshly re-registered one (F11)", async () => {
    // The race is between the SEND and Apple's answer: the phone re-registers
    // with a fresh token in between, and the `gone` names the old one. Mutation:
    // an unconditional delete → the fresh token is lost and the phone goes mute.
    const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
    dirs.push(configDir);
    writePushRegistration(configDir, {
      deviceId: DEVICE_A,
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(DEVICE)),
      registeredAt: 1,
    });
    const notifier = createPushNotifier({
      now: () => 1_000,
      registrations: storeSource(configDir, () => [DEVICE_A]),
      describe: () => ({ title: "t", cwd: "/p" }),
      computer: () => ({ privateKey: COMPUTER, name: "c" }),
      sink: () => {
        // The phone re-registers WHILE the push is in flight (iOS rotated it).
        const rewritten = writePushRegistration(configDir, {
          deviceId: DEVICE_A,
          token: "c".repeat(64),
          env: "sandbox",
          key: encodeBase64Url(publicKeyOf(DEVICE)),
          registeredAt: 2,
        });
        expect(rewritten.ok).toBe(true);
        return Promise.resolve("gone");
      },
      onAudit: () => {},
      timers: manualTimers(),
      graceMs: 0,
      random: (length) => new Uint8Array(length).fill(7),
    });
    notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    await settled();
    const registration = readPushRegistrations(configDir).registrations.get(DEVICE_A);
    expect(registration?.token).toBe("c".repeat(64));
    notifier.stop();
  });

  test("`throttled` / `unavailable` audit and keep the registration", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.answer("throttled");
    r.notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    await settled();
    expect(readPushRegistrations(r.configDir).registrations.has(DEVICE_A)).toBe(true);
    expect(r.audit.some((line) => line.startsWith("push-dropped throttled"))).toBe(true);
  });

  test("a refusing sink (a rejected promise) is `unavailable`, never a crash", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
    dirs.push(configDir);
    writePushRegistration(configDir, {
      deviceId: DEVICE_A,
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(DEVICE)),
      registeredAt: 1,
    });
    const audit: string[] = [];
    const timers = manualTimers();
    const notifier = createPushNotifier({
      now: () => 1_000,
      registrations: storeSource(configDir, () => [DEVICE_A]),
      describe: () => ({ title: "t", cwd: "/p" }),
      computer: () => ({ privateKey: COMPUTER, name: "c" }),
      sink: () => Promise.reject(new Error("link down")),
      onAudit: (line) => audit.push(line),
      timers,
      graceMs: 0,
      random: (length) => new Uint8Array(length).fill(7),
    });
    notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    await settled();
    expect(audit.some((line) => line.startsWith("push-dropped unavailable"))).toBe(true);
    notifier.stop();
  });
});

describe("the notifier's own failure modes", () => {
  test("a grace-0 push is NOT sealed inside the hook (the I/O is deferred)", async () => {
    // The hook runs inside `emit`, and `turn_end` runs inside the steering
    // no-await window: a sink that is slow (a relay round trip) must not be on
    // that stack. Mutation: drop the `queueMicrotask` in `consume` → the sink
    // has already been called when `onPushEvent` returns, and this fails.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    // Synchronously after the hook: nothing has reached the sink yet.
    expect(r.deliveries).toEqual([]);
    await settled();
    expect(r.deliveries).toHaveLength(1);
    r.notifier.stop();
  });

  test("no usable computer identity → nothing is sealed, and it is audited", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
    dirs.push(configDir);
    writePushRegistration(configDir, {
      deviceId: DEVICE_A,
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(DEVICE)),
      registeredAt: 1,
    });
    const deliveries: PushDelivery[] = [];
    const audit: string[] = [];
    const notifier = createPushNotifier({
      now: () => 1_000,
      registrations: storeSource(configDir, () => [DEVICE_A]),
      describe: () => ({ title: "t", cwd: "/p" }),
      computer: () => undefined, // an unreadable store
      sink: (d) => {
        deliveries.push(d);
        return Promise.resolve("sent");
      },
      onAudit: (line) => audit.push(line),
      timers: manualTimers(),
      graceMs: 0,
      random: (length) => new Uint8Array(length).fill(7),
    });
    notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    await settled();
    expect(deliveries).toEqual([]);
    expect(audit).toContain("push-dropped no-identity");
    notifier.stop();
  });

  test("the session is gone by the time the seal runs: audited, not pushed", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
    dirs.push(configDir);
    writePushRegistration(configDir, {
      deviceId: DEVICE_A,
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(DEVICE)),
      registeredAt: 1,
    });
    const deliveries: PushDelivery[] = [];
    const audit: string[] = [];
    const notifier = createPushNotifier({
      now: () => 1_000,
      registrations: storeSource(configDir, () => [DEVICE_A]),
      describe: () => undefined, // closed between the deadline and the microtask
      computer: () => ({ privateKey: COMPUTER, name: "c" }),
      sink: (d) => {
        deliveries.push(d);
        return Promise.resolve("sent");
      },
      onAudit: (line) => audit.push(line),
      timers: manualTimers(),
      graceMs: 0,
      random: (length) => new Uint8Array(length).fill(7),
    });
    notifier.onPushEvent(
      "S",
      { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
      NOBODY,
    );
    await settled();
    expect(deliveries).toEqual([]);
    expect(audit).toContain("push-dropped session-gone");
    notifier.stop();
  });

  test("a turn end's error line is released once its command is built (no leak over a long serve)", async () => {
    // The bug this pins: `turnErrors` got one entry per `turn_end` of every
    // session and only `stop()` cleared it. A `serve` runs for weeks, so that is
    // unbounded growth. Mutation: drop the `after` that deletes the entry → the
    // count stays at 1 after the push, and this fails.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "turn_end",
          turnId: "t1",
          stopReason: "error",
          error: { message: "provider exploded" },
        },
      },
      NOBODY,
    );
    await settled();
    // The message was built WITH the error line before the entry went away.
    const message = open(r.deliveries[0] as PushDelivery);
    expect(message.turn).toEqual({ turnId: "t1", error: "provider exploded" });
    expect(r.notifier.retained().turnErrors).toBe(0);
  });

  test("a turn the rules do not push at all also releases its error line", async () => {
    // The other half: no device registered means NO command, so nothing would
    // ever have read the entry — it still must not stay (this is the common case
    // on a serve nobody paired a phone to yet).
    const r = rig({ graceMs: 0 });
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "turn_end",
          turnId: "t1",
          stopReason: "error",
          error: { message: "provider exploded" },
        },
      },
      NOBODY,
    );
    await settled();
    expect(r.deliveries).toEqual([]);
    expect(r.notifier.retained().turnErrors).toBe(0);
  });

  test("a run's ask is ONE push, and its answer replaces it (slice 9's S9 row)", async () => {
    // docs/feat/agent-workflows.md §Tests S9: "a run waiting on the user
    // produces exactly one push; resolved → ask_resolved". A step's ask needs no
    // new mechanism — it IS a `permission_request` (D5), including the
    // `workflow_approve` kind the app must never auto-answer.
    // Mutation: push on every `permission_request` without the grace → two
    // buzzes for one wait, and the store's "one banner" claim breaks.
    const r = rig({ graceMs: 30_000, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    const approve: PermissionRequestUpdate = {
      ...askUpdate("wf-ask-1"),
      tool: "workflow_approve",
      title: "Run workflow task v1",
      options: [
        { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
        { optionId: "reject_once", kind: "reject_once", name: "Deny" },
      ],
    };
    r.notifier.onPushEvent("S", { type: "update", update: approve }, NOBODY);
    expect(r.deliveries).toEqual([]);
    r.clock.advance(30_000);
    r.timers.fire();
    await settled();
    expect(r.deliveries).toHaveLength(1);
    const asked = open(r.deliveries[0] as PushDelivery);
    expect(asked.kind).toBe("ask");
    expect(asked.ask?.tool).toBe("workflow_approve");
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: {
          type: "permission_resolved",
          requestId: "wf-ask-1",
          outcome: { optionId: "allow_once", outcome: "selected" },
        },
      },
      NOBODY,
    );
    await settled();
    expect(r.deliveries).toHaveLength(2);
    expect(open(r.deliveries[1] as PushDelivery).kind).toBe("ask_resolved");
    expect(r.notifier.retained().asks).toBe(0);
  });

  test("a run's end reaches the phone, named, once (slice 9: the sealed push)", async () => {
    // docs/feat/agent-workflows.md slice 9 (owner Q5): a run ending is news the
    // same way a turn ending is. The session reports runs ONLY through the
    // full-state `workflows` update, so that update is the seam — and because it
    // repeats an ended run on every later step, the notifier must push once.
    // Mutations: (a) drop the `workflows` case → no delivery at all;
    // (b) drop the rules' announced-run memory → one push per repeated update.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    const update = workflowsUpdate([
      runRow({ runId: "wf-1", name: "task", state: "ok", endedAt: 5 }),
      runRow({ runId: "wf-2", name: "task", state: "running" }),
    ]);
    r.notifier.onPushEvent("S", { type: "update", update }, NOBODY);
    await settled();
    expect(r.deliveries).toHaveLength(1);
    const message = open(r.deliveries[0] as PushDelivery);
    expect(message.kind).toBe("run_done");
    // The run is NAMED: the wheels carry `wf-N`, and the banner says the workflow.
    expect(message.run).toEqual({ runId: "wf-1", name: "task" });
    // The full-state list repeats it: no second buzz.
    r.notifier.onPushEvent("S", { type: "update", update }, NOBODY);
    await settled();
    expect(r.deliveries).toHaveLength(1);
    expect(r.notifier.retained().runs).toBe(0);
  });

  test("a scheduled fire that did not start reaches the phone once, named; `skipped` never does (slice 10)", async () => {
    // Mutations: drop the `schedules` case → no delivery; push `skipped` too → 2 deliveries.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    const row = (id: string, fires: number, outcome: string) => ({
      id,
      kind: "daily",
      spec: "daily 03:00",
      prompt: "workflow nightly",
      nextAt: 10,
      fires,
      createdAt: 1,
      workflow: { name: "nightly", inputs: [], hash: "3f2a9b1c" },
      last: { at: 5, outcome, reason: `${outcome}\nsecond line` },
    });
    const update: PushWatchedUpdate = {
      type: "schedules",
      schedules: [row("sc-3", 1, "changed"), row("sc-4", 2, "skipped")],
    };
    r.notifier.onPushEvent("S", { type: "update", update }, NOBODY);
    await settled();
    expect(r.deliveries).toHaveLength(1);
    const message = open(r.deliveries[0] as PushDelivery);
    expect(message.kind).toBe("run_not_started");
    expect(message.schedule).toEqual({
      scheduleId: "sc-3",
      name: "nightly",
      reason: "changed second line",
    });
    r.notifier.onPushEvent("S", { type: "update", update }, NOBODY);
    await settled();
    expect(r.deliveries).toHaveLength(1);
  });

  test("a run stopped with a reason carries it, one line", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: workflowsUpdate([
          runRow({
            runId: "wf-3",
            name: "gate",
            state: "stopped",
            stopReason: "timeout",
            reason: "gate: an ask was not answered in time",
            endedAt: 9,
          }),
        ]),
      },
      NOBODY,
    );
    await settled();
    const message = open(r.deliveries[0] as PushDelivery);
    expect(message.kind).toBe("run_stopped");
    expect(message.run).toEqual({
      runId: "wf-3",
      name: "gate",
      reason: "gate: an ask was not answered in time",
    });
  });

  test("a multi-line reason is flattened, never dropped: the wire refuses a newline", async () => {
    // A failed `run` step's reason is the TAIL of its output, so it holds
    // newlines — which the plaintext's `line()` rejects. Building the message
    // with them makes `fitPushMessage` return a shape `PushMessageSchema`
    // refuses, and the push is silently dropped. Mutation: pass `reason` through
    // unchanged → `open()` here throws.
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: workflowsUpdate([
          runRow({
            runId: "wf-5",
            name: "gate",
            state: "error",
            reason: "exit 2\nfailing test: foo\n  at bar.ts:1",
            endedAt: 3,
          }),
        ]),
      },
      NOBODY,
    );
    await settled();
    expect(r.deliveries).toHaveLength(1);
    const message = open(r.deliveries[0] as PushDelivery);
    expect(message.kind).toBe("run_stopped");
    expect(message.run?.reason).toBe("exit 2 failing test: foo at bar.ts:1");
    // A reason that is only whitespace is ABSENT, never an empty string.
    const empty = rig({ graceMs: 0, registrations: [DEVICE_A] });
    empty.allow(DEVICE_A);
    empty.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: workflowsUpdate([
          runRow({ runId: "wf-6", name: "gate", state: "error", reason: "  \n ", endedAt: 4 }),
        ]),
      },
      NOBODY,
    );
    await settled();
    const bare = open(empty.deliveries[0] as PushDelivery);
    expect(bare.run).toEqual({ runId: "wf-6", name: "gate" });
  });

  test("a run end with a client watching pushes nothing, and leaks nothing", async () => {
    const r = rig({ graceMs: 0, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent(
      "S",
      {
        type: "update",
        update: workflowsUpdate([runRow({ runId: "wf-1", name: "t", state: "ok", endedAt: 1 })]),
      },
      { clients: 1, devices: [DEVICE_A] },
    );
    await settled();
    expect(r.deliveries).toEqual([]);
    // The rules decided not to push, so the fact it would have used is gone.
    expect(r.notifier.retained().runs).toBe(0);
  });

  test("stop() clears the timer: nothing fires afterwards", async () => {
    const r = rig({ graceMs: 30_000, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    r.notifier.onPushEvent("S", { type: "update", update: askUpdate("r1") }, NOBODY);
    r.notifier.stop();
    r.clock.advance(60_000);
    r.timers.fire();
    await settled();
    expect(r.deliveries).toEqual([]);
  });

  test("the hook NEVER throws, whatever the sink does (F24)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "push-notifier-"));
    dirs.push(configDir);
    const notifier = createPushNotifier({
      now: () => 1_000,
      registrations: storeSource(configDir, () => []),
      describe: () => {
        throw new Error("describe bug");
      },
      computer: () => ({ privateKey: COMPUTER, name: "c" }),
      sink: () => Promise.resolve("sent"),
      onAudit: () => {},
      timers: manualTimers(),
      graceMs: 0,
      random: (length) => new Uint8Array(length).fill(7),
    });
    expect(() =>
      notifier.onPushEvent(
        "S",
        { type: "update", update: { type: "turn_end", turnId: "t1", stopReason: "end_turn" } },
        NOBODY,
      ),
    ).not.toThrow();
    notifier.stop();
  });
});

describe("pushRegisterStatus: one vocabulary (Design 6 / F4)", () => {
  test("off / relay-off / relay-no-push / on", () => {
    expect(pushRegisterStatus({ enabled: false, relay: "on", relaySupportsPush: true })).toBe(
      "off",
    );
    expect(pushRegisterStatus({ enabled: true, relay: "off", relaySupportsPush: false })).toBe(
      "relay-off",
    );
    expect(pushRegisterStatus({ enabled: true, relay: "on", relaySupportsPush: false })).toBe(
      "relay-no-push",
    );
    expect(pushRegisterStatus({ enabled: true, relay: "on", relaySupportsPush: true })).toBe("on");
  });
});

describe("the store's own clear still works (a regression guard for P7's writer)", () => {
  test("clearPushRegistrations empties the directory", () => {
    const r = rig({ registrations: [DEVICE_A, DEVICE_B] });
    expect(readPushRegistrations(r.configDir).registrations.size).toBe(2);
    expect(clearPushRegistrations(r.configDir)).toBe(2);
    expect(readPushRegistrations(r.configDir).registrations.size).toBe(0);
    r.notifier.stop();
  });
});

describe("a remote agent's question (docs/feat/a2a-client.md C6)", () => {
  test("a held question_request pushes an ask in question mode: first line as preview, only Skip", async () => {
    // Mutation: drop the `question_request` branch in `buildMessage` → the push
    // goes out as an empty ask with no `question` → red.
    const r = rig({ graceMs: 30_000, registrations: [DEVICE_A] });
    r.allow(DEVICE_A);
    const update: QuestionRequestUpdate = {
      type: "question_request",
      requestId: "q1",
      toolCallId: "c1",
      title: "acme asks",
      question: "Remote question (https://agents.acme.dev): Which branch?\nmain or dev",
      agent: { type: "a2a:acme", description: "review" },
      maxChars: 4000,
    };
    r.notifier.onPushEvent("S", { type: "update", update }, NOBODY);
    r.clock.advance(30_000);
    r.timers.fire();
    await settled();
    const delivery = r.deliveries[0];
    if (delivery === undefined) throw new Error("no delivery");
    const message = open(delivery);
    expect(message.kind).toBe("ask");
    expect(message.ask).toMatchObject({
      requestId: "q1",
      tool: "a2a:acme",
      title: "acme asks",
      preview: "Remote question (https://agents.acme.dev): Which branch?",
      options: [{ optionId: "skip", kind: "reject_once", name: "Skip" }],
      question: { maxChars: 4000 },
    });
    r.notifier.stop();
  });
});
