/**
 * docs/feat/mobile-notifications.md Design 6 / slice N4: the ONE Keychain item
 * the app and the Notification Service Extension SHARE, derived in pure code.
 *
 * `tentacle.push.directory` holds exactly what an extension needs to render a
 * push while the app is not running:
 *  - `peers`: per paired computer, its id, its display name and its PINNED public
 *    key (HPKE Auth's sender identity — an envelope that does not authenticate
 *    against one of these is not ours, F4/F9);
 *  - `keys`: this phone's push private keys, current first and the previous one
 *    kept for 24 h after a rotation (F8: pushes already in flight still open).
 *
 * Two rules make it safe to give an extension:
 *  - **No Noise device key, ever.** The stored per-computer record carries
 *    `deviceKey` (this phone's account on that computer); the directory is built
 *    from an ALLOWLIST of fields, so a future field cannot leak into it by
 *    being spread (pinned on the serialized bytes, not on the object).
 *  - **An unknown version is never overwritten.** A newer build's directory is
 *    refused by an older app (AGENTS §7 on-disk rule) — the person is told
 *    "notifications need the newest app" instead of silently muting the
 *    extension of the build they are about to launch.
 *
 * Pure: the Keychain is injected, and time is a parameter.
 */
import { PUSH_KEY_ITEM, type PushKeypair } from "./push-key.ts";

/** The shared item's name. Deliberately NOT `tentacle.push-key`: the extension reads both. */
export const PUSH_DIRECTORY_ITEM = "tentacle.push.directory";

/** The only directory shape this build writes and reads. */
export const PUSH_DIRECTORY_VERSION = 1;

/** How long a rotated push key is kept so in-flight pushes still open (F8, plan C2). */
export const PUSH_KEY_RETENTION_MS = 24 * 60 * 60 * 1000;

/** One paired computer, as the extension may know it: identity and name, no secrets. */
export interface DirectoryPeer {
  /** `b64url(SHA-256("tentacle-push-kid/1" ‖ computerPub))[0..11]` — the envelope's `k`. */
  readonly kid: string;
  readonly computerId: string;
  /** The name the person gave it (the banner's title, Design 1). */
  readonly name: string;
  /** The PINNED public key, base64url: HPKE Auth's `authenticatedBy`. */
  readonly computerKey: string;
}

/** One of this phone's push keys, and from when. */
export interface DirectoryKey {
  readonly priv: string;
  readonly pub: string;
  readonly createdAt: number;
  /** Set when it stopped being the current key: kept until `retiredAt + 24 h`. */
  readonly retiredAt?: number;
}

export interface PushDirectory {
  readonly v: typeof PUSH_DIRECTORY_VERSION;
  readonly peers: readonly DirectoryPeer[];
  readonly keys: readonly DirectoryKey[];
}

/** Where the two shared items live (the app's Keychain adapter, injected). */
export interface DirectoryStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The minimal shape the directory derives from: a stored computer record's PUBLIC half. */
export interface DirectorySourceComputer {
  readonly id: string;
  readonly name: string;
  readonly computerKey: string;
}

/**
 * The `kid` of a pinned computer key (task 16's own function, re-exported shape
 * so the directory cannot drift from the envelope it must match).
 */
export type KidOf = (computerPublicKey: Uint8Array) => string;

/** Parse a stored directory; `undefined` for absent, unreadable, or an unknown version. */
export function parseDirectory(raw: string | null): PushDirectory | undefined {
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
  const candidate = parsed as Partial<PushDirectory>;
  if (candidate.v !== PUSH_DIRECTORY_VERSION) {
    return undefined;
  }
  if (!Array.isArray(candidate.peers) || !Array.isArray(candidate.keys)) {
    return undefined;
  }
  return candidate as PushDirectory;
}

/** What the raw bytes of a directory item say about its version (for the writer's refusal). */
export function directoryVersionOf(raw: string | null): number | undefined {
  if (raw === null) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as { v?: unknown };
    return typeof parsed.v === "number" ? parsed.v : undefined;
  } catch {
    return undefined;
  }
}

/** A push key is usable while it is current, or for 24 h after it was retired (F8). */
export function keyIsLive(key: DirectoryKey, now: number): boolean {
  if (key.retiredAt === undefined) {
    return true;
  }
  return now - key.retiredAt <= PUSH_KEY_RETENTION_MS;
}

