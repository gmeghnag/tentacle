/**
 * The push registration store (docs/feat/mobile-push.md Design 5, P5).
 *
 * One property per block, each naming the mutation that would fake it:
 * - a record is written 0600 through a temp file, and reads back (mutation: plain
 *   `writeFileSync` on the final path → a crash leaves half a token);
 * - an unknown `v`, or a bad field, is SKIPPED with the bytes untouched
 *   (mutation: accept any `v`, or "repair" by rewriting → a newer daemon's record
 *   is destroyed by an older build);
 * - a delete is COMPARE-and-delete (mutation: unconditional `rm` → a phone that
 *   just re-registered is silently muted);
 * - `removeDevices` drops the file, so a revoked device is never pushed to;
 * - `devices reset` empties `push/`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_DIR,
  addDevice,
  clearPushRegistrations,
  deletePushRegistration,
  deviceIdOf,
  loadOrCreateIdentity,
  pushDir,
  pushPathOf,
  readPushRegistration,
  readPushRegistrations,
  removeDevices,
  writePushRegistration,
} from "@tentacle/daemon";

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "push-store-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);
const TOKEN = "a".repeat(64);
const TOKEN_B = "b".repeat(64);
/** A base64url 32-byte key, as the app sends it. */
const pushKey = (fill: number): string => Buffer.from(key(fill)).toString("base64url");
const DEVICE = `${"0".repeat(15)}1`;

/** Register one device, asserting the write itself succeeded (so a failure is never silent). */
const register = (
  configDir: string,
  deviceId: string,
  token: string,
  at = 1_000,
  env = "sandbox",
  devicePushKey = pushKey(3),
): void => {
  const written = writePushRegistration(configDir, {
    deviceId,
    token,
    env,
    key: devicePushKey,
    registeredAt: at,
  });
  if (!written.ok) throw new Error(`${written.reason} (${written.path})`);
};

/** A paired device (so `removeDevices` has an entry to revoke). */
const pair = (configDir: string, fill: number): string => {
  loadOrCreateIdentity(configDir, { name: "gabriel-laptop" });
  const added = addDevice(configDir, { publicKey: key(fill), name: `phone-${fill}`, now: 1 });
  if (!added.ok) throw new Error(added.reason);
  return deviceIdOf(key(fill));
};

describe("writing and reading a registration", () => {
  test("a record round-trips, 0600, under devices/push/<id>.json", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN, 1_700_000_000_000);
    const path = pushPathOf(configDir, DEVICE);
    expect(path).toBe(join(pushDir(configDir), `${DEVICE}.json`));
    expect(path).toBe(join(configDir, "devices", PUSH_DIR, `${DEVICE}.json`));
    expect(existsSync(path)).toBe(true);
    // 0600: a token is a bearer credential for a phone's lock screen.
    expect(statMode(path)).toBe(0o600);
    const read = readPushRegistration(configDir, DEVICE);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.registration.token).toBe(TOKEN);
    expect(read.registration.env).toBe("sandbox");
    expect(read.registration.registeredAt).toBe(1_700_000_000_000);
    expect(read.registration.key).toBe(pushKey(3));
    // No temp file survives a successful write.
    expect(readdirSync(pushDir(configDir)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("a re-registration REPLACES the file (tmp + rename, so no reader sees half)", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN, 1_000);
    register(configDir, DEVICE, TOKEN_B, 2_000, "production", pushKey(9));
    const read = readPushRegistration(configDir, DEVICE);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.registration.token).toBe(TOKEN_B);
    expect(read.registration.env).toBe("production");
    expect(read.registration.key).toBe(pushKey(9));
    expect(readdirSync(pushDir(configDir))).toEqual([`${DEVICE}.json`]);
  });

  test("the write goes through the wire's own schema, so a malformed one writes NOTHING", () => {
    const configDir = newDir();
    // The same three refusals the RPC makes (F26): a bad token, env and key.
    expect(
      writePushRegistration(configDir, {
        deviceId: DEVICE,
        token: "zz",
        env: "sandbox",
        key: pushKey(1),
        registeredAt: 1,
      }).ok,
    ).toBe(false);
    expect(
      writePushRegistration(configDir, {
        deviceId: DEVICE,
        token: TOKEN,
        env: "staging",
        key: pushKey(1),
        registeredAt: 1,
      }).ok,
    ).toBe(false);
    expect(
      writePushRegistration(configDir, {
        deviceId: DEVICE,
        token: TOKEN,
        env: "sandbox",
        key: "short",
        registeredAt: 1,
      }).ok,
    ).toBe(false);
    // And a path-traversing "device id" never becomes a file outside `push/`.
    expect(
      writePushRegistration(configDir, {
        deviceId: "../../etc/passwd",
        token: TOKEN,
        env: "sandbox",
        key: pushKey(1),
        registeredAt: 1,
      }).ok,
    ).toBe(false);
    expect(existsSync(pushDir(configDir))).toBe(false);
  });

  test("a device that never registered is MISSING, not an error (the ordinary case)", () => {
    const configDir = newDir();
    const read = readPushRegistration(configDir, DEVICE);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.missing).toBe(true);
    expect(readPushRegistrations(configDir).registrations.size).toBe(0);
  });
});

