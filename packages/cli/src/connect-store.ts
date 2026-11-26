/**
 * The laptop's records of the computers it paired with for `connect <name>`
 * (docs/feat/connect-via-relay.md D1): one file per record,
 * `<configDir>/connect/computers/<name>.json` (dir `0700`, file `0600`), no
 * index. The device key is NEVER in a record (`connect-keys.ts` holds it, under
 * the record's `id`).
 *
 * No index on purpose: a record is CREATED with `wx`, so the filesystem keeps
 * names unique and two `--pair` runs cannot lose each other's record; a refresh
 * rewrites only its own file.
 *
 * A record this build cannot read (unknown `v`, invalid) is refused and is
 * never written or deleted by it (AGENTS §7, on-disk formats).
 */
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEVICE_ID_RE,
  MAX_PAIRING_ADDRESSES,
  PAIRING_COMPUTER_NAME_MAX,
  PAIRING_KEY_BYTES,
  decodeBase64Url,
  isPairingAddress,
  isPairingName,
} from "@tentacle/protocol";
import { z } from "zod";

export const CONNECT_DIR = "connect";
export const RECORD_VERSION = 1;
/** A record name: what `connect <name>` takes, and the record's file name. */
export const RECORD_NAME_MAX = 64;
const NAME_RE = /^[a-z0-9_][a-z0-9._-]{0,63}$/;
/** The key's handle: 16 random bytes, hex. It reaches a file path and the Keychain. */
export const RECORD_ID_RE = /^[0-9a-f]{32}$/;

export type KeyStoreKind = "keychain" | "file";

const text = z.string().refine(isPairingName);
const address = z.string().refine(isPairingAddress);

const RecordSchema = z.object({
  v: z.literal(RECORD_VERSION),
  name: z.string().regex(NAME_RE),
  id: z.string().regex(RECORD_ID_RE),
  /** The host's display name. */
  computer: text,
  /** The computer's static public key, base64url: pinned by the handshake. */
  computerKey: z.string().refine((k) => decodeBase64Url(k)?.length === PAIRING_KEY_BYTES),
  deviceId: z.string().regex(DEVICE_ID_RE),
  project: z
    .object({
      cwd: z.string().min(1).max(4096),
      label: z.string().min(1).max(PAIRING_COMPUTER_NAME_MAX).refine(isPairingName),
    })
    .optional(),
  addresses: z.array(address).min(1).max(MAX_PAIRING_ADDRESSES),
  /** The address the last successful dial won on. */
  lastAddress: address.optional(),
  keyStore: z.enum(["keychain", "file"]),
});
export type ComputerRecord = z.infer<typeof RecordSchema>;

export type RecordRead =
  | { readonly ok: true; readonly record: ComputerRecord }
  | { readonly ok: false; readonly kind: "missing" }
  | {
      readonly ok: false;
      readonly kind: "invalid";
      readonly path: string;
      readonly reason: string;
    };

export function computersDir(configDir: string): string {
  return join(configDir, CONNECT_DIR, "computers");
}

export function recordPath(configDir: string, name: string): string {
  return join(computersDir(configDir), `${name}.json`);
}

/** Make `<configDir>/connect/<sub>` private (`0700`), whatever the umask. */
export function privateDir(configDir: string, sub: string): string {
  const root = join(configDir, CONNECT_DIR);
  const dir = join(root, sub);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  chmodSync(dir, 0o700);
  return dir;
}

/** Create `path` exclusively at `0600`; a failed write leaves no file behind. */
export function createPrivateFile(path: string, content: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    try {
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    chmodSync(path, 0o600);
  } catch (error) {
    try {
      unlinkSync(path);
    } catch {
      // Nothing more to do: the original failure is the one to report.
    }
    throw error;
  }
}

/** A name for a record, from a project label or a computer name (D5). */
export function slugName(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, RECORD_NAME_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "computer" : slug;
}

