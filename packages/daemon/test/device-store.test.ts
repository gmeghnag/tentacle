/**
 * The device store (docs/feat/device-pairing.md 9a, Design "On-disk layout").
 *
 * The properties, one per block, each naming the mutation that would fake it:
 * - the identity is created ONCE, exclusively (`link`), and never replaced
 *   (mutation: plain `writeFileSync` → two daemons, two keys);
 * - an unreadable or unknown-version file is REFUSED and left byte-for-byte
 *   untouched — never emptied, never "repaired" (mutation: accept any `v`, or
 *   treat a parse error as an empty registry);
 * - the registry has one writer at a time and a stale lock is taken over;
 * - a pairing window is claimed ONCE (mutation: drop `wx`), the code is stored
 *   only as its digest, and an expired or orphaned window is not found.
 */
import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PAIRING_ADDRESSES } from "@tentacle/protocol";
import {
  DEVICE_DIR,
  DEVICE_ID_HEX,
  PAIRING_TTL_MS,
  acquireRegistryLock,
  addDevice,
  claimPairing,
  closePairing,
  dedupeName,
  deviceDir,
  deviceIdOf,
  findPairing,
  hasLivePairing,
  loadOrCreateIdentity,
  openPairing,
  pairingCodeHash,
  parseEtime,
  processStartedAt,
  readClaim,
  readDaemonRecords,
  readIdentity,
  readPairingDecision,
  readRegistry,
  readSeen,
  removeDevices,
  replaceIdentity,
  sweepDeadDaemonRecords,
  sweepPairings,
  touchDaemonRecord,
  touchSeen,
  writeDaemonRecord,
  writePairingDecision,
  writeRegistry,
} from "../src/device-store.ts";

/** The project every window here is opened for (docs/feat/mobile-projects.md §1). */
const TEST_PROJECT = { key: "proj-0123456789ab", cwd: "/u/proj" };

const CODE = "K7M2QX9AB3";
const OTHER_CODE = "Z7M2QX9AB3";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "device-store-"));
  dirs.push(dir);
  return dir;
}

const key = (fill: number) => new Uint8Array(32).fill(fill);
const identityFile = (configDir: string) => join(deviceDir(configDir), "identity.json");
const registryFile = (configDir: string) => join(deviceDir(configDir), "registry.json");

function createIdentity(configDir: string, fill = 1, name = "gabriel-mac") {
  const result = loadOrCreateIdentity(configDir, {
    name,
    now: 1_700_000_000_000,
    random: () => key(fill),
  });
  if (!result.ok) throw new Error(`identity refused: ${result.reason}`);
  return result.identity;
}