/**
 * Derive the whole directory from the app's own truth: the paired computers
 * (public half ONLY — `deviceKey` is never read, so it cannot be written) and
 * the push keys it holds. A retired key past its 24 h is dropped here, which is
 * the only place a key leaves the item.
 */
export function deriveDirectory(input: {
  readonly computers: readonly DirectorySourceComputer[];
  /** The current key, then any retained ones (the app's own rotation record). */
  readonly keys: readonly DirectoryKey[];
  readonly kidOf: KidOf;
  readonly decodeKey: (text: string) => Uint8Array | undefined;
  readonly now: number;
}): PushDirectory {
  const peers: DirectoryPeer[] = [];
  for (const computer of input.computers) {
    const publicKey = input.decodeKey(computer.computerKey);
    if (publicKey === undefined) {
      continue; // an unreadable record keeps its place in the app, not in the extension
    }
    peers.push({
      kid: input.kidOf(publicKey),
      computerId: computer.id,
      name: computer.name,
      computerKey: computer.computerKey,
    });
  }
  return {
    v: PUSH_DIRECTORY_VERSION,
    peers,
    keys: input.keys.filter((key) => keyIsLive(key, input.now)),
  };
}

/**
 * The keys the app holds, current first: the stored key pair, plus any retained
 * one the caller passes. A newly generated key RETIRES the previous one (stamped
 * with `retiredAt`) instead of dropping it, so a push sealed a second earlier
 * still opens (F8).
 */
export function rotateKeys(input: {
  readonly current: PushKeypair;
  readonly retained: readonly DirectoryKey[];
  readonly now: number;
  /** The stored pair BEFORE `current`, when it differs (a fresh rotation). */
  readonly previous?: PushKeypair | undefined;
}): readonly DirectoryKey[] {
  const live = input.retained.filter((key) => keyIsLive(key, input.now));
  const known = live.find((key) => key.priv === input.current.privateKey);
  // The current key: its ORIGINAL `createdAt` when we already knew it (a rewrite
  // is not a rotation), and never retired.
  const current: DirectoryKey = known ?? {
    priv: input.current.privateKey,
    pub: input.current.publicKey,
    createdAt: input.now,
  };
  if (!input.previous || input.previous.privateKey === input.current.privateKey) {
    return known ? live : [current, ...live];
  }
  // A rotation: the previous pair stays, stamped with the moment it stopped being
  // current (kept until `retiredAt + 24 h`, then dropped by `keyIsLive`).
  const previous: DirectoryKey = {
    priv: input.previous.privateKey,
    pub: input.previous.publicKey,
    createdAt: live.find((key) => key.priv === input.previous?.privateKey)?.createdAt ?? input.now,
    retiredAt: live.find((key) => key.priv === input.previous?.privateKey)?.retiredAt ?? input.now,
  };
  return [current, previous, ...live.filter((key) => key.priv !== previous.priv)];
}

/** Why a write was refused. `version` means the Keychain holds a NEWER directory. */
export type DirectoryWriteRefusal = "version";

/**
 * Write the directory, refusing (and TOUCHING NOTHING) when the item holds a
 * version this build does not know: another build's data is never overwritten —
 * the person is told instead (AGENTS §7 on-disk rule).
 */
export async function writeDirectory(
  store: DirectoryStore,
  directory: PushDirectory,
  /** What the persisted bytes should be (injected so a test can pin the exact JSON). */
  serialize: (directory: PushDirectory) => string = (d) => JSON.stringify(d),
): Promise<DirectoryWriteRefusal | "written"> {
  const existing = await store.get(PUSH_DIRECTORY_ITEM);
  const version = directoryVersionOf(existing);
  if (version !== undefined && version !== PUSH_DIRECTORY_VERSION) {
    return "version";
  }
  await store.set(PUSH_DIRECTORY_ITEM, serialize(directory));
  return "written";
}

/** Read the directory (absent/unreadable/unknown version → `undefined`: treat as absent). */
export async function readDirectory(store: DirectoryStore): Promise<PushDirectory | undefined> {
  return parseDirectory(await store.get(PUSH_DIRECTORY_ITEM));
}

/** The push key item's name, re-exported so the two shared items are named in one place. */
export { PUSH_KEY_ITEM };
