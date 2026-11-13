/**
 * `PairHandler` — the daemon half of the pairing exchange (docs/feat/device-
 * pairing.md 9c). Real files in a temp config dir (the 9a store), a REAL 9a
 * `openPairing` window, and a fake human standing in for `pair` (it answers the
 * way `pair` will: registry first, then the decision — F3).
 *
 * The property under test everywhere is that the KEY IS THE CHANNEL'S: params
 * carry no key field at all, and F18's test sends a foreign key in the params
 * to prove it is ignored.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DevicePairParams, DomainErrorCode } from "@tentacle/protocol";
import {
  type DeviceIdentity,
  addDevice,
  claimPairing,
  deviceIdOf,
  findPairing,
  loadOrCreateIdentity,
  openPairing,
  readClaim,
  readRegistry,
  writePairingDecision,
} from "../src/device-store.ts";
import { PAIRING_MAX_ATTEMPTS, PairHandler, pairingRefusedError } from "../src/pairing-handler.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CODE = "K7M2QX9AB3";
const OTHER_CODE = "ABCDEFGH23";
const key = (fill: number) => new Uint8Array(32).fill(fill);

function store(): { configDir: string; identity: DeviceIdentity } {
  const configDir = mkdtempSync(join(tmpdir(), "pairing-handler-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  return { configDir, identity: created.identity };
}

/** A window as `pair` would leave it (its own pid: alive for the whole test). */
function window(configDir: string, over: { code?: string; ttlMs?: number } = {}): string {
  const opened = openPairing(configDir, {
    code: over.code ?? CODE,
    now: Date.now(),
    pid: process.pid,
    ...(over.ttlMs !== undefined ? { ttlMs: over.ttlMs } : {}),
  });
  if (!opened.ok) throw new Error(opened.reason);
  return opened.session.sid;
}

function handler(
  configDir: string,
  identity: DeviceIdentity,
  remoteStatic: Uint8Array,
  over: {
    close?: () => void;
    onAudit?: (line: string) => void;
    alive?: (pid: number) => boolean;
  } = {},
): PairHandler {
  return new PairHandler({
    configDir,
    identity,
    remoteStatic,
    pollMs: 5,
    ...over,
  });
}

const params = (over: Partial<DevicePairParams> = {}): DevicePairParams => ({
  code: CODE,
  name: "iPhone di Gabriel",
  ...over,
});

/** The human saying yes, the way `pair` does it: registry FIRST, then decision (F3). */
function accept(configDir: string, sid: string, deviceKey: Uint8Array, name: string): void {
  const added = addDevice(configDir, { publicKey: deviceKey, name, now: 3_000 });
  if (!added.ok) throw new Error(added.reason);
  writePairingDecision(configDir, sid, true);
}

describe("the key is the CHANNEL's, never a parameter (F18)", () => {
  test("a foreign key in the params is ignored: the registry gets the channel key", async () => {
    // The plan's mutation: give `DevicePairParams` a `publicKey` field and use
    // it. Today the params schema STRIPS it (AGENTS §7), and the handler reads
    // only `remoteStatic`, so a peer cannot register a key it does not hold —
    // which is the whole security property of the exchange.
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    const foreignKey = key(42);
    const handlerForConnection = handler(configDir, identity, channelKey);
    const attempt = handlerForConnection.pair({
      ...params(),
      // Not in the schema at all: a future field or a hostile extra one.
      publicKey: Buffer.from(foreignKey).toString("base64url"),
      deviceKey: Buffer.from(foreignKey).toString("hex"),
    } as DevicePairParams);
    // The human accepts the CHANNEL key, as the SAS shown on the terminal did.
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    const outcome = await attempt;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result.deviceId).toBe(deviceIdOf(channelKey));
    const registry = readRegistry(configDir);
    if (!registry.ok) throw new Error(registry.reason);
    expect(registry.registry.devices.map((d) => d.id)).toEqual([deviceIdOf(channelKey)]);
    expect(readClaim(configDir, sid)?.publicKey).toEqual(channelKey);
  });

  test("the claim carries the channel key and the SAS over both keys", async () => {
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    const attempt = handler(configDir, identity, channelKey).pair(params());
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    await attempt;
    const claim = readClaim(configDir, sid);
    if (claim === undefined) throw new Error("the claim must exist");
    expect(claim.publicKey).toEqual(channelKey);
    expect(claim.name).toBe("iPhone di Gabriel");
    // 6 digits, and it is the SAS over (computer key, DEVICE key) in that order.
    expect(claim.sas).toMatch(/^\d{6}$/);
    const { pairingSas } = await import("@tentacle/transport/noise");
    expect(claim.sas).toBe(pairingSas(identity.publicKey, channelKey));
  });
});