describe("identity", () => {
  test("is created at 0600 in a 0700 dir, and read back identically", () => {
    const configDir = scratch();
    const created = createIdentity(configDir);
    expect(statSync(identityFile(configDir)).mode & 0o777).toBe(0o600);
    expect(statSync(deviceDir(configDir)).mode & 0o777).toBe(0o700);
    const read = readIdentity(configDir);
    if (!read.ok) throw new Error(read.reason);
    expect(read.identity.name).toBe("gabriel-mac");
    expect([...read.identity.publicKey]).toEqual([...created.publicKey]);
    expect([...read.identity.privateKey]).toEqual([...created.privateKey]);
  });

  test("a second creator keeps the FIRST key, never replacing it", () => {
    // The mutation (a plain writeFileSync instead of tmp + link) makes this
    // fail: the second call would overwrite the key every daemon already
    // published in a QR.
    const configDir = scratch();
    const first = createIdentity(configDir, 1);
    const before = readFileSync(identityFile(configDir), "utf8");
    const second = createIdentity(configDir, 9);
    expect([...second.publicKey]).toEqual([...first.publicKey]);
    expect(readFileSync(identityFile(configDir), "utf8")).toBe(before);
  });

  test("concurrent creators converge on one key (separate processes)", async () => {
    const configDir = scratch();
    const script = `
      import { loadOrCreateIdentity } from ${JSON.stringify(join(import.meta.dir, "../src/device-store.ts"))};
      const r = loadOrCreateIdentity(${JSON.stringify(configDir)}, { name: "race" });
      if (!r.ok) throw new Error(r.reason);
      console.log(JSON.stringify([...r.identity.publicKey]));
    `;
    const runs = Array.from({ length: 6 }, () =>
      Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const outputs = await Promise.all(
      runs.map(async (run) => ({
        text: await new Response(run.stdout).text(),
        code: await run.exited,
      })),
    );
    const keys = outputs.filter((o) => o.code === 0).map((o) => o.text.trim());
    expect(keys.length).toBe(6);
    expect(new Set(keys).size).toBe(1);
    const read = readIdentity(configDir);
    if (!read.ok) throw new Error(read.reason);
    expect(JSON.stringify([...read.identity.publicKey])).toBe(keys[0] ?? "");
    expect(statSync(identityFile(configDir)).mode & 0o777).toBe(0o600);
  });

  test("an unknown version is refused and the file is untouched", () => {
    // Mutation: accept any `v` → the identity loads and a daemon trusts a
    // record whose meaning it does not know.
    const configDir = scratch();
    createIdentity(configDir);
    const future = JSON.stringify({
      ...JSON.parse(readFileSync(identityFile(configDir), "utf8")),
      v: 99,
    });
    writeFileSync(identityFile(configDir), future);
    const read = readIdentity(configDir);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.path).toBe(identityFile(configDir));
      expect(read.reason).toContain("unknown version 99");
    }
    expect(readFileSync(identityFile(configDir), "utf8")).toBe(future);
    // And a SECOND create attempt must not "fix" it by overwriting either.
    expect(loadOrCreateIdentity(configDir, { name: "x" }).ok).toBe(false);
    expect(readFileSync(identityFile(configDir), "utf8")).toBe(future);
  });

  test("a garbled identity is refused, naming the file", () => {
    const configDir = scratch();
    mkdirSync(deviceDir(configDir), { recursive: true, mode: 0o700 });
    writeFileSync(identityFile(configDir), "{not json");
    const read = readIdentity(configDir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("not valid JSON");
    expect(readFileSync(identityFile(configDir), "utf8")).toBe("{not json");
  });

  test("a loose mode left by another build is tightened when the identity is loaded", () => {
    // The private key's only protection is its mode: a store written under a
    // loose umask (or by an older build) must not stay world-readable.
    const configDir = scratch();
    const before = createIdentity(configDir);
    chmodSync(identityFile(configDir), 0o644);
    chmodSync(deviceDir(configDir), 0o755);
    const loaded = loadOrCreateIdentity(configDir, { name: "ignored" });
    if (!loaded.ok) throw new Error(loaded.reason);
    expect([...loaded.identity.publicKey]).toEqual([...before.publicKey]);
    expect(statSync(identityFile(configDir)).mode & 0o777).toBe(0o600);
    expect(statSync(deviceDir(configDir)).mode & 0o777).toBe(0o700);
  });

  test("replaceIdentity rotates the key (devices reset)", () => {
    const configDir = scratch();
    const before = createIdentity(configDir, 1);
    const after = replaceIdentity(configDir, {
      name: "gabriel-mac",
      now: 1_700_000_001_000,
      random: () => key(4),
    });
    if (!after.ok) throw new Error(after.reason);
    expect([...after.identity.publicKey]).not.toEqual([...before.publicKey]);
    expect(statSync(identityFile(configDir)).mode & 0o777).toBe(0o600);
  });
});

