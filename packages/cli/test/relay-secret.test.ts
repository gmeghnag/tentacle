/**
 * `relay.json` — the daemon's mobile-relay identity on disk
 * (docs/feat/mobile-relay.md R5a, Design §1).
 *
 * Each block names the mutation it kills:
 * - created 0600, once, with the same bytes on a second read (mutation: always
 *   mint a new secret → every restart changes the id and every QR goes stale);
 * - an unknown `v` turns the relay OFF and leaves the file BYTE-IDENTICAL
 *   (mutation: rewrite it as v1 → a newer tentacle's file is silently downgraded,
 *   AGENTS §7);
 * - a corrupt/unreadable file is refused, never "repaired" or treated as missing
 *   (mutation: fall back to creating one → a permission problem mints a new id).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_SECRET_BYTES, decodeBase64Url, encodeBase64Url } from "@tentacle/protocol";
import { relayIdOf } from "@tentacle/transport/relay-id";
import {
  RELAY_SECRET_FILE,
  RELAY_SECRET_MODE,
  readRelaySecret,
  relaySecretPath,
} from "../src/relay-secret.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): string {
  const dir = mkdtempSync(join(tmpdir(), "relay-secret-"));
  dirs.push(dir);
  const storeDir = join(dir, "daemon", "proj");
  mkdirSync(storeDir, { recursive: true });
  return storeDir;
}

const body = (secret: Uint8Array, v = 1): string =>
  `${JSON.stringify({ v, secret: encodeBase64Url(secret) }, null, 2)}\n`;

describe("relay.json: created once, reused afterwards", () => {
  test("the first read creates it at 0600 with a 32-byte secret", () => {
    const dir = store();
    const read = readRelaySecret(dir);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.created).toBe(true);
    expect(read.path).toBe(relaySecretPath(dir));
    expect(read.secret.length).toBe(RELAY_SECRET_BYTES);
    // The MODE is the point: this file is a credential (an address one, but a
    // credential). 0600 on the file, never 0644.
    expect(statSync(read.path).mode & 0o777).toBe(RELAY_SECRET_MODE);
    const onDisk = JSON.parse(readFileSync(read.path, "utf8"));
    expect(onDisk.v).toBe(1);
    expect(onDisk.secret).toBe(encodeBase64Url(read.secret));
  });

  test("a second read REUSES the same secret — the id survives a restart (F15)", () => {
    const dir = store();
    const first = readRelaySecret(dir);
    const second = readRelaySecret(dir);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.created).toBe(false);
    expect(encodeBase64Url(second.secret)).toBe(encodeBase64Url(first.secret));
    // The address a phone holds is a function of this value: it must not move.
    expect(relayIdOf(second.secret)).toBe(relayIdOf(first.secret));
  });

  test("a pinned random makes the bytes predictable (the seam a test needs)", () => {
    const dir = store();
    const read = readRelaySecret(dir, { random: () => new Uint8Array(32).fill(9) });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(encodeBase64Url(read.secret)).toBe(encodeBase64Url(new Uint8Array(32).fill(9)));
  });

  test("a wrong-sized `random` is a programming error, never a short secret", () => {
    expect(() => readRelaySecret(store(), { random: () => new Uint8Array(16) })).toThrow(
      /expected 32 bytes/,
    );
  });
});

describe("relay.json: an unknown version is refused and left untouched (AGENTS §7)", () => {
  test("v:2 → unsupported-version, and the file's BYTES do not change", () => {
    const dir = store();
    const secret = new Uint8Array(32).fill(3);
    const path = relaySecretPath(dir);
    // Write it where the daemon expects it.
    writeFileSync(path, body(secret, 2), { flag: "w" });
    const before = readFileSync(path);
    const read = readRelaySecret(dir);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.reason).toBe("unsupported-version");
    expect(read.detail).toContain("version 2");
    // Not rewritten, not deleted, not "upgraded": the newer tentacle's id is a
    // newer tentacle's business.
    expect(readFileSync(path)).toEqual(before);
  });

  test("a missing `v` is corrupt, not version 0", () => {
    const dir = store();
    const path = relaySecretPath(dir);
    writeFileSync(path, `${JSON.stringify({ secret: encodeBase64Url(new Uint8Array(32)) })}\n`);
    const before = readFileSync(path);
    const read = readRelaySecret(dir);
    expect(read.ok ? "ok" : read.reason).toBe("corrupt");
    expect(readFileSync(path)).toEqual(before);
  });
});

describe("relay.json: a bad file is refused, never repaired", () => {
  test("not JSON → corrupt, file untouched", () => {
    const dir = store();
    const path = relaySecretPath(dir);
    writeFileSync(path, "{ nope");
    const read = readRelaySecret(dir);
    expect(read.ok ? "ok" : read.reason).toBe("corrupt");
    expect(readFileSync(path, "utf8")).toBe("{ nope");
  });

  test("a secret that is not 32 bytes' worth of base64url → corrupt, untouched", () => {
    const dir = store();
    const path = relaySecretPath(dir);
    writeFileSync(
      path,
      `${JSON.stringify({ v: 1, secret: encodeBase64Url(new Uint8Array(16)) })}\n`,
    );
    const before = readFileSync(path);
    const read = readRelaySecret(dir);
    expect(read.ok ? "ok" : read.reason).toBe("corrupt");
    expect(readFileSync(path)).toEqual(before);
  });

  test("an unreadable file is `unreadable`, NOT a reason to mint a new id", () => {
    const dir = store();
    const path = relaySecretPath(dir);
    writeFileSync(path, body(new Uint8Array(32).fill(1)));
    chmodSync(path, 0o000);
    const read = readRelaySecret(dir);
    // Root can read anything, so a CI run as root would legitimately succeed:
    // assert the property, not the privilege.
    if (read.ok) {
      expect(read.created).toBe(false);
    } else {
      expect(read.reason).toBe("unreadable");
      expect(read.detail).toContain(path);
    }
    chmodSync(path, 0o600);
  });

  test('a DIRECTORY where the file should be mints nothing (EISDIR, never "missing")', () => {
    // The `ENOENT`-only branch is what makes this a real test: a directory gives
    // `EISDIR` from `readFileSync`, and a `tryRead` that treated ANY error as
    // "missing" would go on to mint a new secret (and fail to write it, or worse,
    // report a fresh id).
    const dir = store();
    mkdirSync(relaySecretPath(dir), { recursive: true });
    const read = readRelaySecret(dir);
    expect(read.ok ? "ok" : read.reason).toBe("unreadable");
    if (!read.ok) {
      expect(read.detail).toContain("cannot read");
    }
  });

  test("the file's name is `relay.json` inside the store dir (one id per project)", () => {
    expect(RELAY_SECRET_FILE).toBe("relay.json");
    expect(relaySecretPath("/x/daemon/proj")).toBe("/x/daemon/proj/relay.json");
  });

  test("the secret round-trips through the file's own encoding", () => {
    const dir = store();
    const read = readRelaySecret(dir);
    if (!read.ok) return;
    const text = JSON.parse(readFileSync(read.path, "utf8")).secret as string;
    expect(decodeBase64Url(text)?.length).toBe(RELAY_SECRET_BYTES);
  });
});
