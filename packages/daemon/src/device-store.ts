/**
 * The device store — `<configDir>/devices/` (docs/feat/device-pairing.md 9a,
 * Design "On-disk layout").
 *
 * One truth per COMPUTER, shared by every daemon on it (decision 7): the
 * computer's own static key (`identity.json`), the devices allowed to connect
 * (`registry.json`), when each was last seen (`seen/<id>`, mtime only) and the
 * pairing windows (`pairing/<sid>*.json`). A `serve` daemon writes only `seen/`,
 * a claim and its own record under `<configDir>/daemons/`; the registry has ONE
 * writer, the CLI, under a lock — so two daemons can never interleave a
 * read-modify-write of the list of who may connect.
 *
 * Versioned on its own (`DEVICE_STORE_VERSION`), apart from the wire (AGENTS
 * §7, "on-disk records are versioned separately"): an unknown `v` or an
 * unreadable file is REFUSED and never written — a daemon then denies every
 * device (fail closed, one audit line), and the CLI stops naming the file.
 *
 * Two write primitives, each chosen for what it must survive:
 * - the registry is tmp + `rename` (atomic replace: a reader never sees half a
 *   list, and a crash leaves the old one);
 * - the identity is tmp + `link` (`EEXIST` = someone else won → read theirs),
 *   so two daemons starting at once converge on ONE key rather than one
 *   silently overwriting the other (F12).
 *
 * The keys are X25519 static public keys, stored as unpadded base64url — the
 * same encoding the pairing QR uses (`@tentacle/protocol`'s `pairing.ts`), so
 * there is exactly one string form of a key in the product.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  decodeBase64Url,
  encodeBase64Url,
  isPairingName,
  normalizePairingCode,
} from "@tentacle/protocol";
import {
  type Random,
  generateStaticKeypair,
  pairingSas,
  systemRandom,
} from "@tentacle/transport/noise";

/** The store's own version (separate from `PROTOCOL_VERSION` and the log's header). */
export const DEVICE_STORE_VERSION = 1;
/** `<configDir>/devices` */
export const DEVICE_DIR = "devices";
export const IDENTITY_FILENAME = "identity.json";
export const REGISTRY_FILENAME = "registry.json";
/** The registry's write lock, held only while the CLI edits the list. */
export const REGISTRY_LOCK_FILENAME = "registry.lock";
export const SEEN_DIR = "seen";
export const PAIRING_DIR = "pairing";
/** `<configDir>/daemons` — one record per running `serve` (task 10 builds siblings on them). */
export const DAEMONS_DIR = "daemons";
/** A pairing window: five minutes, single use (F1, F6). */
export const PAIRING_TTL_MS = 5 * 60 * 1000;
/** A device id is the first 16 hex of SHA-256(its public key): short enough to type, no collisions in practice. */
export const DEVICE_ID_HEX = 16;

const KEY_BYTES = 32;
/** A pairing code on disk is stored only as this digest (50 bits, so no dictionary attack exists). */
const CODE_HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = new RegExp(`^[0-9a-f]{${DEVICE_ID_HEX}}$`);
const SID_RE = /^[0-9a-f]{32}$/;

/** The store's directory for one config dir. */
export function deviceDir(configDir: string): string {
  return join(configDir, DEVICE_DIR);
}

/** The public key's device id (stable across re-pairings: same key, same id). */
export function deviceIdOf(publicKey: Uint8Array): string {
  return createHash("sha256").update(publicKey).digest("hex").slice(0, DEVICE_ID_HEX);
}

/** SHA-256 of a pairing code, hex — the only form written to disk. */
export function pairingCodeHash(code: string): string {
  const canonical = normalizePairingCode(code);
  if (canonical === undefined) {
    throw new Error("pairing code must be 10 Crockford base32 characters");
  }
  return createHash("sha256").update(canonical).digest("hex");
}

/** A refusal a caller shows: which file, and what is wrong with it. */
export interface DeviceStoreFailure {
  readonly ok: false;
  /** The file (or directory) at fault: the CLI names it, the daemon logs it once. */
  readonly path: string;
  readonly reason: string;
  /** The file is not there at all (a fresh computer), not wrong: the only refusal a creator may act on. */
  readonly missing?: true;
}