describe("registry", () => {
  test("a fresh computer has an empty one (absent is not an error)", () => {
    const result = readRegistry(scratch());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.registry.devices).toEqual([]);
  });

  test("round-trips an entry, deriving its id from its key", () => {
    const configDir = scratch();
    const added = addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 42 });
    if (!added.ok) throw new Error(added.reason);
    expect(added.device.id).toBe(deviceIdOf(key(2)));
    expect(added.device.id).toHaveLength(DEVICE_ID_HEX);
    const read = readRegistry(configDir);
    if (!read.ok) throw new Error(read.reason);
    expect(read.registry.devices).toHaveLength(1);
    expect(read.registry.devices[0]?.name).toBe("iPhone");
    expect(read.registry.devices[0]?.pairedAt).toBe(42);
    expect([...(read.registry.devices[0]?.publicKey ?? [])]).toEqual([...key(2)]);
    // The key is stored in its one string form (unpadded base64url, no `=`).
    expect(readFileSync(registryFile(configDir), "utf8")).not.toContain("=");
  });

  test("re-adding the same key is idempotent; a new key under a name is suffixed", () => {
    const configDir = scratch();
    addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 1 });
    addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 2 });
    const second = addDevice(configDir, { publicKey: key(3), name: "iPhone", now: 3 });
    if (!second.ok) throw new Error(second.reason);
    const read = readRegistry(configDir);
    if (!read.ok) throw new Error(read.reason);
    expect(read.registry.devices.map((d) => d.name)).toEqual(["iPhone", "iPhone (2)"]);
    expect(second.device.name).toBe("iPhone (2)");
    expect(dedupeName(read.registry, "iPhone")).toBe("iPhone (3)");
    expect(dedupeName(read.registry, "Pixel")).toBe("Pixel");
  });

  test("a garbled registry is refused and left byte-for-byte alone", () => {
    // Mutation: treat a parse error as an empty registry → one bad byte
    // silently disconnects every phone, and the next write erases them.
    const configDir = scratch();
    addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 1 });
    const garbled = '{"v":1,"devices":[{"id":"nope"';
    writeFileSync(registryFile(configDir), garbled);
    const read = readRegistry(configDir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.path).toBe(registryFile(configDir));
    expect(readFileSync(registryFile(configDir), "utf8")).toBe(garbled);
    // A write must not clobber it either.
    expect(addDevice(configDir, { publicKey: key(3), name: "Pixel" }).ok).toBe(false);
    expect(writeRegistry(configDir, { devices: [] }).ok).toBe(false);
    expect(readFileSync(registryFile(configDir), "utf8")).toBe(garbled);
  });

  test("an entry whose id does not match its key is refused (never 'repaired')", () => {
    const configDir = scratch();
    addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 1 });
    const value = JSON.parse(readFileSync(registryFile(configDir), "utf8"));
    const forged = JSON.stringify({
      ...value,
      devices: [{ ...value.devices[0], id: deviceIdOf(key(7)) }],
    });
    writeFileSync(registryFile(configDir), forged);
    expect(readRegistry(configDir).ok).toBe(false);
    expect(readFileSync(registryFile(configDir), "utf8")).toBe(forged);
  });

  test("an unknown version is refused", () => {
    const configDir = scratch();
    mkdirSync(deviceDir(configDir), { recursive: true, mode: 0o700 });
    const future = JSON.stringify({ v: 3, devices: [] });
    writeFileSync(registryFile(configDir), future);
    const read = readRegistry(configDir);
    expect(read.ok).toBe(false);
    expect(readFileSync(registryFile(configDir), "utf8")).toBe(future);
  });

  test("the lock refuses a live holder and takes over a dead one", () => {
    const configDir = scratch();
    const held = acquireRegistryLock(configDir);
    expect(() => acquireRegistryLock(configDir)).toThrow(/is editing the device registry/);
    held.release();
    held.release(); // idempotent
    // A dead pid's lock (999999) is taken over, once.
    writeFileSync(join(deviceDir(configDir), "registry.lock"), "999999");
    const taken = acquireRegistryLock(configDir);
    expect(readFileSync(taken.path, "utf8")).toBe(String(process.pid));
    taken.release();
    // And an add still works afterwards (the lock is not left behind).
    expect(addDevice(configDir, { publicKey: key(2), name: "iPhone" }).ok).toBe(true);
    expect(readFileSync(registryFile(configDir), "utf8")).toContain("iPhone");
  });

  test("removing a device drops its entry AND its last-seen mark", () => {
    const configDir = scratch();
    const added = addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 1 });
    if (!added.ok) throw new Error(added.reason);
    touchSeen(configDir, added.device.id, 5_000);
    expect(readSeen(configDir).get(added.device.id)).toBe(5_000);
    const removed = removeDevices(configDir, [added.device.id]);
    if (!removed.ok) throw new Error(removed.reason);
    expect(removed.removed.map((d) => d.name)).toEqual(["iPhone"]);
    expect(readSeen(configDir).get(added.device.id)).toBeUndefined();
    const read = readRegistry(configDir);
    if (!read.ok) throw new Error(read.reason);
    expect(read.registry.devices).toEqual([]);
  });

  test("removing an unknown id is a no-op success", () => {
    const configDir = scratch();
    addDevice(configDir, { publicKey: key(2), name: "iPhone", now: 1 });
    const removed = removeDevices(configDir, ["0".repeat(DEVICE_ID_HEX)]);
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(removed.removed).toEqual([]);
  });

  test("last seen is an mtime, so two daemons never edit one file", () => {
    const configDir = scratch();
    expect(touchSeen(configDir, deviceIdOf(key(2)), 1_000)).toBe(true);
    expect(readSeen(configDir).get(deviceIdOf(key(2)))).toBe(1_000);
    expect(touchSeen(configDir, deviceIdOf(key(2)), 9_000)).toBe(true);
    expect(readSeen(configDir).get(deviceIdOf(key(2)))).toBe(9_000);
    // A name that is not an id is refused rather than creating junk.
    expect(touchSeen(configDir, "../../etc/passwd")).toBe(false);
  });
});

