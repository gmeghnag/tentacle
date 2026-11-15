/**
 * The push registration store — `<configDir>/devices/push/<id>.json`
 * (docs/feat/mobile-push.md Design 5, slice P5).
 *
 * One file per device, next to `seen/<id>`, and for the same reason: the
 * REGISTRY has one writer (the CLI, under a lock), so a daemon must never
 * read-modify-write it. Each device's registration is its own file, written only
 * by the daemon that received it, atomically — so two daemons on one computer
 * (`serve` for two projects, F22) converge on the last `rename` instead of
 * interleaving a list.
 *
 * The properties this file owns, each with the mutation that would fake it:
 *
 *  - **0600, tmp + rename.** A token is a bearer credential for a phone's lock
 *    screen: a half-written or world-readable one is worse than none. The write
 *    goes through a sibling temp file, so a crash leaves the OLD record.
 *  - **An unreadable or unknown-version file is SKIPPED, never rewritten**
 *    (AGENTS §7, "on-disk records are versioned separately"). That device is
 *    simply not pushed this time, one audit line says so, and the bytes stay
 *    exactly as found — a newer daemon's record is not this build's to destroy.
 *  - **Delete is compare-and-delete.** A `gone` from APNs names the token that
 *    failed; if the file already holds a DIFFERENT (freshly re-registered) one,
 *    the delete is a no-op (F11). An unconditional `rm` here would silently
 *    disable notifications for a phone that had just fixed itself.
 *
 * `PUSH_DIR` lives in `device-store.ts` with the rest of the layout
 * (`SEEN_DIR`, `PAIRING_DIR`), so `removeDevices` can use it without importing
 * this module — the dependency runs one way only (this → `device-store`).
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DevicePushRegisterParamsSchema, type PushEnvironment } from "@tentacle/protocol";
import { PUSH_DIR, deviceDir } from "./device-store.ts";

/** The record's own version, apart from `PROTOCOL_VERSION` and `DEVICE_STORE_VERSION`. */
export const PUSH_RECORD_VERSION = 1;
/** A device id: 16 hex, exactly as `deviceIdOf` writes it (`DEVICE_ID_HEX`). */
const ID_RE = /^[0-9a-f]{16}$/;

/** One device's registration: the APNs token, the Apple host it belongs to, and the device's push key. */
export interface PushRegistration {
  readonly deviceId: string;
  /** The RAW APNs token, lowercase hex (never an Expo token — decision 19). */
  readonly token: string;
  readonly env: PushEnvironment;
  /** The device's per-device X25519 push key, base64url — NOT its Noise key. */
  readonly key: string;
  readonly registeredAt: number;
}

export type PushStoreResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly path: string;
      readonly reason: string;
      /** The file is not there at all: the only refusal a caller may act on. */
      readonly missing?: true;
    };

export type PushRegistrationResult =
  | { readonly ok: true; readonly registration: PushRegistration; readonly path: string }
  | Extract<PushStoreResult, { ok: false }>;

/** A file that was NOT usable, and why (one audit line per entry). */
export interface PushSkip {
  readonly path: string;
  readonly reason: string;
}

/** `<configDir>/devices/push` — `removeDevices` and `devices reset` reach it too. */
export function pushDir(configDir: string): string {
  return join(deviceDir(configDir), PUSH_DIR);
}

/** One device's file. The id is validated by every entry point, never trusted from a path. */
export function pushPathOf(configDir: string, deviceId: string): string {
  return join(pushDir(configDir), `${deviceId}.json`);
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
function parseRegistration(deviceId: string, value: unknown): PushRegistration | undefined {
  if (!isObject(value) || value.v !== PUSH_RECORD_VERSION) {
    return undefined;
  }
  const at = value.registeredAt;
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) {
    return undefined;
  }
  // The same schema the RPC validated with: one definition of a good token, env
  // and key, so a hand-edited file cannot smuggle in something the wire refuses.
  const parsed = DevicePushRegisterParamsSchema.safeParse({
    token: value.token,
    env: value.env,
    key: value.key,
  });
  if (!parsed.success) {
    return undefined;
  }
  return {
    deviceId,
    token: parsed.data.token,
    env: parsed.data.env,
    key: parsed.data.key,
    registeredAt: at,
  };
}

/**
 * One device's registration.
 *
 * `missing` distinguishes a fresh device (nothing was ever registered) from a
 * file this build cannot read — the first is ordinary, the second is one audit
 * line and no push.
 */
