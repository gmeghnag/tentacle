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
import type { PermissionRequestUpdate } from "@tentacle/protocol";
import { openPush, publicKeyOf } from "@tentacle/transport/push";
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