describe("pairing windows", () => {
  const open = (configDir: string, over: { now?: number; pid?: number; code?: string } = {}) => {
    const result = openPairing(configDir, {
      project: TEST_PROJECT,
      code: over.code ?? CODE,
      now: over.now ?? 1_000,
      pid: over.pid ?? process.pid,
    });
    if (!result.ok) throw new Error(result.reason);
    return result.session;
  };

  test("the code is stored only as its digest", () => {
    const configDir = scratch();
    createIdentity(configDir);
    const session = open(configDir);
    const raw = readFileSync(join(deviceDir(configDir), "pairing", `${session.sid}.json`), "utf8");
    expect(raw).not.toContain(CODE);
    expect(raw).toContain(pairingCodeHash(CODE));
    expect(session.codeHash).toBe(pairingCodeHash(CODE));
  });

  test("finds a live window by code and not by a wrong one", () => {
    const configDir = scratch();
    createIdentity(configDir);
    const session = open(configDir, { now: 1_000 });
    expect(findPairing(configDir, { project: TEST_PROJECT.key, code: CODE, now: 1_500 })?.sid).toBe(
      session.sid,
    );
    expect(
      findPairing(configDir, { project: TEST_PROJECT.key, code: OTHER_CODE, now: 1_500 }),
    ).toBeUndefined();
    // A lower-case paste still finds it (codes normalize).
    expect(
      findPairing(configDir, { project: TEST_PROJECT.key, code: CODE.toLowerCase(), now: 1_500 })
        ?.sid,
    ).toBe(session.sid);
  });

  test("an expired window is not found, and is swept", () => {
    const configDir = scratch();
    createIdentity(configDir);
    open(configDir, { now: 1_000 });
    const later = 1_000 + PAIRING_TTL_MS + 1;
    expect(
      findPairing(configDir, { project: TEST_PROJECT.key, code: CODE, now: later }),
    ).toBeUndefined();
    expect(sweepPairings(configDir, { now: later })).toBe(0);
  });

  test("a window whose `pair` died is not found", () => {
    // F2: a crashed `pair` cannot answer the human, so its window must not
    // admit anyone.
    const configDir = scratch();
    createIdentity(configDir);
    open(configDir, { now: 1_000, pid: 999_999 });
    expect(
      findPairing(configDir, {
        project: TEST_PROJECT.key,
        code: CODE,
        now: 1_500,
        alive: () => false,
      }),
    ).toBeUndefined();
    expect(
      findPairing(configDir, { project: TEST_PROJECT.key, code: CODE, now: 1_500 }),
    ).toBeUndefined();
  });

  test("a claim is exclusive: the second one sees `used`", () => {
    // Mutation: drop `wx` (or pre-check existence) → two phones, one window,
    // the second silently overwriting what the human is about to approve.
    const configDir = scratch();
    const identity = createIdentity(configDir, 1);
    const session = open(configDir, { now: 1_000 });
    const first = claimPairing(configDir, {
      project: TEST_PROJECT.key,
      sid: session.sid,
      deviceKey: key(2),
      name: "iPhone",
      now: 1_100,
    });
    if (!first.ok) throw new Error(first.reason);
    expect(first.claim.name).toBe("iPhone");
    expect(first.claim.sas).toMatch(/^\d{6}$/);
    const again = claimPairing(configDir, {
      project: TEST_PROJECT.key,
      sid: session.sid,
      deviceKey: key(3),
      name: "Pixel",
      now: 1_200,
    });
    expect(again).toEqual({ ok: false, reason: "used" });
    // The FIRST claim stands, and its key is what the registry will get.
    const read = readClaim(configDir, session.sid);
    expect([...(read?.publicKey ?? [])]).toEqual([...key(2)]);
    expect([...(read?.publicKey ?? [])]).not.toEqual([...identity.publicKey]);
  });

  test("a claim on an expired or dead window is refused", () => {
    const configDir = scratch();
    createIdentity(configDir);
    const expired = open(configDir, { now: 1_000 });
    const later = 1_000 + PAIRING_TTL_MS + 1;
    expect(
      claimPairing(configDir, {
        project: TEST_PROJECT.key,
        sid: expired.sid,
        deviceKey: key(2),
        name: "iPhone",
        now: later,
      }),
    ).toEqual({ ok: false, reason: "gone" });
    const dead = open(configDir, { now: later, pid: 999_999 });
    expect(
      claimPairing(configDir, {
        project: TEST_PROJECT.key,
        sid: dead.sid,
        deviceKey: key(2),
        name: "iPhone",
        now: later + 1,
        alive: () => false,
      }),
    ).toEqual({ ok: false, reason: "gone" });
  });

  test("the decision reads back only once written", () => {
    const configDir = scratch();
    createIdentity(configDir);
    const session = open(configDir);
    expect(readPairingDecision(configDir, session.sid)).toBeUndefined();
    expect(writePairingDecision(configDir, session.sid, false)).toEqual({ ok: true });
    expect(readPairingDecision(configDir, session.sid)).toBe(false);
    writePairingDecision(configDir, session.sid, true);
    expect(readPairingDecision(configDir, session.sid)).toBe(true);
  });

  test("closing a window removes the session, the claim and the decision", () => {
    const configDir = scratch();
    createIdentity(configDir);
    const session = open(configDir);
    claimPairing(configDir, {
      project: TEST_PROJECT.key,
      sid: session.sid,
      deviceKey: key(2),
      name: "iPhone",
    });
    writePairingDecision(configDir, session.sid, true);
    closePairing(configDir, session.sid);
    expect(findPairing(configDir, { project: TEST_PROJECT.key, code: CODE })).toBeUndefined();
    expect(readClaim(configDir, session.sid)).toBeUndefined();
    expect(readPairingDecision(configDir, session.sid)).toBeUndefined();
  });

  test("a fresh window sweeps what a killed `pair` left behind", () => {
    const configDir = scratch();
    createIdentity(configDir);
    const stale = open(configDir, { now: 1_000, pid: 999_999 });
    open(configDir, { code: OTHER_CODE, now: 2_000 });
    const names = readdirSync(join(deviceDir(configDir), "pairing"));
    expect(names).not.toContain(`${stale.sid}.json`);
    expect(names.filter((n) => n.endsWith(".json"))).toHaveLength(1);
    expect(sweepPairings(configDir, { now: 2_000 })).toBe(0);
  });
});

