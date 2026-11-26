/**
 * Where the laptop keeps the device key of a paired computer
 * (docs/feat/connect-via-relay.md D2): the macOS Keychain, else a `0600` file
 * under `<configDir>/connect/keys/`. One fresh key per pairing, handled by the
 * record's random `id`.
 *
 * The secret is NEVER in an argv element (argv is visible in `ps`, AGENTS §7):
 * `security -i` reads the `add-generic-password` command on stdin, and a read
 * gets the secret back on stdout. A write is verified by reading it back, so a
 * `security` that stores nothing is a failed `put`, never a silent one.
 *
 * What the Keychain buys is limited: an item `security` created trusts
 * `/usr/bin/security`, so same-user malware reads it as it reads a `0600` file.
 * The key is encrypted at rest and stays out of backups of `<configDir>`.
 */
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { PAIRING_KEY_BYTES, decodeBase64Url, encodeBase64Url } from "@tentacle/protocol";
import {
  CONNECT_DIR,
  type ComputerRecord,
  type KeyStoreKind,
  RECORD_ID_RE,
  createPrivateFile,
  privateDir,
} from "./connect-store.ts";

export const KEYCHAIN_SERVICE = "tentacle.connect";
export const SECURITY_BIN = "/usr/bin/security";
/** `security`'s exit code for "no such item" (errSecItemNotFound). */
const ITEM_NOT_FOUND = 44;
/** A Keychain dialog nobody answers must not hang `connect` for ever. */
const SECURITY_TIMEOUT_MS = 60_000;

/** Runs one command; `stdin` is written to it and closed. Never rejects. */
export type CommandRun = (
  cmd: string,
  args: readonly string[],
  stdin?: string,
) => Promise<{ readonly code: number; readonly stdout: string }>;

export const spawnRun: CommandRun = async (cmd, args, stdin) => {
  try {
    const child = Bun.spawn([cmd, ...args], {
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "ignore",
      timeout: SECURITY_TIMEOUT_MS,
    });
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
};

export interface KeyStore {
  put(id: string, key: Uint8Array): Promise<void>;
  /** `undefined` when there is no readable key under `id`. */
  get(id: string): Promise<Uint8Array | undefined>;
  /** A missing key is fine; a key that could not be removed throws. */
  remove(id: string): Promise<void>;
}

export interface KeyStores {
  /** Absent where there is no Keychain. */
  readonly keychain?: KeyStore;
  readonly file: KeyStore;
}

/** The id reaches a command line and a file path: hex only. */
function checkId(id: string): void {
  if (!RECORD_ID_RE.test(id)) {
    throw new Error("invalid key id");
  }
}

function decodeKey(encoded: string): Uint8Array | undefined {
  const key = decodeBase64Url(encoded.trim());
  return key?.length === PAIRING_KEY_BYTES ? key : undefined;
}

export function keychainKeyStore(run: CommandRun): KeyStore {
  const item = (id: string): string[] => ["-s", KEYCHAIN_SERVICE, "-a", id];
  const get = async (id: string): Promise<Uint8Array | undefined> => {
    checkId(id);
    const found = await run(SECURITY_BIN, ["find-generic-password", ...item(id), "-w"]);
    return found.code === 0 ? decodeKey(found.stdout) : undefined;
  };
  const remove = async (id: string): Promise<void> => {
    checkId(id);
    const { code } = await run(SECURITY_BIN, ["delete-generic-password", ...item(id)]);
    if (code !== 0 && code !== ITEM_NOT_FOUND) {
      throw new Error(`the Keychain refused to remove the key (security exited ${code})`);
    }
  };
  return {
    get,
    remove,
    put: async (id, key) => {
      checkId(id);
      const secret = encodeBase64Url(key);
      const { code } = await run(
        SECURITY_BIN,
        ["-i"],
        `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${id} -w ${secret}\n`,
      );
      const stored = code === 0 ? await get(id) : undefined;
      if (stored === undefined || encodeBase64Url(stored) !== secret) {
        // Best effort: whatever did land must not stay behind.
        await remove(id).catch(() => {});
        throw new Error("the Keychain did not store the key");
      }
    },
  };
}

export function fileKeyStore(configDir: string): KeyStore {
  const path = (id: string): string => {
    checkId(id);
    return join(configDir, CONNECT_DIR, "keys", `${id}.key`);
  };
  return {
    put: async (id, key) => {
      const file = path(id);
      privateDir(configDir, "keys");
      createPrivateFile(file, `${encodeBase64Url(key)}\n`);
    },
    get: async (id) => {
      const file = path(id);
      try {
        return decodeKey(readFileSync(file, "utf8"));
      } catch {
        return undefined;
      }
    },
    remove: async (id) => {
      try {
        unlinkSync(path(id));
      } catch (error) {
        if ((error as { code?: unknown }).code !== "ENOENT") {
          throw error;
        }
      }
    },
  };
}

export function defaultKeyStores(
  configDir: string,
  platform: string = process.platform,
  run: CommandRun = spawnRun,
): KeyStores {
  return {
    ...(platform === "darwin" ? { keychain: keychainKeyStore(run) } : {}),
    file: fileKeyStore(configDir),
  };
}

/**
 * Store a new key: the Keychain where there is one, else — or when its write
 * fails — the file, said in ONE line. Returns the store the record must name.
 */
export async function storeKey(
  stores: KeyStores,
  id: string,
  key: Uint8Array,
  notice: (line: string) => void,
): Promise<KeyStoreKind> {
  if (stores.keychain !== undefined) {
    try {
      await stores.keychain.put(id, key);
      return "keychain";
    } catch (error) {
      notice(
        `[connect] ${error instanceof Error ? error.message : String(error)} — keeping it in a 0600 file instead\n`,
      );
    }
  }
  await stores.file.put(id, key);
  return "file";
}

/** The record's key, from the store the record NAMES: never a silent fallback (F2). */
export async function loadKey(stores: KeyStores, record: ComputerRecord): Promise<Uint8Array> {
  const key = await stores[record.keyStore]?.get(record.id);
  if (key === undefined) {
    throw new Error(
      `key for '${record.name}' unavailable (${record.keyStore}) — pair again, then \`tentacle devices revoke ${record.deviceId}\` on the host`,
    );
  }
  return key;
}

/** Remove a key from the named store (no store of that kind = nothing to remove here). */
export async function dropKey(stores: KeyStores, kind: KeyStoreKind, id: string): Promise<void> {
  await stores[kind]?.remove(id);
}
