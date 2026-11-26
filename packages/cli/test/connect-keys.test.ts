/**
 * The key stores, with a FAKE command runner: the real Keychain is never touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64Url } from "@tentacle/protocol";
import {
  type CommandRun,
  KEYCHAIN_SERVICE,
  SECURITY_BIN,
  defaultKeyStores,
  dropKey,
  fileKeyStore,
  keychainKeyStore,
  loadKey,
  spawnRun,
  storeKey,
} from "../src/connect-keys.ts";
import type { ComputerRecord } from "../src/connect-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "connect-keys-"));
  dirs.push(dir);
  return dir;
}

const ID = "ab".repeat(16);
const KEY = new Uint8Array(32).map((_, i) => i + 1);
const SECRET = encodeBase64Url(KEY);

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly stdin: string | undefined;
}

/** A fake `security`: items by account. `broken` makes the stdin write do nothing. */
function fakeSecurity(over: { broken?: boolean; locked?: boolean } = {}) {
  const items = new Map<string, string>();
  const calls: Call[] = [];
  const run: CommandRun = async (cmd, args, stdin) => {
    calls.push({ cmd, args: [...args], stdin });
    const account = args[args.indexOf("-a") + 1] ?? "";
    if (over.locked) return { code: 36, stdout: "" };
    if (args[0] === "-i") {
      const added = /^add-generic-password -U -s (\S+) -a (\S+) -w (\S+)\n$/.exec(stdin ?? "");
      if (added && added[1] === KEYCHAIN_SERVICE && !over.broken) {
        items.set(added[2] ?? "", added[3] ?? "");
      }
      // `security -i` may exit 0 whatever its command did.
      return { code: 0, stdout: "" };
    }
    if (args[0] === "find-generic-password") {
      const value = items.get(account);
      return value === undefined ? { code: 44, stdout: "" } : { code: 0, stdout: `${value}\n` };
    }
    if (args[0] === "delete-generic-password") {
      return { code: items.delete(account) ? 0 : 44, stdout: "" };
    }
    return { code: 1, stdout: "" };
  };
  return { run, calls, items };
}

function record(keyStore: "keychain" | "file"): ComputerRecord {
  return {
    v: 1,
    name: "app",
    id: ID,
    computer: "workstation",
    computerKey: encodeBase64Url(new Uint8Array(32).fill(7)),
    deviceId: "0123456789abcdef",
    addresses: ["ws://127.0.0.1:1/e2e"],
    keyStore,
  };
}

describe("keychain key store (D2)", () => {
  test("put, get and remove round-trip through `security`", async () => {
    const security = fakeSecurity();
    const store = keychainKeyStore(security.run);
    await store.put(ID, KEY);
    expect(security.items.get(ID)).toBe(SECRET);
    expect(await store.get(ID)).toEqual(KEY);
    await store.remove(ID);
    expect(await store.get(ID)).toBeUndefined();
    expect(security.calls.every((c) => c.cmd === SECURITY_BIN)).toBe(true);
  });

  test("the secret is in NO argv element of any call, only on stdin (§7)", async () => {
    const security = fakeSecurity();
    const store = keychainKeyStore(security.run);
    await store.put(ID, KEY);
    await store.get(ID);
    await store.remove(ID);
    const hex = Buffer.from(KEY).toString("hex");
    for (const call of security.calls) {
      for (const element of [call.cmd, ...call.args]) {
        expect(element).not.toContain(SECRET);
        expect(element).not.toContain(hex);
      }
    }
    expect(security.calls.some((c) => c.stdin?.includes(SECRET))).toBe(true);
  });

  test("a put that does not read back THROWS, even though `security -i` exited 0", async () => {
    const security = fakeSecurity({ broken: true });
    await expect(keychainKeyStore(security.run).put(ID, KEY)).rejects.toThrow(/Keychain/);
  });

  test("an id that is not hex never reaches the command line", async () => {
    const security = fakeSecurity();
    const store = keychainKeyStore(security.run);
    await expect(store.put('x" -w y\nquit', KEY)).rejects.toThrow(/id/);
    expect(security.calls).toEqual([]);
  });

  test("removing a missing item is fine; a refusal is an error", async () => {
    await keychainKeyStore(fakeSecurity().run).remove(ID);
    await expect(keychainKeyStore(fakeSecurity({ locked: true }).run).remove(ID)).rejects.toThrow(
      /36/,
    );
  });
});