describe("hasLivePairing (what backs `authorize`: a pure read)", () => {
  test("finds a live window without the code, and nothing when none is usable", () => {
    const configDir = scratch();
    createIdentity(configDir);
    expect(hasLivePairing(configDir, { project: TEST_PROJECT.key, now: 1_000 })).toBeUndefined();
    const session = openPairing(configDir, {
      project: TEST_PROJECT,
      code: CODE,
      now: 1_000,
      pid: process.pid,
    });
    if (!session.ok) throw new Error(session.reason);
    expect(hasLivePairing(configDir, { project: TEST_PROJECT.key, now: 1_100 })?.sid).toBe(
      session.session.sid,
    );
    // Expired: not live (an expired window never admits an unknown key).
    expect(
      hasLivePairing(configDir, { project: TEST_PROJECT.key, now: 1_000 + 6 * 60 * 1000 }),
    ).toBeUndefined();
    // Its owner died (F2): not live either.
    expect(
      hasLivePairing(configDir, { project: TEST_PROJECT.key, now: 1_100, alive: () => false }),
    ).toBeUndefined();
  });

  test("is SIDE-EFFECT FREE: it never sweeps, closes or throws (P2)", () => {
    // The property `authorize` stands on: it runs on every replayed Noise
    // message 1, so it may not write. Mutation: delegate to `findPairing`
    // (which sweeps dead windows and throws on a malformed code) -> red.
    //
    // NOTHING LIVE here on purpose: with a live window in the dir, the read
    // returns on it before it ever reaches a dead one, and readdir order would
    // decide whether the sweep mutation is visible at all.
    const configDir = scratch();
    createIdentity(configDir);
    const dir = join(deviceDir(configDir), "pairing");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const deadSid = "b".repeat(32);
    const deadPath = join(dir, `${deadSid}.json`);
    writeFileSync(
      deadPath,
      JSON.stringify({
        v: 1,
        sid: deadSid,
        codeHash: pairingCodeHash(CODE),
        expiresAt: 9_999_999,
        pid: 999_999,
      }),
    );
    // A malformed code in a well-formed window: `pairingCodeHash` throws on it.
    const badSid = "c".repeat(32);
    const badPath = join(dir, `${badSid}.json`);
    writeFileSync(
      badPath,
      JSON.stringify({
        v: 1,
        sid: badSid,
        codeHash: "not-a-digest",
        expiresAt: 9_999_999,
        pid: process.pid,
      }),
    );
    const before = readFileSync(deadPath, "utf8");

    expect(
      hasLivePairing(configDir, { project: TEST_PROJECT.key, now: 1_100, alive: () => false }),
    ).toBeUndefined();
    expect(hasLivePairing(configDir, { project: TEST_PROJECT.key, now: 1_100 })).toBeUndefined();
    // Nothing was swept, closed or rewritten.
    expect(readFileSync(deadPath, "utf8")).toBe(before);
    expect(existsSync(badPath)).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(2);
  });
});

