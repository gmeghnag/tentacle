import type { LockDelay } from "./app-lock.ts";
/**
 * The lock setting, on disk (docs/feat/mobile-lock.md D3).
 *
 * A versioned record `{v:1, delay}` behind an injected port (`SecureKV`, the
 * same surface `computer-store.ts` uses), so this module has no native import and
 * every rule is tested without a simulator (AGENTS §7).
 *
 * Three fail-closed rules, each pinned by a test:
 * - **An unreadable, missing or unknown-version record reads `5m`** — never
 *   `never` (F11). A broken store must not disable the lock.
 * - **An unknown `v` is left untouched**: a newer build's record is read as
 *   `5m` and NOT overwritten, so a downgraded app cannot erase it (the repo's
 *   versioned-record discipline, AGENTS §7).
 * - **A write failure rejects**, so Settings can say the change did not stick
 *   rather than showing a delay that is not on disk.
 */
import type { SecureKV, SecureSetOptions } from "./computer-store.ts";

/** The Keychain key the setting lives under (one item: this phone's lock delay). */
export const LOCK_SETTING_KEY = "tentacle.app-lock";

/** The record version this build writes AND reads. */
export const LOCK_SETTING_VERSION = 1;

/** The delay a broken or absent record falls back to (F11: never `never`). */
export const DEFAULT_LOCK_DELAY: LockDelay = "5m";

const DELAYS: readonly LockDelay[] = ["immediately", "5m", "1h", "never"];

/** Is `value` one of the four delays? (a closed union read from untrusted bytes) */
export function isLockDelay(value: unknown): value is LockDelay {
  return typeof value === "string" && (DELAYS as readonly string[]).includes(value);
}

/** What a read concluded: the delay to use, and whether the record is safe to overwrite. */
export interface LockSettingRead {
  readonly delay: LockDelay;
  /**
   * `false` for a record this build cannot read (an unknown `v`, or bytes that
   * are not the record): the caller must NOT write over it.
   */
  readonly writable: boolean;
}

export interface LockSettingStore {
  /** The stored delay (or the default): never rejects — the lock must exist at launch. */
  read(): Promise<LockSettingRead>;
  /** Persist a delay. Rejects on a write error (Settings reports it). */
  write(delay: LockDelay): Promise<void>;
}

/** The stored record, or why it cannot be used. */
function parse(raw: string | null): LockSettingRead {
  if (raw === null) {
    // Absent: a fresh install. Nothing to preserve, so writing is fine.
    return { delay: DEFAULT_LOCK_DELAY, writable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Garbage: unreadable but not provably a NEWER build's record... except it
    // is not ours either. Left untouched, like an unknown version (safe side).
    return { delay: DEFAULT_LOCK_DELAY, writable: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { delay: DEFAULT_LOCK_DELAY, writable: false };
  }
  const record = parsed as { v?: unknown; delay?: unknown };
  if (record.v !== LOCK_SETTING_VERSION) {
    // Unknown version (older or newer): read the default, write nothing.
    return { delay: DEFAULT_LOCK_DELAY, writable: false };
  }
  if (!isLockDelay(record.delay)) {
    return { delay: DEFAULT_LOCK_DELAY, writable: false };
  }
  return { delay: record.delay, writable: true };
}

export interface LockSettingStoreDeps {
  readonly kv: SecureKV;
  /** The Keychain accessibility class to write with (injected: no native import here). */
  readonly keychainAccessible: number;
}

/**
 * The store over one `SecureKV` item. A read ERROR resolves the default (and
 * reports `writable: false`): a Keychain that cannot be read is not a reason to
 * leave the app with no lock at all — and not a reason to overwrite the item
 * either.
 */
export function createLockSettingStore(deps: LockSettingStoreDeps): LockSettingStore {
  const options: SecureSetOptions = { keychainAccessible: deps.keychainAccessible };
  return {
    async read(): Promise<LockSettingRead> {
      let raw: string | null;
      try {
        raw = await deps.kv.get(LOCK_SETTING_KEY);
      } catch {
        return { delay: DEFAULT_LOCK_DELAY, writable: false };
      }
      return parse(raw);
    },
    async write(delay: LockDelay): Promise<void> {
      await deps.kv.set(
        LOCK_SETTING_KEY,
        JSON.stringify({ v: LOCK_SETTING_VERSION, delay }),
        options,
      );
    },
  };
}

/**
 * The store, with the unknown-version guard applied to writes: a record this
 * build could not read is never replaced, even when the person asks for a new
 * delay (the newer build's setting must survive). Before the guard trips, the
 * person's choice is kept in memory for the session — the caller renders what
 * `read()` last said, and a refused write is reported.
 */
export interface GuardedLockSettingStore extends LockSettingStore {
  /** True when the last read found a record this build must not overwrite. */
  preserved(): boolean;
}

/**
 * Wrap a store so a write is REFUSED (rejects with `LockSettingPreserved`) while
 * the on-disk record is one this build cannot read. Separate from the plain
 * store so the rule is testable on its own and the adapter stays five lines.
 */
export class LockSettingPreserved extends Error {
  constructor() {
    super("a newer build's app-lock setting is on this phone — left untouched");
    this.name = "LockSettingPreserved";
  }
}

export function guardLockSettingStore(store: LockSettingStore): GuardedLockSettingStore {
  let preserved = false;
  return {
    async read(): Promise<LockSettingRead> {
      const read = await store.read();
      preserved = !read.writable;
      return read;
    },
    async write(delay: LockDelay): Promise<void> {
      if (preserved) {
        throw new LockSettingPreserved();
      }
      await store.write(delay);
    },
    preserved: () => preserved,
  };
}
