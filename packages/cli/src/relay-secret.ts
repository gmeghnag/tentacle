/**
 * The daemon's relay identity on disk (docs/feat/mobile-relay.md R5a):
 * `<daemonStoreDir>/relay.json` = `{ "v": 1, "secret": "<43 base64url chars>" }`,
 * mode 0600, created once with `O_EXCL` under the store lock.
 *
 * The secret is an ADDRESS credential, never an authority: `id = relayIdOf(secret)`
 * is public (it is in QRs and logs), and every phone stream still needs the
 * Noise handshake against the computer key. What it grants is "receive phone
 * streams for this id"; a leaked one buys a denial of service, and the recovery
 * is a new id (`devices reset`, or delete this file and restart).
 *
 * Why a file per project store: `serve` already holds the store's lock
 * (`serve.ts` `acquireStoreLock`), so exactly one writer exists, and the id is
 * stable across restarts (F15) while a different `cwd` gets its own (one address
 * per daemon).
 *
 * **Versioned honestly** (AGENTS §7 on-disk rule): an unknown `v` is REFUSED —
 * the relay is turned off with a notice and the file is left byte-for-byte as it
 * was, never rewritten or guessed at. The same holds for an unreadable or corrupt
 * file: it is a human's to fix, and a daemon that silently replaced it would hand
 * every phone a new address with no explanation.
 *
 * File I/O in one place, so `serve.ts` only decides what a refusal MEANS.
 */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { RELAY_SECRET_BYTES, decodeBase64Url, encodeBase64Url } from "@tentacle/protocol";

/** The file's name inside the daemon's store directory. */
export const RELAY_SECRET_FILE = "relay.json";
/** The one shape this build writes and reads. */
export const RELAY_SECRET_VERSION = 1;
/** The mode a `relay.json` is created with (owner-only: it holds a credential). */
export const RELAY_SECRET_MODE = 0o600;

/** `<daemonStoreDir>/relay.json`. */
export function relaySecretPath(storeDir: string): string {
  return join(storeDir, RELAY_SECRET_FILE);
}

/** Why a `relay.json` cannot be used. */
export type RelaySecretFailure =
  /** The file says a `v` this build does not know: AGENTS §7, refused and untouched. */
  | "unsupported-version"
  /** It is not `{v:1,secret}` with a 32-byte secret. */
  | "corrupt"
  /** It exists and cannot be read. */
  | "unreadable"
  /** It did not exist and could not be created. */
  | "write-failed";

export type RelaySecretResult =
  | {
      readonly ok: true;
      /** The 32 raw bytes (`relayIdOf` takes these). */
      readonly secret: Uint8Array;
      readonly path: string;
      /** `true` when this call created the file (a fresh id). */
      readonly created: boolean;
    }
  | {
      readonly ok: false;
      readonly path: string;
      readonly reason: RelaySecretFailure;
      /** One line for the notice: what is wrong, and that nothing was changed. */
      readonly detail: string;
    };

/**
 * The relay secret of the store at `storeDir`, created on first use.
 *
 * `random` is injected so a test can pin the bytes; production passes nothing
 * (32 cryptographically random bytes from `crypto.getRandomValues`).
 */
export function readRelaySecret(
  storeDir: string,
  options: { readonly random?: (bytes: number) => Uint8Array } = {},
): RelaySecretResult {
  const path = relaySecretPath(storeDir);
  const read = tryRead(path);
  if (read.kind === "unreadable") {
    return {
      ok: false,
      path,
      reason: "unreadable",
      detail: `cannot read ${path}: ${read.why}; leaving it untouched`,
    };
  }
  return read.kind === "present"
    ? parseSecret(path, read.text)
    : createSecret(path, options.random);
}

type ReadAttempt =
  | { readonly kind: "missing" }
  | { readonly kind: "present"; readonly text: string }
  | { readonly kind: "unreadable"; readonly why: string };

/**
 * The file's text, or `missing` when it does not exist (the normal first run).
 * Any OTHER failure is `unreadable`, never "missing": a permission problem must
 * not silently mint a new id.
 */
function tryRead(path: string): ReadAttempt {
  try {
    return { kind: "present", text: readFileSync(path, "utf8") };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", why: error instanceof Error ? error.message : String(error) };
  }
}

/** The file's contents, validated: an unknown `v` or a bad secret is a REFUSAL, not a repair. */
function parseSecret(path: string, text: string): RelaySecretResult {
  const untouched = (reason: RelaySecretFailure, detail: string): RelaySecretResult => ({
    ok: false,
    path,
    reason,
    detail: `${detail}; leaving it untouched`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return untouched("corrupt", `${path} is not JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return untouched("corrupt", `${path} is not an object`);
  }
  const record = parsed as { v?: unknown; secret?: unknown };
  if (typeof record.v !== "number") {
    return untouched("corrupt", `${path} has no version`);
  }
  if (record.v !== RELAY_SECRET_VERSION) {
    // AGENTS §7: an unknown on-disk version is refused, never half-loaded — and
    // a newer tentacle's file must not be overwritten by an older one.
    return untouched(
      "unsupported-version",
      `${path} is version ${String(record.v)}, this tentacle writes ${RELAY_SECRET_VERSION}`,
    );
  }
  if (typeof record.secret !== "string") {
    return untouched("corrupt", `${path} has no secret`);
  }
  const secret = decodeBase64Url(record.secret);
  if (secret === undefined || secret.length !== RELAY_SECRET_BYTES) {
    return untouched("corrupt", `${path} does not hold a ${RELAY_SECRET_BYTES}-byte secret`);
  }
  return { ok: true, secret, path, created: false };
}

/**
 * Create the file with `O_EXCL` and mode 0600, so two would-be writers (which the
 * store lock already prevents) cannot each mint a different id, and the secret is
 * never world-readable even for an instant.
 */
function createSecret(path: string, random?: (bytes: number) => Uint8Array): RelaySecretResult {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // The `open` below reports it with the reason that matters.
  }
  const secret = random
    ? random(RELAY_SECRET_BYTES)
    : crypto.getRandomValues(new Uint8Array(RELAY_SECRET_BYTES));
  if (secret.length !== RELAY_SECRET_BYTES) {
    throw new Error(`relay secret: expected ${RELAY_SECRET_BYTES} bytes, got ${secret.length}`);
  }
  const body = `${JSON.stringify({ v: RELAY_SECRET_VERSION, secret: encodeBase64Url(secret) }, null, 2)}\n`;
  let fd: number;
  try {
    fd = openSync(path, "wx", RELAY_SECRET_MODE);
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") {
      // Created between the read and this open: the other writer's secret wins
      // (one id per store, whichever won the race), so re-read instead of ours.
      const raced = tryRead(path);
      if (raced.kind === "present") {
        return parseSecret(path, raced.text);
      }
    }
    return {
      ok: false,
      path,
      reason: "write-failed",
      detail: `cannot create ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    writeSync(fd, body);
    // Durability: a crash right after `pair` must not leave a phone holding an
    // address whose secret never reached the disk (a new id on the restart).
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    return {
      ok: false,
      path,
      reason: "write-failed",
      detail: `cannot write ${path}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  closeSync(fd);
  return { ok: true, secret, path, created: true };
}