describe("daemon records", () => {
  test("round-trip a live record and skip a dead pid's", () => {
    const configDir = scratch();
    expect(
      writeDaemonRecord(configDir, {
        pid: process.pid,
        host: "0.0.0.0",
        port: 4001,
        tls: false,
        cwd: "/work",
        startedAt: 7,
      }),
    ).toEqual({ ok: true });
    const live = readDaemonRecords(configDir);
    expect(live.map((r) => r.port)).toEqual([4001]);
    // A record whose pid is dead is ignored, never returned as an address.
    writeDaemonRecord(configDir, {
      pid: 999_999,
      host: "0.0.0.0",
      port: 4002,
      tls: true,
      cwd: "/work",
      startedAt: 8,
    });
    expect(readDaemonRecords(configDir).map((r) => r.port)).toEqual([4001]);
    expect(readDaemonRecords(configDir, { alive: () => true }).map((r) => r.port)).toEqual([
      4001, 4002,
    ]);
    // A malformed record is skipped, not fatal.
    writeFileSync(join(configDir, "daemons", `${process.pid + 1}.json`), "{}");
    expect(readDaemonRecords(configDir, { alive: () => true }).length).toBe(2);
  });
});

// docs/feat/sibling-discovery.md: the record's liveness is a HEARTBEAT (mtime),
// not just a pid answer — a crashed `serve` whose pid was reused by any process
// is a phantom sibling otherwise (Repro 3). Mutations: ignore the mtime → the
// pid-reuse test fails; never delete a dead pid's record → the sweep test fails.
describe("daemon records: liveness, sweep, addresses (sibling discovery)", () => {
  const record = (over: Partial<Parameters<typeof writeDaemonRecord>[1]> = {}) => ({
    pid: process.pid,
    host: "0.0.0.0",
    port: 4001,
    tls: false,
    cwd: "/work",
    startedAt: 7,
    ...over,
  });

  test("a live pid with an OLD mtime is excluded once freshness is demanded (Repro 3)", () => {
    const configDir = scratch();
    writeDaemonRecord(configDir, record());
    const path = join(configDir, "daemons", `${process.pid}.json`);
    // A crashed serve whose pid is reused: the file is old, the pid answers.
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    // Absent option = today's behaviour (the pid is the whole liveness signal).
    expect(readDaemonRecords(configDir).map((r) => r.port)).toEqual([4001]);
    expect(readDaemonRecords(configDir, { freshWithinMs: 30_000 }).map((r) => r.port)).toEqual([]);
    // And with the clock moved forward, not by rewriting the file.
    expect(
      readDaemonRecords(configDir, { freshWithinMs: 30_000, now: Date.now() + 60_000 }).map(
        (r) => r.port,
      ),
    ).toEqual([]);
    expect(
      readDaemonRecords(configDir, { freshWithinMs: 5 * 60_000, now: Date.now() + 60_000 }).map(
        (r) => r.port,
      ),
    ).toEqual([4001]);
  });

  test("touchDaemonRecord refreshes the mtime a heartbeat relies on", () => {
    const configDir = scratch();
    writeDaemonRecord(configDir, record());
    const path = join(configDir, "daemons", `${process.pid}.json`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(path, old, old);
    expect(readDaemonRecords(configDir, { freshWithinMs: 30_000 })).toHaveLength(0);
    expect(touchDaemonRecord(configDir, process.pid)).toBe(true);
    expect(readDaemonRecords(configDir, { freshWithinMs: 30_000 }).map((r) => r.port)).toEqual([
      4001,
    ]);
    // Touching a record that is gone is `false`, never a create: a removed
    // record must not be resurrected by a heartbeat racing the stop.
    expect(touchDaemonRecord(configDir, 999_999)).toBe(false);
    expect(readDaemonRecords(configDir, { alive: () => true })).toHaveLength(1);
  });

  test("sweepDeadDaemonRecords deletes a dead pid's record and keeps a live-but-stale one", () => {
    const configDir = scratch();
    writeDaemonRecord(configDir, record());
    writeDaemonRecord(configDir, record({ pid: 999_998, port: 4002 }));
    const stalePath = join(configDir, "daemons", `${process.pid}.json`);
    const old = new Date(Date.now() - 60_000);
    utimesSync(stalePath, old, old);
    const alive = (pid: number): boolean => pid === process.pid;
    expect(sweepDeadDaemonRecords(configDir, { alive })).toBe(1);
    expect(existsSync(join(configDir, "daemons", "999998.json"))).toBe(false);
    // A live-but-stale record may be a slow sibling: ignored, NEVER deleted.
    expect(existsSync(stalePath)).toBe(true);
  });

  // docs/fix/daemon-records-stale.md D3: a stale record whose pid is held by a
  // process that STARTED after the record was written cannot be its writer.
  describe("the reuse proof (stale record, live pid)", () => {
    const STARTED = 1_700_000_000_000;
    const NOW = STARTED + 3_600_000;
    const alive = (): boolean => true;

    function plant(mtime: number = STARTED) {
      const configDir = scratch();
      writeDaemonRecord(configDir, record({ startedAt: STARTED }));
      const path = join(configDir, "daemons", `${process.pid}.json`);
      utimesSync(path, new Date(mtime), new Date(mtime));
      return { configDir, path };
    }
    const sweep = (configDir: string, startedAtOf: (pid: number) => number | undefined) =>
      sweepDeadDaemonRecords(configDir, { alive, freshWithinMs: 30_000, now: NOW, startedAtOf });

    test("(a) a dead pid's record is removed, whatever its age", () => {
      const { configDir, path } = plant(NOW);
      const options = { alive: () => false, freshWithinMs: 30_000, now: NOW };
      expect(sweepDeadDaemonRecords(configDir, options)).toBe(1);
      expect(existsSync(path)).toBe(false);
    });

    test("(b) a fresh record is kept and its process is never even asked about", () => {
      const { configDir, path } = plant(NOW - 5_000);
      let asked = 0;
      const removed = sweep(configDir, () => {
        asked++;
        return NOW;
      });
      expect(removed).toBe(0);
      expect(asked).toBe(0);
      expect(existsSync(path)).toBe(true);
    });

    test("(c) stale, and the holder started 61 s after the record: removed", () => {
      const { configDir, path } = plant();
      expect(sweep(configDir, () => STARTED + 61_000)).toBe(1);
      expect(existsSync(path)).toBe(false);
    });

    test("(d) stale, and the holder started 59 s after: inside the tolerance, kept", () => {
      const { configDir, path } = plant();
      expect(sweep(configDir, () => STARTED + 59_000)).toBe(0);
      expect(existsSync(path)).toBe(true);
    });

    test("(e) an unknown start time keeps the record", () => {
      const { configDir, path } = plant();
      expect(sweep(configDir, () => undefined)).toBe(0);
      expect(existsSync(path)).toBe(true);
    });

    test("(f) a record rewritten while the proof ran is kept (TOCTOU)", () => {
      const { configDir, path } = plant();
      const removed = sweep(configDir, () => {
        // The new holder of the pid is a serve writing ITS record right now.
        writeDaemonRecord(configDir, record({ startedAt: NOW, port: 4009 }));
        return STARTED + 61_000;
      });
      expect(removed).toBe(0);
      expect(readDaemonRecords(configDir, { alive }).map((r) => r.port)).toEqual([4009]);
      expect(existsSync(path)).toBe(true);
    });

    test("(f2) a record merely TOUCHED while the proof ran is kept (a late heartbeat)", () => {
      const { configDir, path } = plant();
      const removed = sweep(configDir, () => {
        touchDaemonRecord(configDir, process.pid);
        return STARTED + 61_000;
      });
      expect(removed).toBe(0);
      expect(existsSync(path)).toBe(true);
    });

    test("(g) a live pid with a malformed or unknown-version record is kept", () => {
      const valid = record({ startedAt: STARTED });
      for (const body of [
        "not json",
        "{}",
        JSON.stringify({ ...valid, v: 99 }),
        // A v1 record naming ANOTHER pid than its file name proves nothing.
        JSON.stringify({ ...valid, v: 1, pid: process.pid + 1 }),
      ]) {
        const { configDir, path } = plant();
        writeFileSync(path, body);
        utimesSync(path, new Date(STARTED), new Date(STARTED));
        expect(sweep(configDir, () => NOW)).toBe(0);
        expect(existsSync(path)).toBe(true);
      }
    });

    test("(h) without `freshWithinMs` a live pid's record is always kept", () => {
      const { configDir, path } = plant();
      const options = { alive, now: NOW, startedAtOf: () => NOW };
      expect(sweepDeadDaemonRecords(configDir, options)).toBe(0);
      expect(existsSync(path)).toBe(true);
    });
  });

  test("`addresses` round-trips, and invalid ones are refused (never truncated silently)", () => {
    const configDir = scratch();
    const addresses = ["ws://192.168.1.5:4001/e2e", "wss://mac.tailnet.ts.net/e2e"];
    expect(writeDaemonRecord(configDir, record({ addresses }))).toEqual({ ok: true });
    expect(readDaemonRecords(configDir)[0]?.addresses).toEqual(addresses);
    // A record WITHOUT the field still reads (an older writer): no `addresses`.
    const older = scratch();
    writeDaemonRecord(older, record());
    expect(readDaemonRecords(older)[0]?.addresses).toBeUndefined();
    // Invalid values are dropped one by one, not refused with the whole record:
    // a hand-edited record must not make its daemon invisible.
    const mixed = scratch();
    writeDaemonRecord(mixed, record({ addresses: [...addresses, "http://nope/e2e"] }));
    expect(readDaemonRecords(mixed)[0]?.addresses).toEqual(addresses);
    const capped = scratch();
    writeDaemonRecord(
      capped,
      record({ addresses: Array.from({ length: 12 }, (_, i) => `ws://10.0.0.${i}:4001/e2e`) }),
    );
    expect(readDaemonRecords(capped)[0]?.addresses?.length).toBe(MAX_PAIRING_ADDRESSES);
  });
});

describe("process start time (`ps -o etime=`)", () => {
  /** The OS's elapsed seconds for `pid`, independently of `processStartedAt`. */
  function psEtimeSeconds(pid: number): number | undefined {
    const out = Bun.spawnSync(["ps", "-o", "etime=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C" },
    }).stdout.toString();
    return parseEtime(out);
  }

  test("parseEtime reads `[[dd-]hh:]mm:ss` and nothing else", () => {
    expect(parseEtime("05:31")).toBe(331);
    expect(parseEtime("1:02:03")).toBe(3723);
    expect(parseEtime("2-01:02:03")).toBe(176_523);
    expect(parseEtime("  00:07\n")).toBe(7);
    for (const junk of ["", "abc", "1:2:3:4", "07", "2-05:31", "-1:00"]) {
      expect(parseEtime(junk)).toBeUndefined();
    }
  });

  test("processStartedAt places our own start, and is unknown for a gone pid", async () => {
    const now = Date.now();
    const started = processStartedAt(process.pid, now);
    // Ground truth is the OS's own elapsed time for our PID, never
    // `process.uptime()`: under `bun test --parallel` the two disagree (the gate
    // read 19 s apart — a worker's notion of "up"), and only `ps` answers for
    // the process a pid names.
    const elapsed = psEtimeSeconds(process.pid);
    expect(elapsed).toBeDefined();
    // Whole seconds from `ps`; nowhere near a timezone's offset.
    expect(Math.abs((started ?? 0) - (now - (elapsed ?? 0) * 1000))).toBeLessThan(2_000);
    // The answer is `now` MINUS an elapsed time, never a local-clock reading of
    // `lstart` (measured an hour off under another timezone,
    // docs/fix/daemon-records-stale.md): moving `now` an hour moves it an hour.
    // Two `ps` reads can straddle a second boundary.
    const later = processStartedAt(process.pid, now + 3_600_000);
    expect(Math.abs((later ?? 0) - (started ?? 0) - 3_600_000)).toBeLessThan(2_000);
    // A long-lived pid pins the UNIT: with a seconds-for-milliseconds mistake
    // the answer for a machine up for days is off by days, not by our own
    // process's few seconds.
    const oldEtime = psEtimeSeconds(1);
    expect(oldEtime).toBeDefined();
    expect(Math.abs((processStartedAt(1, now) ?? 0) - (now - (oldEtime ?? 0) * 1000))).toBeLessThan(
      2_000,
    );
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    expect(processStartedAt(gone.pid)).toBeUndefined();
  });
});

// Cleanup: a scratch dir per test keeps failures diagnosable; the suite removes them at the end.
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