describe("file key store", () => {
  test("writes 0600 in a 0700 dir and reads back", async () => {
    const configDir = tempDir();
    const store = fileKeyStore(configDir);
    await store.put(ID, KEY);
    const path = join(configDir, "connect", "keys", `${ID}.key`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(configDir, "connect", "keys")).mode & 0o777).toBe(0o700);
    expect(readFileSync(path, "utf8").trim()).toBe(SECRET);
    expect(await store.get(ID)).toEqual(KEY);
    await store.remove(ID);
    expect(existsSync(path)).toBe(false);
    await store.remove(ID);
  });

  test("a missing or damaged file reads as no key", async () => {
    const configDir = tempDir();
    const store = fileKeyStore(configDir);
    expect(await store.get(ID)).toBeUndefined();
    await store.put(ID, KEY);
    writeFileSync(join(configDir, "connect", "keys", `${ID}.key`), "short");
    expect(await store.get(ID)).toBeUndefined();
  });

  test("an id that is not hex never names a path", async () => {
    await expect(fileKeyStore(tempDir()).put("../../x", KEY)).rejects.toThrow(/id/);
  });
});

describe("spawnRun (the production runner, on harmless commands)", () => {
  test("delivers stdin, closes it, and returns stdout and the exit code", async () => {
    expect(await spawnRun("/bin/cat", [], "secret line\n")).toEqual({
      code: 0,
      stdout: "secret line\n",
    });
    expect((await spawnRun("/usr/bin/false", [])).code).toBe(1);
  });

  test("a command that cannot start is a failed run, never a rejection", async () => {
    expect((await spawnRun("/nonexistent/security", [])).code).not.toBe(0);
  });
});

describe("which store", () => {
  test("darwin has the Keychain, another platform only the file", () => {
    expect(defaultKeyStores(tempDir(), "darwin", fakeSecurity().run).keychain).toBeDefined();
    expect(defaultKeyStores(tempDir(), "linux", fakeSecurity().run).keychain).toBeUndefined();
  });

  test("storeKey uses the Keychain silently when it works", async () => {
    const security = fakeSecurity();
    const configDir = tempDir();
    const notices: string[] = [];
    const stores = defaultKeyStores(configDir, "darwin", security.run);
    expect(await storeKey(stores, ID, KEY, (l) => notices.push(l))).toBe("keychain");
    expect(notices).toEqual([]);
    expect(existsSync(join(configDir, "connect", "keys", `${ID}.key`))).toBe(false);
    expect(await loadKey(stores, record("keychain"))).toEqual(KEY);
  });

  test("a Keychain write failure falls back to the file, said in ONE line", async () => {
    const configDir = tempDir();
    const notices: string[] = [];
    const stores = defaultKeyStores(configDir, "darwin", fakeSecurity({ broken: true }).run);
    expect(await storeKey(stores, ID, KEY, (l) => notices.push(l))).toBe("file");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("0600");
    expect(notices[0]).not.toContain(SECRET);
    expect(notices[0]?.indexOf("\n")).toBe((notices[0]?.length ?? 0) - 1);
    expect(await loadKey(stores, record("file"))).toEqual(KEY);
  });

  test("a read never falls back to the other store (F2)", async () => {
    const configDir = tempDir();
    await fileKeyStore(configDir).put(ID, KEY);
    const stores = defaultKeyStores(configDir, "darwin", fakeSecurity().run);
    await expect(loadKey(stores, record("keychain"))).rejects.toThrow(
      "key for 'app' unavailable (keychain) — pair again, then `tentacle devices revoke 0123456789abcdef` on the host",
    );
  });

  test("a locked Keychain, or none on this platform, is the same F2 error", async () => {
    const locked = defaultKeyStores(tempDir(), "darwin", fakeSecurity({ locked: true }).run);
    await expect(loadKey(locked, record("keychain"))).rejects.toThrow(/unavailable \(keychain\)/);
    const linux = defaultKeyStores(tempDir(), "linux", fakeSecurity().run);
    await expect(loadKey(linux, record("keychain"))).rejects.toThrow(/unavailable \(keychain\)/);
    await expect(loadKey(linux, record("file"))).rejects.toThrow(/unavailable \(file\)/);
  });

  test("dropKey removes from the named store", async () => {
    const security = fakeSecurity();
    const stores = defaultKeyStores(tempDir(), "darwin", security.run);
    await storeKey(stores, ID, KEY, () => {});
    await dropKey(stores, "keychain", ID);
    expect(security.items.size).toBe(0);
  });
});