export function readPushRegistration(configDir: string, deviceId: string): PushRegistrationResult {
  if (!ID_RE.test(deviceId)) {
    return { ok: false, path: pushPathOf(configDir, deviceId), reason: "not a device id" };
  }
  const path = pushPathOf(configDir, deviceId);
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
    // bad field is a human's error to fix — either way not ours to rewrite (F16).
    return { ok: false, path, reason: "unsupported record (unknown version or invalid field)" };
  }
  return { ok: true, registration, path };
}

/**
 * Every usable registration, keyed by device id, plus what was skipped. Read at
 * PUSH time (it is a handful of small files, and a push is rare): the authority
 * snapshot decides WHO may be pushed to, this decides WHERE.
 */
export function readPushRegistrations(configDir: string): {
  readonly registrations: ReadonlyMap<string, PushRegistration>;
  readonly skipped: readonly PushSkip[];
} {
  const dir = pushDir(configDir);
  const registrations = new Map<string, PushRegistration>();
  const skipped: PushSkip[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // No push directory: no device has ever registered. Not an error.
    return { registrations, skipped };
  }
  for (const name of names) {
    const deviceId = name.endsWith(".json") ? name.slice(0, -".json".length) : undefined;
    if (deviceId === undefined || !ID_RE.test(deviceId)) {
      // A temp file mid-write, or something a human dropped in: not a record.
      continue;
    }
    const read = readPushRegistration(configDir, deviceId);
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
 * Write (or replace) one device's registration. The token, env and key go
 * through the wire's own schema first, so nothing the RPC would refuse can come
 * from here either (F26), and a failure leaves the old record in place (F25).
 */
export function writePushRegistration(
  configDir: string,
  input: {
    readonly deviceId: string;
    readonly token: string;
    readonly env: string;
    readonly key: string;
    readonly registeredAt: number;
  },
): PushStoreResult {
  if (!ID_RE.test(input.deviceId)) {
    return { ok: false, path: pushPathOf(configDir, input.deviceId), reason: "not a device id" };
  }
  const parsed = DevicePushRegisterParamsSchema.safeParse({
    token: input.token,
    env: input.env,
    key: input.key,
  });
  if (!parsed.success) {
    return {
      ok: false,
      path: pushPathOf(configDir, input.deviceId),
      reason: "invalid token, environment or key",
    };
  }
  const path = pushPathOf(configDir, input.deviceId);
  const record = {
    v: PUSH_RECORD_VERSION,
    token: parsed.data.token,
    env: parsed.data.env,
    key: parsed.data.key,
    registeredAt: input.registeredAt,
  };
  try {
    ensureDir(pushDir(configDir));
    writeAtomic(path, JSON.stringify(record));
    return { ok: true, path };
  } catch (error) {
    return { ok: false, path, reason: `cannot write: ${(error as Error).message}` };
  }
}

/** What a compare-and-delete did. Only `deleted` means the file is gone. */
export type PushDeleteOutcome = "deleted" | "absent" | "kept-newer-token" | "unreadable";

/**
 * Delete one device's registration, but ONLY if its token is still
 * `expectedToken` (Design 5's compare-and-delete).
 *
 * The caller is a `push-result: gone` from APNs, which names the token that
 * failed. Between the send and that answer the phone may have re-registered with
 * a fresh token (F11); deleting then would turn one stale push into a silently
 * muted phone, so the file that no longer matches is KEPT and says so.
 */
export function deletePushRegistration(
  configDir: string,
  deviceId: string,
  expectedToken: string,
): PushDeleteOutcome {
  if (!ID_RE.test(deviceId)) {
    return "absent";
  }
  const read = readPushRegistration(configDir, deviceId);
  if (!read.ok) {
    return read.missing === true ? "absent" : "unreadable";
  }
  if (read.registration.token !== expectedToken) {
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
 * Forget one device's registration, whoever wrote it and whatever token it
 * holds — the `device/push_unregister` path (the Settings toggle, slice P7).
 *
 * Deliberately SEPARATE from {@link deletePushRegistration}: that one is a
 * `gone` from Apple and must not remove a token the phone has just replaced
 * (F11), while this one is the device's own instruction and has nothing to
 * compare against. `absent` is success — an unregister is idempotent.
 */
export function forgetPushRegistration(configDir: string, deviceId: string): PushDeleteOutcome {
  if (!ID_RE.test(deviceId)) {
    return "absent";
  }
  const path = pushPathOf(configDir, deviceId);
  try {
    rmSync(path, { force: true });
    return "deleted";
  } catch {
    return "unreadable";
  }
}

/**
 * Drop EVERY registration (`devices reset`, F13: a new computer key means no
 * phone can open a push again, so the files are not merely unusable, they are
 * stale). Returns how many files went; a failure to remove one is counted as
 * not removed, never thrown — the reset itself has already succeeded.
 */
export function clearPushRegistrations(configDir: string): number {
  const dir = pushDir(configDir);
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