export function parseRecord(
  content: string,
  name: string,
): { readonly record: ComputerRecord } | { readonly reason: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return { reason: "not JSON" };
  }
  const v = (raw as { v?: unknown } | null)?.v;
  if (v !== RECORD_VERSION) {
    return { reason: `unknown record version ${JSON.stringify(v ?? null)}` };
  }
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) {
    return { reason: `invalid field ${parsed.error.issues[0]?.path.join(".") || "(root)"}` };
  }
  if (parsed.data.name !== name) {
    return { reason: "the name inside does not match the file name" };
  }
  return { record: parsed.data };
}

export function readRecord(configDir: string, name: string): RecordRead {
  // Also what keeps a typed name from naming a path.
  if (!NAME_RE.test(name)) {
    return { ok: false, kind: "missing" };
  }
  const path = recordPath(configDir, name);
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === "ENOENT"
      ? { ok: false, kind: "missing" }
      : { ok: false, kind: "invalid", path, reason: `unreadable (${String(code)})` };
  }
  const parsed = parseRecord(content, name);
  return "record" in parsed
    ? { ok: true, record: parsed.record }
    : { ok: false, kind: "invalid", path, reason: parsed.reason };
}

export function listRecordNames(configDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(computersDir(configDir));
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .filter((name) => NAME_RE.test(name))
    .sort();
}

/** The file's content: the schema's fields only, so no stray field (a key) is ever written. */
function serialize(record: ComputerRecord): string {
  return `${JSON.stringify(RecordSchema.parse(record), null, 2)}\n`;
}

/**
 * Create a NEW record under `baseName`, or `<base>-2`, `-3`, … when taken (`wx`,
 * so two concurrent pairs never overwrite each other).
 */
export function createRecord(
  configDir: string,
  record: Omit<ComputerRecord, "name" | "v">,
  baseName: string,
): ComputerRecord {
  privateDir(configDir, "computers");
  const base = slugName(baseName);
  for (let n = 1; n <= 1000; n++) {
    const suffix = n === 1 ? "" : `-${n}`;
    const name = `${base.slice(0, RECORD_NAME_MAX - suffix.length)}${suffix}`;
    const created: ComputerRecord = { ...record, v: RECORD_VERSION, name };
    try {
      createPrivateFile(recordPath(configDir, name), serialize(created));
      return created;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") {
        throw error;
      }
    }
  }
  throw new Error(`no free record name for '${base}'`);
}

/**
 * Rewrite an EXISTING record (tmp + rename). Throws, writing nothing, when the
 * file is gone (forgotten meanwhile: never resurrected), is one this build
 * cannot read, or now belongs to another pairing.
 */
export function writeRecord(configDir: string, record: ComputerRecord): void {
  const current = readRecord(configDir, record.name);
  if (!current.ok) {
    throw new Error(
      current.kind === "missing"
        ? `the record '${record.name}' no longer exists`
        : `${current.path}: ${current.reason} — left untouched`,
    );
  }
  if (current.record.id !== record.id) {
    throw new Error(`the record '${record.name}' was replaced by another pairing`);
  }
  const path = recordPath(configDir, record.name);
  const tmp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  createPrivateFile(tmp, serialize(record));
  try {
    renameSync(tmp, path);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}

/** Delete a record file (never one this build cannot read). `undefined` = no such record. */
export function removeRecord(configDir: string, name: string): ComputerRecord | undefined {
  const current = readRecord(configDir, name);
  if (!current.ok) {
    if (current.kind === "missing") {
      return undefined;
    }
    throw new Error(`${current.path}: ${current.reason} — left untouched`);
  }
  unlinkSync(recordPath(configDir, name));
  return current.record;
}

/**
 * `connect --forget <name>` (D7): the record first, then its key — so a failure
 * between the two leaves an orphan key (harmless), never a record with no key.
 */
export async function forgetRecord(
  configDir: string,
  name: string,
  removeKey: (record: ComputerRecord) => Promise<void>,
): Promise<ComputerRecord | undefined> {
  const record = removeRecord(configDir, name);
  if (record !== undefined) {
    await removeKey(record);
  }
  return record;
}