describe("the happy path", () => {
  test("a correct code plus the human's `y` pairs the device and names the computer", async () => {
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    const attempt = handler(configDir, identity, channelKey).pair(params());
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    const outcome = await attempt;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.result).toEqual({
      deviceId: deviceIdOf(channelKey),
      computer: { id: deviceIdOf(identity.publicKey), name: "gabriel-mac" },
    });
  });

  test("the registry alone decides success: a `pair` that died before the decision still pairs (F3)", async () => {
    // `pair` writes the registry FIRST and the decision second; a `pair` that
    // exits between them (crash, Ctrl+C on the same tick) leaves no decision —
    // and the phone must still get its success, because its key is authorised.
    const { configDir, identity } = store();
    window(configDir);
    const channelKey = key(7);
    const attempt = handler(configDir, identity, channelKey).pair(params());
    const added = addDevice(configDir, { publicKey: channelKey, name: "iPhone", now: 3_000 });
    if (!added.ok) throw new Error(added.reason);
    const outcome = await attempt;
    expect(outcome.ok).toBe(true);
  });

  test("a retry of the same code on the SAME connection is idempotent, not `used`", async () => {
    // The phone lost the answer frame, not the socket: its own claim must not
    // read as a stranger's, or a transient drop would burn the one-time code.
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    const connection = handler(configDir, identity, channelKey);
    const first = connection.pair(params());
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    expect((await first).ok).toBe(true);
    const second = await connection.pair(params());
    expect(second.ok).toBe(true);
  });
});

describe("refusals", () => {
  test("a wrong code is `invalid_code`, and no claim is written", async () => {
    const { configDir, identity } = store();
    const sid = window(configDir);
    const outcome = await handler(configDir, identity, key(7)).pair(params({ code: OTHER_CODE }));
    expect(outcome).toEqual({ ok: false, reason: "invalid_code" });
    expect(readClaim(configDir, sid)).toBeUndefined();
  });

  test("a code that is not the alphabet is `invalid_code`, never a throw (9a N3)", async () => {
    // `findPairing` hashes the code and THROWS on a non-Crockford string. A
    // peer's input reaches it, so the handler must absorb that.
    const { configDir, identity } = store();
    window(configDir);
    const outcome = await handler(configDir, identity, key(7)).pair(params({ code: "!!!!!!!!!!" }));
    expect(outcome).toEqual({ ok: false, reason: "invalid_code" });
  });

  test("an expired window is `invalid_code` (the daemon tells an anonymous peer nothing)", async () => {
    const { configDir, identity } = store();
    window(configDir, { ttlMs: -1 });
    const outcome = await handler(configDir, identity, key(7)).pair(params());
    expect(outcome).toEqual({ ok: false, reason: "invalid_code" });
  });

  test("a window whose `pair` died is `invalid_code` (F2)", async () => {
    const { configDir, identity } = store();
    // A pid that is certainly gone: our own plus a large offset would be a
    // guess, so ask the OS for a dead one — `alive` is the injected seam and
    // the store's default is `kill(pid, 0)`. Use a pid the store cannot see.
    const opened = openPairing(configDir, {
      code: CODE,
      now: Date.now(),
      pid: 2 ** 22 + 12345,
    });
    if (!opened.ok) throw new Error(opened.reason);
    const outcome = await handler(configDir, identity, key(7), {
      alive: () => false,
    }).pair(params());
    expect(outcome).toEqual({ ok: false, reason: "invalid_code" });
  });

  test("the human's `N` is `declined`, and the registry stays empty", async () => {
    const { configDir, identity } = store();
    const sid = window(configDir);
    const attempt = handler(configDir, identity, key(7)).pair(params());
    writePairingDecision(configDir, sid, false);
    const outcome = await attempt;
    expect(outcome).toEqual({ ok: false, reason: "declined" });
    const registry = readRegistry(configDir);
    if (!registry.ok) throw new Error(registry.reason);
    expect(registry.registry.devices).toHaveLength(0);
  });

  test("the window expiring while the phone waits is `timeout`", async () => {
    const { configDir, identity } = store();
    window(configDir, { ttlMs: 30 });
    const outcome = await handler(configDir, identity, key(7)).pair(params());
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
  });

  test("a decision with no registry entry declines (the registry is the authority, F14)", async () => {
    // Never fail open: a decision file alone authorises nobody.
    const { configDir, identity } = store();
    const sid = window(configDir);
    const attempt = handler(configDir, identity, key(7)).pair(params());
    writePairingDecision(configDir, sid, true);
    const outcome = await attempt;
    expect(outcome).toEqual({ ok: false, reason: "declined" });
  });

  test("a second phone on the same code is `used` (F1/F5)", async () => {
    const { configDir, identity } = store();
    const sid = window(configDir);
    const first = handler(configDir, identity, key(7));
    const firstAttempt = first.pair(params());
    accept(configDir, sid, key(7), "iPhone di Gabriel");
    expect((await firstAttempt).ok).toBe(true);
    // A DIFFERENT connection (another socket, another key) with the same code.
    const second = await handler(configDir, identity, key(9)).pair(params({ name: "attacker" }));
    expect(second).toEqual({ ok: false, reason: "used" });
  });

  test("a peer that hangs up mid-wait stops the wait (abort)", async () => {
    const { configDir, identity } = store();
    window(configDir);
    const controller = new AbortController();
    const attempt = handler(configDir, identity, key(7)).pair(params(), controller.signal);
    controller.abort();
    const outcome = await attempt;
    expect(outcome).toEqual({ ok: false, reason: "timeout" });
  });
});

