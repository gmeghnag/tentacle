/**
 * The Notifications switch, on disk (docs/feat/mobile-push.md P9, review round 1
 * finding H1).
 *
 * The switch is the PHONE's decision, not a computer's (Settings has one row, and
 * `setEnabledForAll` reaches every paired computer), so it lives in ONE Keychain
 * item of its own — not in a computer's record, which a re-pair replaces.
 *
 * A versioned record `{v:1, enabled}` behind an injected port (`SecureKV`, the
 * same surface `computer-store.ts` and `lock-settings-store.ts` use), so this
 * module has no native import and every rule is testable without a simulator
 * (AGENTS §7), with that store's three rules:
 * - **absent, unreadable or unknown-version reads `enabled: true`** — never off.
 *   Off is a decision the PERSON made; a Keychain this build cannot read is not
 *   evidence of one, and defaulting off would mute a phone silently.
 * - **an unknown `v` is never overwritten**: a newer build's record is read as
 *   the default and left alone (the repo's versioned-record discipline).
 * - **a write REJECTS on a store error**, so the caller can keep the decision in
 *   memory for the session instead of believing it landed.
 */
import type { SecureKV, SecureSetOptions } from "./computer-store.ts";

/** The Keychain key the switch lives under (one item: this phone's decision). */
export const PUSH_TOGGLE_KEY = "tentacle.push-enabled";

/** The record version this build writes AND reads. */
export const PUSH_TOGGLE_VERSION = 1;

/** What a read concluded: the decision to use, and whether the record is safe to overwrite. */
export interface PushToggleRead {
  readonly enabled: boolean;
  /**
   * `false` for a record this build cannot read (an unknown `v`, or bytes that
   * are not the record): the caller must NOT write over it.
   */
  readonly writable: boolean;
}

export interface PushToggleStore {
  /** The stored decision (or the default). Never rejects: the row must render at launch. */
  read(): Promise<PushToggleRead>;
  /** Persist a decision. Rejects on a write error (the caller keeps it in memory). */
  write(enabled: boolean): Promise<void>;
}

/** The stored record, or why it cannot be used. */
function parse(raw: string | null): PushToggleRead {
  if (raw === null) {
    // Absent: a fresh install. Nothing to preserve, so writing is fine.
    return { enabled: true, writable: true };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Garbage: not ours, so left untouched, like an unknown version (safe side).
    return { enabled: true, writable: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { enabled: true, writable: false };
  }
  const record = parsed as { v?: unknown; enabled?: unknown };
  if (record.v !== PUSH_TOGGLE_VERSION) {
    // Unknown version (older or newer): read the default, write nothing.
    return { enabled: true, writable: false };
  }
  if (typeof record.enabled !== "boolean") {
    return { enabled: true, writable: false };
  }
  return { enabled: record.enabled, writable: true };
}

export interface PushToggleStoreDeps {
  readonly kv: SecureKV;
  /** The Keychain accessibility class to write with (injected: no native import here). */
  readonly keychainAccessible: number;
}

/**
 * The store over one `SecureKV` item. A READ error resolves the default and
 * reports `writable: false`: a Keychain that cannot be read is not a reason to
 * mute the phone, and not a reason to overwrite the item either.
 */
export function createPushToggleStore(deps: PushToggleStoreDeps): PushToggleStore {
  const options: SecureSetOptions = { keychainAccessible: deps.keychainAccessible };
  return {
    async read(): Promise<PushToggleRead> {
      let raw: string | null;
      try {
        raw = await deps.kv.get(PUSH_TOGGLE_KEY);
      } catch {
        return { enabled: true, writable: false };
      }
      return parse(raw);
    },
    async write(enabled: boolean): Promise<void> {
      await deps.kv.set(
        PUSH_TOGGLE_KEY,
        JSON.stringify({ v: PUSH_TOGGLE_VERSION, enabled }),
        options,
      );
    },
  };
}