const failure = (path: string, reason: string): DeviceStoreFailure => ({ ok: false, path, reason });

/** The computer's static key and display name. */
export interface DeviceIdentity {
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
  readonly name: string;
  readonly createdAt: number;
}

export type IdentityResult =
  | { readonly ok: true; readonly identity: DeviceIdentity; readonly path: string }
  | DeviceStoreFailure;

/** One device allowed to connect (decision 2: a key created at pairing, revocable here). */
export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly publicKey: Uint8Array;
  readonly pairedAt: number;
}

export interface DeviceRegistry {
  readonly devices: readonly PairedDevice[];
}

export type RegistryResult =
  | { readonly ok: true; readonly registry: DeviceRegistry }
  | DeviceStoreFailure;

export const EMPTY_REGISTRY: DeviceRegistry = { devices: [] };

// ---------------------------------------------------------------------------
// small IO helpers
// ---------------------------------------------------------------------------

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A key as stored, or `undefined` — never a throw: a bad key is a refusal, not a crash. */
function readKey(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const bytes = decodeBase64Url(value);
  return bytes !== undefined && bytes.length === KEY_BYTES ? bytes : undefined;
}

/** `<dir>` at 0700 (or tightened if it already existed loose). Never recursive beyond one level. */
function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`cannot create ${dir}: ${(error as Error).message}`);
  }
}

/** Best effort: the store's modes are a hardening, never the correctness of a record. */
function tightenModes(configDir: string): void {
  try {
    chmodSync(deviceDir(configDir), 0o700);
    chmodSync(join(deviceDir(configDir), IDENTITY_FILENAME), 0o600);
  } catch {
    // Not ours to fix here (a read-only config dir, a foreign owner).
  }
}

/** Write `bytes` at `path` through a sibling temp file, then `rename` over it (atomic replace). */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** What reading a JSON file gave: absent (a fresh computer), unreadable, or its value. */
type JsonRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly failure: DeviceStoreFailure }
  | { readonly kind: "value"; readonly value: unknown };

/** Read + parse a JSON file. Absent is NOT an error; unreadable or malformed is. */
function readJson(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { kind: "absent" };
    }
    return {
      kind: "unreadable",
      failure: failure(path, `unreadable: ${(error as Error).message}`),
    };
  }
  try {
    return { kind: "value", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "unreadable", failure: failure(path, "not valid JSON") };
  }
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

/**
 * Read `identity.json`, never creating it. A missing file is a failure here (the
 * caller decides whether to create one: a daemon must not invent a key behind a
 * `pair` that is waiting with a different one in its QR).
 */
export function readIdentity(configDir: string): IdentityResult {
  const path = join(deviceDir(configDir), IDENTITY_FILENAME);
  const read = readJson(path);
  if (read.kind === "unreadable") {
    return read.failure;
  }
  if (read.kind === "absent") {
    return {
      ok: false,
      missing: true,
      path,
      reason: "no identity on this computer",
    };
  }
  const value = read.value;
  if (!isObject(value)) {
    return failure(path, "not an object");
  }
  if (value.v !== DEVICE_STORE_VERSION) {
    return failure(path, `unknown version ${String(value.v)}`);
  }
  const publicKey = readKey(value.publicKey);
  const privateKey = readKey(value.privateKey);
  if (publicKey === undefined || privateKey === undefined) {
    return failure(path, "keys are not 32-byte base64url");
  }
  if (typeof value.name !== "string" || !isPairingName(value.name)) {
    return failure(path, "name is missing or not printable");
  }
  if (!isStamp(value.createdAt)) {
    return failure(path, "createdAt is not a timestamp");
  }
  return {
    ok: true,
    path,
    identity: { publicKey, privateKey, name: value.name, createdAt: value.createdAt },
  };
}

export interface IdentityOptions {
  /** The computer's display name; default `os.hostname()`-ish, supplied by the caller (this module has no hostname source of its own). */
  readonly name: string;
  readonly now?: number;
  readonly random?: Random;
}

/**
 * Load this computer's identity, creating it on first use. Two creators racing
 * here end with ONE key: both write a temp file, `link` puts the first one in
 * place and the loser reads the winner's (`EEXIST`), never overwriting it.
 */