describe("the attempt cap (F6/F16)", () => {
  test("the fifth wrong code is `too_many_attempts` and closes the connection", async () => {
    const { configDir, identity } = store();
    window(configDir);
    let closed = 0;
    const connection = handler(configDir, identity, key(7), {
      close: () => {
        closed++;
      },
    });
    const reasons: string[] = [];
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      const outcome = await connection.pair(params({ code: OTHER_CODE }));
      reasons.push(outcome.ok ? "ok" : outcome.reason);
    }
    expect(reasons).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
    ]);
    expect(connection.attemptCount).toBe(PAIRING_MAX_ATTEMPTS);
    // The close is deferred to a macrotask so the refusal frame goes first.
    await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(1);
  });

  test("a correct code after four wrong ones still pairs (the cap is on WRONG codes)", async () => {
    // The cap must not make a mistyping human's success impossible: only the
    // fifth WRONG code closes the socket, and the count is of refusals.
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    let closed = 0;
    const connection = handler(configDir, identity, channelKey, {
      close: () => {
        closed++;
      },
    });
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS - 1; i++) {
      await connection.pair(params({ code: OTHER_CODE }));
    }
    const attempt = connection.pair(params());
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    const outcome = await attempt;
    expect(outcome.ok).toBe(true);
    expect(closed).toBe(0);
  });

  test("requests PIPELINED past the cap are refused too, and cannot spend the window", async () => {
    // `RpcPeer` dispatches requests concurrently (§7), and the cap's close is a
    // macrotask: everything a peer sent before that close is already running.
    // Without an entry check, each of those still runs `findPairing` +
    // `claimPairing`, so 8 wrong codes and then the right one — sent without
    // awaiting — spend the window on guess NINE (F6/F16 broken). The property:
    // once the cap is reached, NO later request on this connection looks at
    // anything, and the window stays unclaimed.
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    let closed = 0;
    const connection = handler(configDir, identity, channelKey, {
      close: () => {
        closed++;
      },
    });
    // Five wrong codes sent together (never awaited between them).
    const wrong = Array.from({ length: PAIRING_MAX_ATTEMPTS }, () =>
      connection.pair(params({ code: OTHER_CODE })),
    );
    // …then the RIGHT code, pipelined behind them, and the human saying yes.
    const right = connection.pair(params());
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    const outcomes = await Promise.all([...wrong, right]);
    expect(outcomes.map((o) => (o.ok ? "ok" : o.reason))).toEqual([
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "invalid_code",
      "too_many_attempts",
      "too_many_attempts",
    ]);
    // The window was never claimed (the fake human's `accept` writes the
    // registry unconditionally, so the CLAIM is the property here).
    expect(readClaim(configDir, sid)).toBeUndefined();
    // The close still happens (exactly once: only the fifth wrong code spends).
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(1);
  });

  test("a spent connection spends nothing more: no claim, no lookup, no count", async () => {
    // Stronger than the ordering above: after the cap, a request with the
    // CORRECT code is refused without touching the store at all. Mutation:
    // drop the entry check -> the right code claims the window (the human's
    // `y` then registers a device on a connection that was already closed).
    const { configDir, identity } = store();
    const sid = window(configDir);
    const channelKey = key(7);
    const connection = handler(configDir, identity, channelKey);
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      await connection.pair(params({ code: OTHER_CODE }));
    }
    const spent = await connection.pair(params());
    expect(spent).toEqual({ ok: false, reason: "too_many_attempts" });
    expect(connection.attemptCount).toBe(PAIRING_MAX_ATTEMPTS);
    expect(readClaim(configDir, sid)).toBeUndefined();
    // The one-time code is still usable by a real phone on a NEW connection.
    const fresh = handler(configDir, identity, key(9));
    const attempt = fresh.pair(params({ name: "a real phone" }));
    accept(configDir, sid, key(9), "a real phone");
    expect((await attempt).ok).toBe(true);
  });

  test("the audit line names the reason and the attempt count", async () => {
    const { configDir, identity } = store();
    window(configDir);
    const lines: string[] = [];
    const connection = handler(configDir, identity, key(7), {
      onAudit: (line) => lines.push(line),
    });
    await connection.pair(params({ code: OTHER_CODE }));
    expect(lines).toEqual([
      `pairing-refused ${deviceIdOf(key(7)).slice(0, 8)} invalid_code attempts=1`,
    ]);
  });
});

