/**
 * The phone's artifact cache: a pure LRU PLAN (docs/feat/model-artifacts.md D9,
 * T7.4) over an injected file port — bytes land in
 * `FileSystem.cacheDirectory/artifacts/<computerId>/<sha256>`, content-addressed.
 *
 * Why content-addressed: two sessions that present the same bytes need ONE copy,
 * and a re-present of unchanged bytes (the daemon's own dedupe) must not write a
 * second file. Why a PLAN and not a store: what to drop, and what must never be
 * dropped, is a decision with a trap — the artifact a viewer currently HOLDS is
 * the one entry eviction must skip, even when it is the least recently used.
 *
 * The cap is 200 MB per computer (the owner's number). A single version can be
 * 20 MiB, so the plan drops as many as it takes and, when even that is not
 * enough, says `wontFit` rather than holding a file over the cap.
 */
export const ARTIFACT_CACHE_BYTES = 200 * 1024 * 1024;

/** One cached file: its content hash, its size, and when it was last used (ms). */
export interface CacheEntry {
  readonly sha256: string;
  readonly size: number;
  /** A monotonic counter or a clock: only the ORDER matters, never the value. */
  readonly usedAt: number;
}

export interface CacheState {
  readonly entries: readonly CacheEntry[];
}

export const EMPTY_CACHE: CacheState = { entries: [] };

/** What the caller does: write the new file, then remove `evict` (in that order). */
export interface CachePlan {
  /** Files to delete, least recently used first. */
  readonly evict: readonly string[];
  /** The cache after this step (the new entry included, the evicted ones gone). */
  readonly state: CacheState;
  /** The new version cannot fit even with everything evictable gone. */
  readonly wontFit: boolean;
}

/** Total bytes held. */
export function cacheBytes(state: CacheState): number {
  return state.entries.reduce((sum, entry) => sum + entry.size, 0);
}

/**
 * Plan the arrival of `incoming`: keep `keep` (the sha a viewer currently holds)
 * out of the eviction list, drop the least recently used first, and report what
 * to delete. A re-arrival of a sha already held is only a touch (no write, no
 * eviction) — the bytes are the same by construction.
 */
export function planCache(
  state: CacheState,
  incoming: { readonly sha256: string; readonly size: number },
  keep: string | null,
  now: number,
  cap: number = ARTIFACT_CACHE_BYTES,
): CachePlan {
  const held = state.entries.find((entry) => entry.sha256 === incoming.sha256);
  if (held !== undefined) {
    const touched: CacheState = {
      entries: state.entries.map((entry) =>
        entry.sha256 === incoming.sha256 ? { ...entry, usedAt: now } : entry,
      ),
    };
    return { evict: [], state: touched, wontFit: false };
  }
  if (incoming.size > cap) {
    return { evict: [], state, wontFit: true };
  }
  const next = [...state.entries, { sha256: incoming.sha256, size: incoming.size, usedAt: now }];
  let total = cacheBytes({ entries: next });
  const oldestFirst = [...state.entries].sort(
    (a, b) => a.usedAt - b.usedAt || a.sha256.localeCompare(b.sha256),
  );
  const evict: string[] = [];
  for (const entry of oldestFirst) {
    if (total <= cap) {
      break;
    }
    // The version a viewer is holding is never evicted: it is about to be read.
    if (entry.sha256 === keep || entry.sha256 === incoming.sha256) {
      continue;
    }
    evict.push(entry.sha256);
    total -= entry.size;
  }
  const evicted = new Set(evict);
  const wontFit = total > cap;
  // A version that cannot fit is NOT taken: the caller must not write it, so the
  // state it gets back holds only what is already there.
  const entries = next.filter((entry) => !evicted.has(entry.sha256));
  return {
    evict,
    state: {
      entries: wontFit ? entries.filter((entry) => entry.sha256 !== incoming.sha256) : entries,
    },
    wontFit,
  };
}

/** A viewer opened a cached file: it is now the most recently used (and must be kept). */
export function touch(state: CacheState, sha256: string, now: number): CacheState {
  if (!state.entries.some((entry) => entry.sha256 === sha256)) {
    return state;
  }
  return {
    entries: state.entries.map((entry) =>
      entry.sha256 === sha256 ? { ...entry, usedAt: now } : entry,
    ),
  };
}

/** A file is gone (the person deleted the session, or a write failed): forget it. */
export function forget(state: CacheState, sha256: string): CacheState {
  const entries = state.entries.filter((entry) => entry.sha256 !== sha256);
  return entries.length === state.entries.length ? state : { entries };
}

/**
 * Is every sha of `list` still cached? The session-delete step uses this to
 * remove a computer's directory only when nothing another session needs lives in
 * it (the cache is content-addressed, so files are shared).
 */
export function missingFrom(
  state: CacheState,
  list: readonly { readonly sha256: string }[],
): readonly string[] {
  const held = new Set(state.entries.map((entry) => entry.sha256));
  return list.map((meta) => meta.sha256).filter((sha) => !held.has(sha));
}

/** The directory holding one computer's cached artifacts (forward slashes, RN's form). */
export function cacheDir(computerId: string): string {
  // A computer id is a UUID-ish slug from the daemon; a separator in it would
  // escape the directory, so it is reduced to its safe characters. A DOT-ONLY
  // result is not a name at all, though: `artifacts/..` IS the cache root (its
  // parent), so the per-computer delete would wipe every computer's cache — each
  // dot of such a segment becomes `_`, and an empty id becomes one `_`.
  const safe = computerId.replace(/[^A-Za-z0-9._-]/g, "_");
  const name = safe === "" ? "_" : safe.replace(/^\.+$/, (dots) => "_".repeat(dots.length));
  return `artifacts/${name}`;
}

/** The cached copy's path for one version: content-addressed, never the model's name. */
export function cachePath(computerId: string, sha256: string): string {
  return `${cacheDir(computerId)}/${sha256}`;
}

/** The Name a Share sheet shows: the title's own extension, else the kind's (`other` only). */
export function shareName(title: string, fallbackExt: string): string {
  const base = title.replace(/[/\\:*?"<>|]/g, "_").trim();
  const dot = base.lastIndexOf(".");
  if (dot > 0 && /^[A-Za-z0-9]{1,5}$/.test(base.slice(dot + 1))) {
    return base;
  }
  return base === "" ? `artifact.${fallbackExt}` : `${base}.${fallbackExt}`;
}
