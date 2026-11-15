/**
 * docs/feat/mobile-notifications.md Design 6 / slice N4: the THIN adapter that
 * keeps `tentacle.push.directory` (and its seen-answers sibling) in the SHARED
 * Keychain access group, next to this phone's push key (`push-key.ts`).
 *
 * It is thin on purpose (AGENTS §7: logic in pure modules, an adapter only
 * binds): every rule — the allowlist that keeps `deviceKey` out, the version
 * refusal, the 24 h key retention — lives in `push-directory.ts` and is tested
 * without a phone. What is HERE is the two things that need the device:
 *  - the access group (part of an item's KEY on iOS, so it must be on every
 *    call: `secure-kv.ts`'s `pushKeychain` is that one adapter);
 *  - the app's own truth (the computer store + the push key + the rotation
 *    record), read and written in the right order.
 *
 * The rewrite triggers are Design 6's: a computer-store change (pair, re-pair,
 * remove — `computer-memory.ts` is where the app already reacts to a replaced
 * record) and a push-key rotation.
 */
import { decodeBase64Url } from "@tentacle/protocol";
import { pushKeyId } from "@tentacle/transport/push";
import type { ComputerEntry, ComputerStore, PairedComputer } from "./computer-store.ts";
import {
  type DirectoryKey,
  type DirectoryStore,
  deriveDirectory,
  readDirectory,
  writeDirectory,
} from "./push-directory.ts";
import { ensurePushKeypair } from "./push-key.ts";
import type { PushKeyStore, PushKeypair } from "./push-key.ts";

/** The shared group of the notification items: the app's own bundle-id group (plan C1). */
export const PUSH_DIRECTORY_ACCESS_GROUP = "so.tentacle.app";

/**
 * A `DirectoryStore` over a shared-group Keychain. Pure: the Keychain surface and
 * the accessibility class are INJECTED (`secure-kv.ts` holds the one native
 * adapter), so this file is testable and keeps a single place that can drop an
 * iOS security option.
 */
export function directoryStore(
  store: PushKeyStore,
  keychainAccessible: number,
  accessGroup: string = PUSH_DIRECTORY_ACCESS_GROUP,
): DirectoryStore {
  return {
    get: (key) => store.get(key, { accessGroup }),
    set: (key, value) => store.set(key, value, { keychainAccessible, accessGroup }),
  };
}

/** What a rewrite came to: `written`, or `version` (a newer build's item, left untouched). */
export type DirectoryRewrite = "written" | "version";

/**
 * Rebuild the directory from the app's truth and store it. Called on every
 * computer-store change and on a push-key rotation; cheap enough to be
 * unconditional (a few hundred bytes, one Keychain write).
 *
 * A refused version is RETURNED, never thrown: the caller shows "notifications
 * need the newest app" and the item keeps the newer build's bytes (AGENTS §7).
 */
export async function rewritePushDirectory(deps: {
  readonly store: ComputerStore;
  /** The shared-group Keychain, injected (`directoryStore(...)` from the app's adapter). */
  readonly directory: DirectoryStore;
  /** The push-key Keychain (the shared group again). */
  readonly keys: PushKeyStore;
  /** `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, injected (never a native import here). */
  readonly keychainAccessible: number;
  readonly random: (length: number) => Uint8Array;
  readonly now?: number;
}): Promise<DirectoryRewrite> {
  const now = deps.now ?? Date.now();
  const computers = await deps.store.list();
  // A computer whose item is unreadable (F-K2) has no pinned key to give: it is
  // absent from the directory, so nothing can be authenticated as it.
  const paired = computers.filter(
    (entry): entry is Extract<ComputerEntry, { state: "paired" }> => entry.state === "paired",
  );
  const keypair: PushKeypair = await ensurePushKeypair({
    store: deps.keys,
    random: deps.random,
    keychainAccessible: deps.keychainAccessible,
  });
  // The retained keys are the ones already in the item that are NOT the current
  // one: the previous build's rotation record, kept until its 24 h is up (F8).
  const existing = await readDirectory(deps.directory);
  const retained: DirectoryKey[] = (existing?.keys ?? []).filter(
    (key) => key.priv !== keypair.privateKey,
  );
  const derived = deriveDirectory({
    computers: paired.map((entry) => publicHalf(entry.computer)),
    keys: [currentKey(keypair, retained, now), ...retained],
    kidOf: pushKeyId,
    decodeKey: decodeBase64Url,
    now,
  });
  return writeDirectory(deps.directory, derived);
}

/** A stored computer's PUBLIC half only — `deviceKey` is not read, so it cannot be written. */
function publicHalf(computer: PairedComputer): {
  id: string;
  name: string;
  computerKey: string;
} {
  return { id: computer.id, name: computer.name, computerKey: computer.computerKey };
}

/** The current key, keeping its original `createdAt` when the item already knew it. */
function currentKey(
  keypair: { privateKey: string; publicKey: string },
  retained: readonly DirectoryKey[],
  now: number,
): DirectoryKey {
  const known = retained.find((key) => key.priv === keypair.privateKey);
  return known ?? { priv: keypair.privateKey, pub: keypair.publicKey, createdAt: now };
}

/**
 * The key material and pinned computers an ANSWER needs (Design 3/4): the push
 * private keys (current, then ≤ 24 h retired → F8) and each paired computer's
 * pinned key, read from the SAME shared item the extension uses. `undefined`
 * keys mean "this phone has not written its directory yet": nothing can be
 * verified, so every action refuses `unverified` (which is the honest answer).
 */
export async function readAnswerMaterial(directory: DirectoryStore): Promise<{
  readonly pushKeys: readonly { privateKey: string }[];
  readonly peers: readonly { id: string; computerKey: string }[];
}> {
  const stored = await readDirectory(directory);
  if (!stored) {
    return { pushKeys: [], peers: [] };
  }
  return {
    pushKeys: stored.keys.map((key) => ({ privateKey: key.priv })),
    peers: stored.peers.map((peer) => ({ id: peer.computerId, computerKey: peer.computerKey })),
  };
}