export function loadOrCreateIdentity(configDir: string, options: IdentityOptions): IdentityResult {
  const existing = readIdentity(configDir);
  if (existing.ok) {
    // A store written by a looser umask stays 0600 (the design's "files 0600"):
    // the key is a private key, and the mode is the only thing protecting it.
    tightenModes(configDir);
    return existing;
  }
  // Only "there is no file yet" licenses creating one: an UNREADABLE identity is
  // a human's to fix, and inventing a key behind it would break every phone
  // that pinned the old one (F14). Checked by flag, never by message text.
  if (existing.missing !== true) {
    return existing;
  }
  const dir = deviceDir(configDir);
  const path = join(dir, IDENTITY_FILENAME);
  try {
    ensureDir(dir);
  } catch (error) {
    return failure(dir, (error as Error).message);
  }
  const random = options.random ?? systemRandom;
  const keypair = generateStaticKeypair(random);
  const createdAt = options.now ?? Date.now();
  const record = {
    v: DEVICE_STORE_VERSION,
    publicKey: encodeBase64Url(keypair.publicKey),
    privateKey: encodeBase64Url(keypair.privateKey),
    name: options.name,
    createdAt,
  };
  const tmp = join(dir, `.identity.${process.pid}.${createdAt.toString(36)}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
    linkSync(tmp, path);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") {
      rmSync(tmp, { force: true });
      return failure(path, (error as Error).message);
    }
    // Someone else created it first: theirs is the identity (F12).
  } finally {
    rmSync(tmp, { force: true });
  }
  // A store written by an older, looser build (or by a umask quirk): tighten it.
  tightenModes(configDir);
  return readIdentity(configDir);
}

/** Replace `identity.json` (only `devices reset`: a new key means every phone must pair again). */
export function replaceIdentity(configDir: string, options: IdentityOptions): IdentityResult {
  const dir = deviceDir(configDir);
  const path = join(dir, IDENTITY_FILENAME);
  try {
    ensureDir(dir);
    const keypair = generateStaticKeypair(options.random ?? systemRandom);
    writeAtomic(
      path,
      JSON.stringify({
        v: DEVICE_STORE_VERSION,
        publicKey: encodeBase64Url(keypair.publicKey),
        privateKey: encodeBase64Url(keypair.privateKey),
        name: options.name,
        createdAt: options.now ?? Date.now(),
      }),
    );
  } catch (error) {
    return failure(path, (error as Error).message);
  }
  return readIdentity(configDir);
}

// ---------------------------------------------------------------------------
// registry
// ---------------------------------------------------------------------------

/** Parse ONE device entry; `undefined` if it is not one (the whole registry is then refused). */
function readDevice(value: unknown): PairedDevice | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const publicKey = readKey(value.publicKey);
  if (publicKey === undefined || typeof value.id !== "string" || !ID_RE.test(value.id)) {
    return undefined;
  }
  // The id is DERIVED: an entry whose id does not match its key would authorise
  // one device and revoke another — refused, not "repaired".
  if (value.id !== deviceIdOf(publicKey)) {
    return undefined;
  }
  if (typeof value.name !== "string" || !isPairingName(value.name)) {
    return undefined;
  }
  if (!isStamp(value.pairedAt)) {
    return undefined;
  }
  return { id: value.id, name: value.name, publicKey, pairedAt: value.pairedAt };
}

/**
 * Read `registry.json`. Absent = an empty registry (a fresh computer is not an
 * error); unreadable, malformed, an unknown version or one bad entry = a
 * failure, and the caller must then deny everyone (F14) and never write.
 */
export function readRegistry(configDir: string): RegistryResult {
  const path = join(deviceDir(configDir), REGISTRY_FILENAME);
  const read = readJson(path);
  if (read.kind === "unreadable") {
    return read.failure;
  }
  if (read.kind === "absent") {
    return { ok: true, registry: EMPTY_REGISTRY };
  }
  const value = read.value;
  if (!isObject(value)) {
    return failure(path, "not an object");
  }
  if (value.v !== DEVICE_STORE_VERSION) {
    return failure(path, `unknown version ${String(value.v)}`);
  }
  if (!Array.isArray(value.devices)) {
    return failure(path, '"devices" is not an array');
  }
  const devices: PairedDevice[] = [];
  for (const [index, entry] of value.devices.entries()) {
    const device = readDevice(entry);
    if (device === undefined) {
      return failure(path, `device ${index} is malformed`);
    }
    devices.push(device);
  }
  return { ok: true, registry: { devices } };
}

/** The record form of a registry (what `registry.json` holds). */
function serializeRegistry(registry: DeviceRegistry): string {
  return JSON.stringify({
    v: DEVICE_STORE_VERSION,
    devices: registry.devices.map((d) => ({
      id: d.id,
      name: d.name,
      publicKey: encodeBase64Url(d.publicKey),
      pairedAt: d.pairedAt,
    })),
  });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}

/** A held registry lock. `release` is idempotent and only removes OUR lock. */
export interface RegistryLock {
  readonly path: string;
  release(): void;
}

/**
 * Take `<devices>/registry.lock` exclusively (holding our pid). The same pattern
 * as the session store's lock (`session-persister.ts:642-690`): a live holder is
 * an immediate refusal naming the file, a dead one is taken over once. It does
 * NOT wait: the CLI is an interactive command, so failing with the pid to look
 * at is more useful than a stall (and a silent wait would hide a second `pair`).
 */
export function acquireRegistryLock(configDir: string): RegistryLock {
  const dir = deviceDir(configDir);
  ensureDir(dir);
  const path = join(dir, REGISTRY_LOCK_FILENAME);
  const take = (): void => {
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  };
  try {
    take();
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") {
      throw error;
    }
    let holder = Number.NaN;
    try {
      holder = Number(readFileSync(path, "utf8").trim());
    } catch {
      // Vanished or unreadable: treated as stale below.
    }
    if (Number.isSafeInteger(holder) && holder > 0 && processAlive(holder)) {
      throw new Error(
        `another tentacle (pid ${holder}) is editing the device registry; retry, or remove ${path} if it is not running`,
      );
    }
    rmSync(path, { force: true });
    take();
  }
  let held = true;
  return {
    path,
    release: () => {
      if (!held) {
        return;
      }
      held = false;
      try {
        if (readFileSync(path, "utf8").trim() === String(process.pid)) {
          rmSync(path, { force: true });
        }
      } catch {
        // Already gone: nothing to release.
      }
    },
  };
}

/**
 * Replace the whole registry under the lock, atomically. Refuses to write over a
 * file this build cannot read: an unreadable registry is a human's to fix
 * (F14), never to be silently emptied.
 */
export function writeRegistry(configDir: string, registry: DeviceRegistry): RegistryResult {
  const dir = deviceDir(configDir);
  const path = join(dir, REGISTRY_FILENAME);
  let lock: RegistryLock;
  try {
    lock = acquireRegistryLock(configDir);
  } catch (error) {
    return failure(join(dir, REGISTRY_LOCK_FILENAME), (error as Error).message);
  }
  try {
    const current = readRegistry(configDir);
    if (!current.ok) {
      return current;
    }
    for (const device of registry.devices) {
      if (deviceIdOf(device.publicKey) !== device.id) {
        return failure(path, `device ${device.id} does not match its key`);
      }
    }
    ensureDir(dir);
    writeAtomic(path, serializeRegistry(registry));
  } catch (error) {
    return failure(path, (error as Error).message);
  } finally {
    lock.release();
  }
  return { ok: true, registry };
}

/** `iPhone` → `iPhone (2)`, `iPhone (3)`…: re-pairing a name ADDS an entry (owner Q4). */
export function dedupeName(registry: DeviceRegistry, name: string): string {
  const taken = new Set(registry.devices.map((d) => d.name));
  if (!taken.has(name)) {
    return name;
  }
  for (let n = 2; ; n++) {
    const candidate = `${name} (${n})`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}

export type AddDeviceResult =
  | { readonly ok: true; readonly device: PairedDevice; readonly registry: DeviceRegistry }
  | DeviceStoreFailure;

/**
 * Authorise `publicKey` (the CLI's `pair` accept, after the human said yes).
 * Idempotent for a key already present (the same phone pairing twice does not
 * duplicate itself), additive for a new key under an existing name.
 */
export function addDevice(
  configDir: string,
  device: { readonly publicKey: Uint8Array; readonly name: string; readonly now?: number },
): AddDeviceResult {
  if (device.publicKey.length !== KEY_BYTES) {
    return failure(join(deviceDir(configDir), REGISTRY_FILENAME), "the device key is not 32 bytes");
  }
  if (!isPairingName(device.name)) {
    return failure(
      join(deviceDir(configDir), REGISTRY_FILENAME),
      "the device name is not printable",
    );
  }
  const dir = deviceDir(configDir);
  const path = join(dir, REGISTRY_FILENAME);
  let lock: RegistryLock;
  try {
    lock = acquireRegistryLock(configDir);
  } catch (error) {
    return failure(join(dir, REGISTRY_LOCK_FILENAME), (error as Error).message);
  }
  try {
    const current = readRegistry(configDir);
    if (!current.ok) {
      return current;
    }
    const id = deviceIdOf(device.publicKey);
    const existing = current.registry.devices.find((d) => d.id === id);
    if (existing !== undefined) {
      return { ok: true, device: existing, registry: current.registry };
    }
    const entry: PairedDevice = {
      id,
      name: dedupeName(current.registry, device.name),
      publicKey: device.publicKey,
      pairedAt: device.now ?? Date.now(),
    };
    const registry: DeviceRegistry = { devices: [...current.registry.devices, entry] };
    ensureDir(dir);
    writeAtomic(path, serializeRegistry(registry));
    return { ok: true, device: entry, registry };
  } catch (error) {
    return failure(path, (error as Error).message);
  } finally {
    lock.release();
  }
}

export type RemoveDevicesResult =
  | {
      readonly ok: true;
      readonly removed: readonly PairedDevice[];
      readonly registry: DeviceRegistry;
    }
  | DeviceStoreFailure;

/** Revoke devices by id (the CLI resolved the names/prefixes; the store owns the write). */
export function removeDevices(configDir: string, ids: readonly string[]): RemoveDevicesResult {
  const dir = deviceDir(configDir);
  const path = join(dir, REGISTRY_FILENAME);
  let lock: RegistryLock;
  try {
    lock = acquireRegistryLock(configDir);
  } catch (error) {
    return failure(join(dir, REGISTRY_LOCK_FILENAME), (error as Error).message);
  }
  try {
    const current = readRegistry(configDir);
    if (!current.ok) {
      return current;
    }
    const gone = new Set(ids);
    const removed = current.registry.devices.filter((d) => gone.has(d.id));
    if (removed.length === 0) {
      return { ok: true, removed: [], registry: current.registry };
    }
    const registry: DeviceRegistry = {
      devices: current.registry.devices.filter((d) => !gone.has(d.id)),
    };
    ensureDir(dir);
    writeAtomic(path, serializeRegistry(registry));
    // `seen/<id>` goes with the entry: a revoked device must not leave a
    // "last seen" line behind that looks like a device (a re-pair re-creates it).
    for (const device of removed) {
      rmSync(join(dir, SEEN_DIR, device.id), { force: true });
    }
    return { ok: true, removed, registry };
  } catch (error) {
    return failure(path, (error as Error).message);
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------
// last seen (mtime only: no read-modify-write between two daemons)
// ---------------------------------------------------------------------------

/**
 * Record that `id` was seen just now. The mtime IS the record, so two daemons
 * never race on a content update; a failure is reported (false) and never
 * thrown — a full disk must not refuse a working connection (F25).
 */
export function touchSeen(configDir: string, id: string, at: number = Date.now()): boolean {
  if (!ID_RE.test(id)) {
    return false;
  }
  try {
    const dir = join(deviceDir(configDir), SEEN_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, id);
    writeFileSync(path, "", { mode: 0o600 });
    const seconds = at / 1000;
    utimesSync(path, seconds, seconds);
    return true;
  } catch {
    return false;
  }
}

/** `id` → when it was last seen (ms since the epoch). Unreadable entries are skipped, never fatal. */
export function readSeen(configDir: string): ReadonlyMap<string, number> {
  const dir = join(deviceDir(configDir), SEEN_DIR);
  const seen = new Map<string, number>();
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return seen;
  }
  for (const name of names) {
    if (!ID_RE.test(name)) {
      continue;
    }
    try {
      seen.set(name, statSync(join(dir, name)).mtimeMs);
    } catch {
      // Vanished between the readdir and the stat: not seen, that is all.
    }
  }
  return seen;
}

// ---------------------------------------------------------------------------
// pairing windows
// ---------------------------------------------------------------------------

/** One `pair` in progress: the code's digest, an expiry and the owning pid. */
export interface PairingSession {
  readonly sid: string;
  readonly codeHash: string;
  readonly expiresAt: number;
  readonly pid: number;
}

/** What a phone claimed for a window (written exclusively: one claim per window). */
export interface PairingClaim {
  readonly publicKey: Uint8Array;
  readonly name: string;
  /** The compare code both screens show. */
  readonly sas: string;
  readonly at: number;
}

const sessionPath = (configDir: string, sid: string) =>
  join(deviceDir(configDir), PAIRING_DIR, `${sid}.json`);
const claimPath = (configDir: string, sid: string) =>
  join(deviceDir(configDir), PAIRING_DIR, `${sid}.claim.json`);
const decisionPath = (configDir: string, sid: string) =>
  join(deviceDir(configDir), PAIRING_DIR, `${sid}.decision.json`);

function pairingDirOf(configDir: string): string {
  return join(deviceDir(configDir), PAIRING_DIR);
}

/** Fresh 16-byte hex id (the window's name on disk). */
function newSid(random: Random): string {
  const bytes = random(16);
  return Buffer.from(bytes).toString("hex");
}

export type OpenPairingResult =
  | { readonly ok: true; readonly session: PairingSession }
  | DeviceStoreFailure;

/**
 * Open a pairing window for `code` (only its digest reaches the disk) and sweep
 * whatever a killed `pair` left behind (F2). `pid` is the process that will
 * answer the human's `[y/N]`.
 */
export function openPairing(
  configDir: string,
  options: {
    readonly code: string;
    readonly now?: number;
    readonly ttlMs?: number;
    readonly pid?: number;
    readonly random?: Random;
  },
): OpenPairingResult {
  const dir = pairingDirOf(configDir);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return failure(dir, (error as Error).message);
  }
  const now = options.now ?? Date.now();
  sweepPairings(configDir, { now });
  const session: PairingSession = {
    sid: newSid(options.random ?? systemRandom),
    codeHash: pairingCodeHash(options.code),
    expiresAt: now + (options.ttlMs ?? PAIRING_TTL_MS),
    pid: options.pid ?? process.pid,
  };
  const path = sessionPath(configDir, session.sid);
  try {
    writeAtomic(path, JSON.stringify({ v: DEVICE_STORE_VERSION, ...session }));
  } catch (error) {
    return failure(path, (error as Error).message);
  }
  return { ok: true, session };
}

/** Parse one `pairing/<sid>.json`; `undefined` if it is not one (an unknown version included). */
function readSession(value: unknown): PairingSession | undefined {
  if (!isObject(value) || value.v !== DEVICE_STORE_VERSION) {
    return undefined;
  }
  if (typeof value.sid !== "string" || !SID_RE.test(value.sid)) {
    return undefined;
  }
  if (typeof value.codeHash !== "string" || !CODE_HASH_RE.test(value.codeHash)) {
    return undefined;
  }
  if (!isStamp(value.expiresAt) || !isStamp(value.pid)) {
    return undefined;
  }
  return { sid: value.sid, codeHash: value.codeHash, expiresAt: value.expiresAt, pid: value.pid };
}

/** Every well-formed window on disk (a malformed one is ignored: it can only deny). */
function listSessions(configDir: string): PairingSession[] {
  const dir = pairingDirOf(configDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions: PairingSession[] = [];
  for (const name of names) {
    const session = readSessionFile(join(dir, name), name);
    if (session !== undefined) {
      sessions.push(session);
    }
  }
  return sessions;
}

/** One file of the pairing dir, if it is a window (`<sid>.json` — never a claim or a decision). */
function readSessionFile(path: string, name: string): PairingSession | undefined {
  const read = readJson(path);
  if (read.kind !== "value") {
    return undefined;
  }
  const session = readSession(read.value);
  // The filename must agree with the record: a copied file is not a window.
  return session !== undefined && name === `${session.sid}.json` ? session : undefined;
}

/** Constant-time digest comparison: a code is a secret for the 5 minutes it lives. */
function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export interface LiveClock {
  readonly now?: number;
  /** Injectable for tests: a pid is "alive" if `kill(pid, 0)` succeeds. */
  readonly alive?: (pid: number) => boolean;
}

/**
 * The window `code` names, if it is still usable: unexpired, its owner alive and
 * the digest equal. A FRESH read (never the daemon's poll snapshot): a phone
 * that scans in the first second must not be refused, and a deny is terminal
 * for the client. Expired and dead-pid windows are swept as they are found.
 */
export function findPairing(
  configDir: string,
  options: { readonly code: string } & LiveClock,
): PairingSession | undefined {
  const wanted = pairingCodeHash(options.code);
  const now = options.now ?? Date.now();
  const alive = options.alive ?? processAlive;
  for (const session of listSessions(configDir)) {
    if (!sameHash(session.codeHash, wanted)) {
      continue;
    }
    if (session.expiresAt <= now || !alive(session.pid)) {
      closePairing(configDir, session.sid);
      continue;
    }
    return session;
  }
  return undefined;
}

export type ClaimResult =
  | { readonly ok: true; readonly claim: PairingClaim }
  | { readonly ok: false; readonly reason: "used" | "gone" | "no_identity" | "store_failed" };

/**
 * Claim a window for `deviceKey` — ONCE, for the whole computer (F5): the file
 * is created with `wx`, so the loser of a race (two `serve` daemons, a replayed
 * request) gets `used` and no second entry can ever appear. The key is the
 * channel's authenticated `remoteStatic`, never a parameter (F18); the SAS is
 * computed from it and the computer's own key, and shown to the human BEFORE
 * anything is written into the registry.
 */
export function claimPairing(
  configDir: string,
  options: {
    readonly sid: string;
    readonly deviceKey: Uint8Array;
    readonly name: string;
  } & LiveClock,
): ClaimResult {
  if (
    !SID_RE.test(options.sid) ||
    options.deviceKey.length !== KEY_BYTES ||
    !isPairingName(options.name)
  ) {
    return { ok: false, reason: "gone" };
  }
  const session = listSessions(configDir).find((s) => s.sid === options.sid);
  const alive = options.alive ?? processAlive;
  const now = options.now ?? Date.now();
  if (session === undefined || session.expiresAt <= now || !alive(session.pid)) {
    return { ok: false, reason: "gone" };
  }
  const identity = readIdentity(configDir);
  if (!identity.ok) {
    return { ok: false, reason: "no_identity" };
  }
  const claim: PairingClaim = {
    publicKey: options.deviceKey,
    name: options.name,
    sas: pairingSas(identity.identity.publicKey, options.deviceKey),
    at: now,
  };
  try {
    mkdirSync(pairingDirOf(configDir), { recursive: true, mode: 0o700 });
    writeFileSync(
      claimPath(configDir, options.sid),
      JSON.stringify({ ...claim, publicKey: encodeBase64Url(claim.publicKey) }),
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") {
      return { ok: false, reason: "used" };
    }
    return { ok: false, reason: "store_failed" };
  }
  return { ok: true, claim };
}

/** What a phone claimed for `sid`, if anything yet. */
export function readClaim(configDir: string, sid: string): PairingClaim | undefined {
  if (!SID_RE.test(sid)) {
    return undefined;
  }
  const read = readJson(claimPath(configDir, sid));
  if (read.kind !== "value" || !isObject(read.value)) {
    return undefined;
  }
  const publicKey = readKey(read.value.publicKey);
  const { name, sas, at } = read.value;
  if (publicKey === undefined || typeof name !== "string" || !isPairingName(name)) {
    return undefined;
  }
  if (typeof sas !== "string" || !/^\d{6}$/.test(sas) || !isStamp(at)) {
    return undefined;
  }
  return { publicKey, name, sas, at };
}

/** The human's answer, written by `pair` after the registry (F3 ordering). */
export function writePairingDecision(
  configDir: string,
  sid: string,
  accepted: boolean,
): DeviceStoreFailure | { readonly ok: true } {
  if (!SID_RE.test(sid)) {
    return failure(pairingDirOf(configDir), "not a pairing session id");
  }
  const path = decisionPath(configDir, sid);
  try {
    writeAtomic(path, JSON.stringify({ v: DEVICE_STORE_VERSION, accepted }));
  } catch (error) {
    return failure(path, (error as Error).message);
  }
  return { ok: true };
}

/** `true`/`false` once the human answered; `undefined` while the answer is pending. */
export function readPairingDecision(configDir: string, sid: string): boolean | undefined {
  if (!SID_RE.test(sid)) {
    return undefined;
  }
  const read = readJson(decisionPath(configDir, sid));
  if (read.kind !== "value" || !isObject(read.value)) {
    return undefined;
  }
  if (read.value.v !== DEVICE_STORE_VERSION || typeof read.value.accepted !== "boolean") {
    return undefined;
  }
  return read.value.accepted;
}

/** Remove a window and everything written for it (`pair`'s exit handler, and the sweep). */
export function closePairing(configDir: string, sid: string): void {
  if (!SID_RE.test(sid)) {
    return;
  }
  for (const path of [
    sessionPath(configDir, sid),
    claimPath(configDir, sid),
    decisionPath(configDir, sid),
  ]) {
    rmSync(path, { force: true });
  }
}

/**
 * Remove windows that can never be used again: expired, or owned by a dead
 * `pair` (F2). Returns how many windows were closed.
 */
export function sweepPairings(configDir: string, options: LiveClock = {}): number {
  const now = options.now ?? Date.now();
  const alive = options.alive ?? processAlive;
  let closed = 0;
  for (const session of listSessions(configDir)) {
    if (session.expiresAt <= now || !alive(session.pid)) {
      closePairing(configDir, session.sid);
      closed++;
    }
  }
  return closed;
}

// ---------------------------------------------------------------------------
// daemon records (`<configDir>/daemons/<pid>.json`)
// ---------------------------------------------------------------------------

/**
 * One running `serve`: where it listens, so `pair` can put reachable addresses
 * in the QR (9d) and task 10 can find its siblings. Written at listen, removed
 * at stop; a stale record is ignored by `readDaemonRecords` (dead pid, P8).
 */
export interface DaemonRecord {
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly cwd: string;
  readonly startedAt: number;
}

export const DAEMON_RECORD_VERSION = 1;

function daemonsDir(configDir: string): string {
  return join(configDir, DAEMONS_DIR);
}

export function writeDaemonRecord(
  configDir: string,
  record: DaemonRecord,
): DeviceStoreFailure | { readonly ok: true } {
  const dir = daemonsDir(configDir);
  const path = join(dir, `${record.pid}.json`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeAtomic(path, JSON.stringify({ v: DAEMON_RECORD_VERSION, ...record }));
  } catch (error) {
    return failure(path, (error as Error).message);
  }
  return { ok: true };
}

export function removeDaemonRecord(configDir: string, pid: number = process.pid): void {
  rmSync(join(daemonsDir(configDir), `${pid}.json`), { force: true });
}

/**
 * Every LIVE daemon's record (dead pids skipped, malformed files ignored), in a
 * DEFINED order — oldest listener first, ties by pid: `readdir` order is not
 * specified, and `pair` puts these addresses in a QR where the order is what a
 * phone tries first.
 */
export function readDaemonRecords(
  configDir: string,
  options: { readonly alive?: (pid: number) => boolean } = {},
): DaemonRecord[] {
  const alive = options.alive ?? processAlive;
  const dir = daemonsDir(configDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: DaemonRecord[] = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match === null) {
      continue;
    }
    const pid = Number(match[1]);
    if (!alive(pid)) {
      continue;
    }
    const read = readJson(join(dir, name));
    if (read.kind !== "value" || !isObject(read.value)) {
      continue;
    }
    const value = read.value;
    if (
      value.v !== DAEMON_RECORD_VERSION ||
      value.pid !== pid ||
      typeof value.host !== "string" ||
      typeof value.port !== "number" ||
      !Number.isInteger(value.port) ||
      typeof value.tls !== "boolean" ||
      typeof value.cwd !== "string" ||
      !isStamp(value.startedAt)
    ) {
      continue;
    }
    records.push({
      pid,
      host: value.host,
      port: value.port,
      tls: value.tls,
      cwd: value.cwd,
      startedAt: value.startedAt,
    });
  }
  return records.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}
