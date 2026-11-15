/**
 * The Live Activity registration store — `<configDir>/devices/live/<id>.json`
 * (docs/feat/mobile-live-activity.md Design 4, L5).
 *
 * Task 16's push store with a different record, and for the same reasons
 * (`push-store.ts` states them at length; this file mirrors them deliberately
 * rather than sharing a generic store, because the two records diverge — one
 * holds a push key and a banner token, the other a push-to-start token and the
 * person's switch):
 *
 *  - **One file per device**, written only by the daemon that received it,
 *    atomically — so two `serve` daemons on one computer (F21) converge on the
 *    last `rename` instead of interleaving a list.
 *  - **0600, tmp + rename.** A start token is a bearer credential for a phone's
 *    lock screen; a half-written or world-readable one is worse than none.
 *  - **An unreadable or unknown-version file is SKIPPED, never rewritten**
 *    (AGENTS §7, "on-disk records are versioned separately", F22). That device
 *    is not started this time, one audit line says so, and the bytes stay as
 *    found: a newer daemon's record is not this build's to destroy.
 *  - **Delete is compare-and-delete** — except for the person's own revoke,
 *    which is a separate function on purpose (see {@link forgetLiveRegistration}).
 *
 * **What is NOT here: an activity's update token.** Those live in daemon memory
 * only (Owner Q8): an activity lives ≤ 12 h and a restart's activities go stale
 * anyway (Design 3), so persisting them would buy nothing and put a per-activity
 * credential on disk for no reason.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type LiveActivityStatus,
  type PushEnvironment,
  PushEnvironmentSchema,
} from "@tentacle/protocol";
import { DEVICE_DIR, LIVE_DIR, deviceDir } from "./device-store.ts";

/** The record's own version, apart from `PROTOCOL_VERSION` and `DEVICE_STORE_VERSION`. */
export const LIVE_RECORD_VERSION = 1;
/**
 * `<configDir>/devices/live` — declared in `device-store.ts` with the rest of the
 * layout (so `removeDevices` can use it without importing this module), and
 * re-exported here because this is where a reader looks for it.
 */
export { LIVE_DIR };
/** A device id: 16 hex, exactly as `deviceIdOf` writes it. */
const ID_RE = /^[0-9a-f]{16}$/;
/** The same token rule the wire uses (`DeviceLiveActivityRegisterParamsSchema`). */
const START_TOKEN_RE = /^[0-9a-f]{64,200}$/;

/** One device's Live Activity registration: where to start one, and whether the person wants it. */
export interface LiveRegistration {
  readonly deviceId: string;
  /** The RAW APNs push-to-start token, lowercase hex. */
  readonly startToken: string;
  readonly env: PushEnvironment;
  /** The person's switch (Settings). `false` keeps the record, sends nothing. */
  readonly enabled: boolean;
  readonly registeredAt: number;
}

export type LiveStoreResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly path: string;
      readonly reason: string;
      /** The file is not there at all: the only refusal a caller may act on. */
      readonly missing?: true;
    };

export type LiveRegistrationResult =
  | { readonly ok: true; readonly registration: LiveRegistration; readonly path: string }
  | Extract<LiveStoreResult, { ok: false }>;

/** A file that was NOT usable, and why (one audit line per entry). */
export interface LiveSkip {
  readonly path: string;
  readonly reason: string;
}

/** `<configDir>/devices/live`. */
export function liveDir(configDir: string): string {
  return join(deviceDir(configDir), LIVE_DIR);
}

/** One device's file. The id is validated by every entry point, never trusted from a path. */
export function livePathOf(configDir: string, deviceId: string): string {
  return join(liveDir(configDir), `${deviceId}.json`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `<dir>` at 0700. Never fatal: a failure surfaces at the write. */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** Sibling temp file, then `rename` (atomic replace): a reader never sees half a record. */
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

/**
 * Validate a record read from disk. `undefined` means "not usable" — the caller
 * turns that into a skip, never into an overwrite.
 */
function parseRegistration(deviceId: string, value: unknown): LiveRegistration | undefined {
  if (!isObject(value) || value.v !== LIVE_RECORD_VERSION) {
    return undefined;
  }
  const at = value.registeredAt;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) {
    return undefined;
  }
  if (typeof value.startToken !== "string" || !START_TOKEN_RE.test(value.startToken)) {
    return undefined;
  }
  const env = PushEnvironmentSchema.safeParse(value.env);
  if (!env.success) {
    return undefined;
  }
  // A record written before the switch existed reads as ENABLED: Live Activities
  // are opt-OUT (the person turns them off in Settings), so a missing field must
  // not silently mute a phone that had them on.
  const enabled = value.enabled === undefined ? true : value.enabled === true;
  return {
    deviceId,
    startToken: value.startToken,
    env: env.data,
    enabled,
    registeredAt: at,
  };
}

/**
 * One device's registration. `missing` distinguishes a fresh device (nothing was
 * ever registered) from a file this build cannot read — the first is ordinary,
 * the second is one audit line and no activity.
 */
export function readLiveRegistration(configDir: string, deviceId: string): LiveRegistrationResult {
  if (!ID_RE.test(deviceId)) {
    return { ok: false, path: livePathOf(configDir, deviceId), reason: "not a device id" };
  }
  const path = livePathOf(configDir, deviceId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { ok: false, path, reason: "not registered", missing: true };
    }
    return { ok: false, path, reason: `unreadable: ${(error as Error).message}` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, path, reason: `malformed: ${(error as Error).message}` };
  }
  const registration = parseRegistration(deviceId, value);
  if (registration === undefined) {
    // The bytes are LEFT ALONE: an unknown `v` is a newer build's record, and a
    // bad field is a human's error to fix — either way not ours to rewrite (F22).
    return { ok: false, path, reason: "unsupported record (unknown version or invalid field)" };
  }
  return { ok: true, registration, path };
}

