/**
 * The publisher key (docs/feat/session-apps-publish.md D2/F15): one Ed25519 key
 * per config dir, 0600 in a 0700 dir, created once even by racing creators, and
 * never replaced when unreadable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
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
import { decodeBase64Url } from "@tentacle/protocol";
import { loadOrCreateAppsKey, readAppsKey } from "../src/apps-key.ts";

const dirs: string[] = [];
const fresh = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "apps-key-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const mode = (path: string): number => statSync(path).mode & 0o777;

async function verifies(publicKey: string, message: Uint8Array, signature: Uint8Array) {
  const raw = decodeBase64Url(publicKey) as Uint8Array;
  const key = await crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, signature, message);
}

describe("the publisher key", () => {
  test("reading never creates one", async () => {
    const dir = fresh();
    const read = await readAppsKey(dir);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.missing).toBe(true);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("created 0600 in a 0700 dir, a 43-char public key that verifies, stable across loads", async () => {
    const dir = fresh();
    const made = await loadOrCreateAppsKey(dir);
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    expect(mode(join(dir, "apps"))).toBe(0o700);
    expect(mode(join(dir, "apps", "publisher.json"))).toBe(0o600);
    expect(readdirSync(join(dir, "apps"))).toEqual(["publisher.json"]);
    expect(made.key.publicKey).toHaveLength(43);
    const message = new TextEncoder().encode("tentacle-apps/1");
    expect(await verifies(made.key.publicKey, message, await made.key.sign(message))).toBe(true);
    const again = await loadOrCreateAppsKey(dir);
    expect(again.ok && again.key.publicKey).toBe(made.key.publicKey);
  });

  test("a loose file is tightened to 0600", async () => {
    const dir = fresh();
    await loadOrCreateAppsKey(dir);
    chmodSync(join(dir, "apps", "publisher.json"), 0o644);
    await loadOrCreateAppsKey(dir);
    expect(mode(join(dir, "apps", "publisher.json"))).toBe(0o600);
  });

  test("two racing creators end with ONE key", async () => {
    const dir = fresh();
    const all = await Promise.all([1, 2, 3, 4].map(() => loadOrCreateAppsKey(dir)));
    const keys = new Set(all.map((r) => (r.ok ? r.key.publicKey : "failed")));
    expect(keys.size).toBe(1);
    expect(keys.has("failed")).toBe(false);
    expect(readdirSync(join(dir, "apps"))).toEqual(["publisher.json"]);
  });

  for (const [name, text] of [
    ["garbage", "not json"],
    ["another shape", '{"kty":"OKP"}'],
    ["a broken key", '{"kty":"OKP","crv":"Ed25519","d":"AAAA","x":"AAAA"}'],
  ] as const) {
    test(`${name}: refused with its path, the file untouched`, async () => {
      const dir = fresh();
      mkdirSync(join(dir, "apps"), { recursive: true });
      const path = join(dir, "apps", "publisher.json");
      writeFileSync(path, text);
      for (const load of [readAppsKey, loadOrCreateAppsKey]) {
        const result = await load(dir);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.missing).toBeUndefined();
          expect(result.reason).toContain(path);
          expect(result.reason).toContain("remove");
        }
      }
      expect(readFileSync(path, "utf8")).toBe(text);
    });
  }
});
