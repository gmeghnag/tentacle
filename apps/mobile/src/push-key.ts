import { encodeBase64Url } from "@tentacle/protocol";
/**
 * This phone's per-device PUSH key (docs/feat/mobile-push.md slice P9, Design 7;
 * decision 8: a Notification Service Extension decrypts with a key exchanged at
 * pairing — task 17).
 *
 * Three properties, each load-bearing:
 *
 *  - **It is NOT the Noise device key.** The extension that opens a push never
 *    holds the key that authenticates the device to a computer: it has this
 *    separate X25519 key and nothing else (the plan's Trust section). So a
 *    compromised extension could read notifications and still not become the
 *    phone on any session.
 *  - **One key per phone, not per computer.** The envelope names the COMPUTER
 *    (`k`, the sender's key id), and this key is the recipient of every one: an
 *    extension cannot tell which computer sent a push before decrypting, so it
 *    must be able to try them all with one key.
 *  - **It lives in the shared Keychain access group** with
 *    `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: the extension runs while the phone is
 *    locked, so `WHEN_UNLOCKED` would fail exactly when a push arrives, and
 *    iCloud-syncing it would let a restored backup decrypt another phone's
 *    notifications (decision 3's spirit).
 *
 * Pure: the Keychain and the randomness are injected, so the rules are tested
 * without a simulator.
 */
import { publicKeyOf } from "@tentacle/transport/push";

/** What the Keychain needs to FIND an item too: the access group is part of its key. */
export interface PushKeyLookup {
  readonly accessGroup: string;
}

/** The Keychain surface a push key needs (a subset of `SecureKV`, plus the access group). */
export interface PushKeyStore {
  get(key: string, options: PushKeyLookup): Promise<string | null>;
  set(key: string, value: string, options: PushKeySetOptions): Promise<void>;
  delete(key: string, options: PushKeyLookup): Promise<void>;
}

/** What every write carries: the accessibility class AND the access group. */
export interface PushKeySetOptions extends PushKeyLookup {
  readonly keychainAccessible: number;
}

/**
 * The Keychain item's name. Distinct from the computer items on purpose: this is
 * the one secret the extension reads, and `tentacle.push-key` names it for an
 * audit of the extension's keychain access.
 */
export const PUSH_KEY_ITEM = "tentacle.push-key";

/**
 * The access group the app and the extension share. It must match `app.json`'s
 * `keychain-access-groups` entry (`$(AppIdentifierPrefix)so.tentacle.app`), so
 * it is the bundle id — the `$(AppIdentifierPrefix)` half is resolved by the
 * build, not by JS (a JS-side prefix would be a second source of truth for it).
 */
export const PUSH_KEY_ACCESS_GROUP = "so.tentacle.app";

/** The record this build writes AND reads; anything else is "no key" (never guessed). */
export const PUSH_KEY_VERSION = 1;

/** A key pair, both halves base64url (the private half never leaves the Keychain's value). */
export interface PushKeypair {
  /** 32-byte X25519 private key, base64url. */
  readonly privateKey: string;
  /** Its public half, base64url — what `device/push_register` sends. */
  readonly publicKey: string;
}

interface PushKeyRecord {
  readonly v: number;
  readonly privateKey: string;
  readonly publicKey: string;
}

/** Randomness for a new key (the app passes `expo-crypto`'s `getRandomBytes`). */
export type PushRandom = (length: number) => Uint8Array;

export interface PushKeyDeps {
  readonly store: PushKeyStore;
  readonly random: PushRandom;
  readonly keychainAccessible: number;
  /** Defaults to {@link PUSH_KEY_ACCESS_GROUP}; injected so a test asserts it is passed through. */
  readonly accessGroup?: string;
}

/** A stored record, or `undefined` when absent / unreadable / of an unknown version. */
function parseKeyRecord(raw: string | null): PushKeypair | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }
  const record = parsed as Partial<PushKeyRecord>;
  if (
    record.v !== PUSH_KEY_VERSION ||
    typeof record.privateKey !== "string" ||
    typeof record.publicKey !== "string"
  ) {
    return undefined;
  }
  return { privateKey: record.privateKey, publicKey: record.publicKey };
}

/**
 * This phone's push key pair, generating and storing it on first use.
 *
 * A key that exists is RETURNED, never replaced: replacing it would silently
 * mute every computer this phone is registered with until they re-register
 * (F12's other direction). An unreadable or unknown-version item is replaced —
 * the alternative is no notifications ever, and there is nothing to preserve:
 * the old key can only be used by an extension that this app build does not have.
 */
export async function ensurePushKeypair(deps: PushKeyDeps): Promise<PushKeypair> {
  const accessGroup = deps.accessGroup ?? PUSH_KEY_ACCESS_GROUP;
  // The group is part of the item's KEY on iOS (`kSecAttrAccessGroup`), not just
  // a write attribute: reading it back without the same group finds nothing.
  const raw = await deps.store.get(PUSH_KEY_ITEM, { accessGroup });
  const existing = parseKeyRecord(raw);
  if (existing !== undefined) {
    return existing;
  }
  const privateKey = new Uint8Array(deps.random(32));
  const keypair: PushKeypair = {
    privateKey: encodeBase64Url(privateKey),
    publicKey: encodeBase64Url(publicKeyOf(privateKey)),
  };
  const record: PushKeyRecord = { v: PUSH_KEY_VERSION, ...keypair };
  await deps.store.set(PUSH_KEY_ITEM, JSON.stringify(record), {
    keychainAccessible: deps.keychainAccessible,
    accessGroup,
  });
  return keypair;
}

/** Forget it (a full reset). The next `ensurePushKeypair` generates a new one. */
export async function deletePushKeypair(
  deps: Pick<PushKeyDeps, "store" | "accessGroup">,
): Promise<void> {
  await deps.store.delete(PUSH_KEY_ITEM, {
    accessGroup: deps.accessGroup ?? PUSH_KEY_ACCESS_GROUP,
  });
}