/**
 * Every usable registration, keyed by device id, plus what was skipped. Read at
 * START time (a handful of small files, and a start is rare): the authority
 * snapshot decides WHO a device is, this decides WHERE to start an activity.
 */
export function readLiveRegistrations(configDir: string): {
  readonly registrations: ReadonlyMap<string, LiveRegistration>;
  readonly skipped: readonly LiveSkip[];
} {
  const dir = liveDir(configDir);
  const registrations = new Map<string, LiveRegistration>();
  const skipped: LiveSkip[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No live directory: no device has ever registered. Not an error.
    return { registrations, skipped };
  }
  for (const name of names) {
    const deviceId = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
    if (deviceId === undefined || !ID_RE.test(deviceId)) {
      // A temp file mid-write, or something a human dropped in: not a record.
      continue;
    }
    const read = readLiveRegistration(configDir, deviceId);
    if (read.ok) {
      registrations.set(deviceId, read.registration);
      continue;
    }
    if (read.missing === true) {
      // Vanished between the readdir and the read: not registered, that is all.
      continue;
    }
    skipped.push({ path: read.path, reason: read.reason });
  }
  return { registrations, skipped };
}

/**
 * Write (or replace) one device's registration. The token and env go through
 * the wire's own rules first, so nothing the RPC would refuse can come from here
 * either, and a failure leaves the old record in place.
 */
export function writeLiveRegistration(
  configDir: string,
  input: {
    readonly deviceId: string;
    readonly startToken: string;
    readonly env: string;
    readonly registeredAt: number;
    readonly enabled?: boolean;
  },
): LiveStoreResult {
  if (!ID_RE.test(input.deviceId)) {
    return { ok: false, path: livePathOf(configDir, input.deviceId), reason: "not a device id" };
  }
  const env = PushEnvironmentSchema.safeParse(input.env);
  if (!env.success || !START_TOKEN_RE.test(input.startToken)) {
    return {
      ok: false,
      path: livePathOf(configDir, input.deviceId),
      reason: "invalid start token or environment",
    };
  }
  const path = livePathOf(configDir, input.deviceId);
  const record = {
    v: LIVE_RECORD_VERSION,
    startToken: input.startToken,
    env: env.data,
    enabled: input.enabled ?? true,
    registeredAt: input.registeredAt,
  };
  try {
    ensureDir(liveDir(configDir));
    writeAtomic(path, JSON.stringify(record));
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, reason: `cannot write: ${(error as Error).message}` };
  }
}

/** What a compare-and-delete did. Only `deleted` means the file is gone. */
export type LiveDeleteOutcome = "deleted" | "absent" | "kept-newer-token" | "unreadable";

/**
 * Delete one device's registration, but ONLY if its start token is still
 * `expectedToken` (F13).
 *
 * The caller is a `gone` from APNs, which names the token that failed. Between
 * the send and that answer the phone may have re-registered with a fresh token;
 * deleting then would turn one stale push into a phone that never lights up
 * again, so the file that no longer matches is KEPT and says so.
 */
export function deleteLiveRegistration(
  configDir: string,
  deviceId: string,
  expectedToken: string,
): LiveDeleteOutcome {
  if (!ID_RE.test(deviceId)) {
    return "absent";
  }
  const read = readLiveRegistration(configDir, deviceId);
  if (!read.ok) {
    return read.missing === true ? "absent" : "unreadable";
  }
  if (read.registration.startToken !== expectedToken) {
    return "kept-newer-token";
  }
  try {
    rmSync(read.path, { force: true });
    return "deleted";
  } catch {
    return "unreadable";
  }
}

/**
 * Forget one device's registration, whoever wrote it and whatever token it holds
 * — the `removeDevices` / `devices reset` path (F11/F12).
 *
 * Deliberately SEPARATE from {@link deleteLiveRegistration}: that one is a
 * `gone` from Apple and must not remove a token the phone has just replaced,
 * while this one is an instruction about the DEVICE and has nothing to compare
 * against. `absent` is success — a revoke is idempotent.
 */
export function forgetLiveRegistration(configDir: string, deviceId: string): LiveDeleteOutcome {
  if (!ID_RE.test(deviceId)) {
    return "absent";
  }
  try {
    rmSync(livePathOf(configDir, deviceId), { force: true });
    return "deleted";
  } catch {
    return "unreadable";
  }
}

/**
 * Drop EVERY registration (`devices reset`, F11: a new computer key means no
 * activity can open again, so the files are stale). Returns how many went; a
 * file that cannot be removed is counted as not removed, never thrown.
 */
export function clearLiveRegistrations(configDir: string): number {
  const dir = liveDir(configDir);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) {
      continue;
    }
    try {
      rmSync(join(dir, name), { force: true });
      removed += 1;
    } catch {
      // A file we cannot remove is not a reason to fail a reset.
    }
  }
  return removed;
}

/**
 * What `device/live_activity_register` answers for this device's record: the
 * daemon's own view of why an activity will or will not appear. `relay-off` /
 * `relay-no-la` are the relay's business (the caller supplies whether it has a
 * link and whether that link announced the feature), `off` is the person's
 * switch, and `on` means "a start would be attempted".
 */
export function liveStatusOf(input: {
  readonly enabled: boolean;
  readonly hasRelay: boolean;
  readonly relaySupportsLa: boolean;
}): LiveActivityStatus {
  if (!input.hasRelay) {
    return "relay-off";
  }
  if (!input.relaySupportsLa) {
    return "relay-no-la";
  }
  return input.enabled ? "on" : "off";
}