describe("a record this build cannot read", () => {
  const unusable = (configDir: string, deviceId: string, body: string): string => {
    mkdirSync(pushDir(configDir), { recursive: true, mode: 0o700 });
    const path = pushPathOf(configDir, deviceId);
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  };

  test("an unknown `v` is SKIPPED, and its bytes are untouched (mutation: accept any v)", () => {
    const configDir = newDir();
    const body = JSON.stringify({
      v: 99,
      token: TOKEN,
      env: "sandbox",
      key: pushKey(1),
      registeredAt: 5,
    });
    const path = unusable(configDir, DEVICE, body);
    const read = readPushRegistration(configDir, DEVICE);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.missing).toBeUndefined();
    // Never rewritten, never deleted: a newer build's record is not ours to ruin.
    expect(readFileSync(path, "utf8")).toBe(body);
    // The directory read reports it once, and yields no registration for it.
    const all = readPushRegistrations(configDir);
    expect(all.registrations.size).toBe(0);
    expect(all.skipped.map((s) => s.path)).toEqual([path]);
  });

  test("a bad field (a token the wire refuses) is skipped too, bytes untouched", () => {
    const configDir = newDir();
    const body = JSON.stringify({
      v: 1,
      token: "not-a-token",
      env: "sandbox",
      key: pushKey(1),
      registeredAt: 5,
    });
    const path = unusable(configDir, DEVICE, body);
    expect(readPushRegistration(configDir, DEVICE).ok).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  test("malformed JSON and a world-readable file are both survivable", () => {
    const configDir = newDir();
    const path = unusable(configDir, DEVICE, "{");
    chmodSync(path, 0o644);
    const all = readPushRegistrations(configDir);
    expect(all.registrations.size).toBe(0);
    expect(all.skipped.length).toBe(1);
  });

  test("one bad file does not hide a good one (the directory keeps going)", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN);
    unusable(configDir, "1".repeat(16), JSON.stringify({ v: 7 }));
    const all = readPushRegistrations(configDir);
    expect([...all.registrations.keys()]).toEqual([DEVICE]);
    expect(all.skipped.length).toBe(1);
  });

  test("a non-record file in `push/` is ignored, not reported (a temp file mid-write)", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN);
    writeFileSync(join(pushDir(configDir), `${DEVICE}.json.123.tmp`), "{}");
    writeFileSync(join(pushDir(configDir), "README"), "hello");
    const all = readPushRegistrations(configDir);
    expect(all.registrations.size).toBe(1);
    expect(all.skipped).toEqual([]);
  });
});

describe("compare-and-delete", () => {
  test("deletes the file whose token is still the failed one", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN);
    expect(deletePushRegistration(configDir, DEVICE, TOKEN)).toBe("deleted");
    expect(existsSync(pushPathOf(configDir, DEVICE))).toBe(false);
    // A second `gone` for the same token is simply "absent", never a throw.
    expect(deletePushRegistration(configDir, DEVICE, TOKEN)).toBe("absent");
  });

  test("KEEPS a newer token (mutation: unconditional delete → a fixed phone goes mute)", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN, 1_000);
    // The phone re-registered between our send and APNs's `gone` (F11).
    register(configDir, DEVICE, TOKEN_B, 2_000);
    expect(deletePushRegistration(configDir, DEVICE, TOKEN)).toBe("kept-newer-token");
    const read = readPushRegistration(configDir, DEVICE);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.registration.token).toBe(TOKEN_B);
  });

  test("an unreadable record is not deleted out from under a human", () => {
    const configDir = newDir();
    mkdirSync(pushDir(configDir), { recursive: true, mode: 0o700 });
    const path = pushPathOf(configDir, DEVICE);
    writeFileSync(path, JSON.stringify({ v: 42 }), { mode: 0o600 });
    expect(deletePushRegistration(configDir, DEVICE, TOKEN)).toBe("unreadable");
    expect(existsSync(path)).toBe(true);
  });
});

describe("revoke and reset", () => {
  test("`removeDevices` drops the registration with the entry (F14)", () => {
    const configDir = newDir();
    const id = pair(configDir, 1);
    register(configDir, id, TOKEN);
    const removed = removeDevices(configDir, [id]);
    expect(removed.ok).toBe(true);
    expect(existsSync(pushPathOf(configDir, id))).toBe(false);
    expect(readPushRegistrations(configDir).registrations.size).toBe(0);
  });

  test("revoking one device leaves another's file alone", () => {
    const configDir = newDir();
    const one = pair(configDir, 1);
    const two = pair(configDir, 2);
    register(configDir, one, TOKEN);
    register(configDir, two, TOKEN_B);
    removeDevices(configDir, [one]);
    expect(readPushRegistrations(configDir).registrations.has(two)).toBe(true);
    expect(readPushRegistrations(configDir).registrations.size).toBe(1);
  });

  test("`clearPushRegistrations` empties the directory and says how many went (F13)", () => {
    const configDir = newDir();
    register(configDir, DEVICE, TOKEN);
    register(configDir, "1".repeat(16), TOKEN_B);
    expect(clearPushRegistrations(configDir)).toBe(2);
    expect(readdirSync(pushDir(configDir))).toEqual([]);
    // Idempotent: a machine that never registered has nothing to clear.
    expect(clearPushRegistrations(configDir)).toBe(0);
  });
});

/** The file mode's low bits (`0o600`): the one stat that matters for a credential. */
function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