describe("the wire error", () => {
  test("`pairingRefusedError` carries the code and the reason a client branches on", () => {
    const error = pairingRefusedError("too_many_attempts");
    expect(error.code).toBe(DomainErrorCode.PairingRefused);
    expect(error.data).toEqual({ reason: "too_many_attempts" });
    expect(error.message).toContain("too many");
  });

  test("every reason round-trips through the error's data", () => {
    for (const reason of [
      "invalid_code",
      "used",
      "declined",
      "timeout",
      "too_many_attempts",
      "already_paired",
    ] as const) {
      expect(pairingRefusedError(reason).data).toEqual({ reason });
    }
  });
});

describe("an unreadable registry never admits (F14)", () => {
  test("a decision file plus a garbled registry declines, and the file is left alone", async () => {
    // The property: the registry (written first, F3) is the authority, so an
    // UNREADABLE one must read as "lists nobody" — never as "lists everybody",
    // which a `registry.ok ? … : true` mistake would do. The human's `accepted`
    // is not enough on its own, and the file is never rewritten by the daemon.
    const { configDir, identity } = store();
    const sid = window(configDir);
    const garbled = '{"v":1,"devices":[{"id":"nope"}]}';
    const path = join(configDir, "devices", "registry.json");
    writeFileSync(path, garbled, { mode: 0o600 });
    const attempt = handler(configDir, identity, key(7)).pair(params());
    writePairingDecision(configDir, sid, true);
    const outcome = await attempt;
    expect(outcome).toEqual({ ok: false, reason: "declined" });
    expect(readFileSync(path, "utf8")).toBe(garbled);
  });
});

describe("the window's own store is not mutated by a refusal", () => {
  test("a wrong code leaves the window usable for the right one on another connection", async () => {
    // A refused attempt must not consume the one-time code (only a CLAIM does).
    const { configDir, identity } = store();
    const sid = window(configDir);
    await handler(configDir, identity, key(9)).pair(params({ code: OTHER_CODE }));
    expect(findPairing(configDir, { code: CODE })).toBeDefined();
    const channelKey = key(7);
    const attempt = handler(configDir, identity, channelKey).pair(params());
    accept(configDir, sid, channelKey, "iPhone di Gabriel");
    expect((await attempt).ok).toBe(true);
    // And the claim is the only one, made by the winner.
    expect(readClaim(configDir, sid)?.publicKey).toEqual(channelKey);
    expect(claimPairing(configDir, { sid, deviceKey: key(8), name: "x", now: Date.now() })).toEqual(
      {
        ok: false,
        reason: "used",
      },
    );
  });
});
