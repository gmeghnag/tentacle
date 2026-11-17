/**
 * What this device has already shown (docs/feat/model-artifacts.md D9, T7):
 * ONE versioned record `{v:1, seen: {"<computerId>/<sessionId>": {lastGalleryAt,
 * opened: [sha…]}}}` behind the `SecureKV` port — the `voice-settings-store.ts`
 * pattern, so this module has no native import and is tested over a fake.
 *
 * Three rules, each of which a naive store gets wrong:
 *
 * 1. **A versioned record, refused when unknown.** An unknown `v` (a newer build
 *    wrote it) reads as NOTHING SEEN and every write is refused with
 *    `ArtifactSeenPreserved`: a downgraded app must not erase what a newer one
 *    remembers — and it must not claim a pod's old artifacts are all new either.
 * 2. **`opened` is bounded.** Five hundred shas per session, oldest dropped
 *    first: the record lives in the Keychain, and a session that presented a
 *    thousand versions must not grow it without limit.
 * 3. **A read error is not a write.** An unreadable Keychain reads as nothing
 *    seen and refuses later writes, exactly like an unknown version: marking
 *    things seen over a store it could not read would lose the real record.
 *
 * The seen set is keyed per COMPUTER **and** session (`sessionKey`): two paired
 * computers can hold session ids that collide, and one computer's `opened` list
 * must never hide another's new artifact.
 */
import type { SecureKV } from "./computer-store.ts";

export const ARTIFACT_SEEN_KEY = "tentacle.artifacts.seen";
export const ARTIFACT_SEEN_VERSION = 1;

/** Most sha256s remembered per session (oldest dropped first). */
export const MAX_OPENED = 500;

export interface ArtifactSeen {
  /** When this device last opened the gallery for this session (daemon clock at the time). */
  readonly lastGalleryAt: number;
  /** Version shas this device has OPENED (the seen rows, newest last). */
  readonly opened: readonly string[];
}

/** Everything the record holds: one entry per computer/session this device looked at. */
export type ArtifactSeenMap = Readonly<Record<string, ArtifactSeen>>;

export const NOTHING_SEEN: ArtifactSeen = { lastGalleryAt: 0, opened: [] };

export interface ArtifactSeenRead {
  readonly seen: ArtifactSeenMap;
  /** `false`: a record this build cannot read (or could not read) — never written over. */
  readonly writable: boolean;
}

export class ArtifactSeenPreserved extends Error {
  constructor() {
    super("a newer build's artifact record is on this phone — left untouched");
    this.name = "ArtifactSeenPreserved";
  }
}

/** The record's key for one session: a computer's ids may repeat another's. */
export function sessionKey(computerId: string, sessionId: string): string {
  return `${computerId}/${sessionId}`;
}

/** The seen entry for one session; NOTHING_SEEN when this device never looked. */
export function seenFor(map: ArtifactSeenMap, key: string): ArtifactSeen {
  return map[key] ?? NOTHING_SEEN;
}

/** The gallery was opened now: everything listed so far is seen. */
export function markGalleryOpened(seen: ArtifactSeen, now: number): ArtifactSeen {
  return { lastGalleryAt: Math.max(seen.lastGalleryAt, now), opened: seen.opened };
}

/** One artifact was opened: its version is seen even if a later open is older. */
export function markArtifactOpened(seen: ArtifactSeen, sha256: string): ArtifactSeen {
  const opened = [...seen.opened.filter((sha) => sha !== sha256), sha256];
  return {
    ...seen,
    opened: opened.length > MAX_OPENED ? opened.slice(opened.length - MAX_OPENED) : opened,
  };
}

const isSha = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

function parseEntry(raw: unknown): ArtifactSeen | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as { lastGalleryAt?: unknown; opened?: unknown };
  if (typeof entry.lastGalleryAt !== "number" || !Number.isFinite(entry.lastGalleryAt)) {
    return null;
  }
  if (!Array.isArray(entry.opened)) {
    return null;
  }
  const opened = entry.opened.filter(isSha);
  return {
    lastGalleryAt: Math.max(0, Math.floor(entry.lastGalleryAt)),
    opened: opened.slice(-MAX_OPENED),
  };
}

function parse(raw: string | null): ArtifactSeenRead {
  if (raw === null) {
    return { seen: {}, writable: true };
  }
  const unreadable: ArtifactSeenRead = { seen: {}, writable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unreadable;
  }
  const record = parsed as { v?: unknown; seen?: unknown };
  if (record.v !== ARTIFACT_SEEN_VERSION) {
    return unreadable;
  }
  if (typeof record.seen !== "object" || record.seen === null) {
    return unreadable;
  }
  const seen: Record<string, ArtifactSeen> = {};
  for (const [key, value] of Object.entries(record.seen as Record<string, unknown>)) {
    const entry = parseEntry(value);
    if (entry !== null) {
      seen[key] = entry;
    }
  }
  return { seen, writable: true };
}

export interface ArtifactSeenStore {
  /** Never rejects: an unreadable record reads as nothing seen (and refuses writes). */
  read(): Promise<ArtifactSeenRead>;
  /** Rejects on a write error, or with `ArtifactSeenPreserved` over an unreadable record. */
  write(seen: ArtifactSeenMap): Promise<void>;
}

export function createArtifactSeenStore(deps: {
  readonly kv: SecureKV;
  readonly keychainAccessible: number;
}): ArtifactSeenStore {
  let preserved = false;
  return {
    async read() {
      let raw: string | null;
      try {
        raw = await deps.kv.get(ARTIFACT_SEEN_KEY);
      } catch {
        preserved = true;
        return { seen: {}, writable: false };
      }
      const read = parse(raw);
      preserved = !read.writable;
      return read;
    },
    async write(seen) {
      if (preserved) {
        throw new ArtifactSeenPreserved();
      }
      await deps.kv.set(ARTIFACT_SEEN_KEY, JSON.stringify({ v: ARTIFACT_SEEN_VERSION, seen }), {
        keychainAccessible: deps.keychainAccessible,
      });
    },
  };
}
