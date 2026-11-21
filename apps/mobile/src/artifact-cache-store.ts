/**
 * The phone's artifact cache, made real (docs/feat/model-artifacts.md D9;
 * Review round 3's finding 1): `artifact-cache.ts` is the pure LRU PLAN, this is
 * the STORE that obeys it — the 200 MB cap, the "too big to keep" note, the
 * named copy Share hands over, and the delete when a computer is unpaired.
 *
 * Why it exists at all: the plan was tested while nothing called it, so the
 * viewer wrote straight into `Caches/artifacts/<computer>/<sha256>` and the
 * phone kept every byte it ever read — including after the person unpaired the
 * computer those bytes came from. A decision nobody applies is not a decision.
 *
 * Two rules that shape the code:
 *
 * 1. **The state is the DISK, not a memory of it.** `state()` lists the
 *    directory and counts the files that are versions (a 64-hex name); the
 *    plan's `usedAt` is the file's own modification time. A cache that trusts an
 *    in-memory map forgets what an earlier run wrote and can never evict it.
 * 2. **The file a viewer HOLDS is never evicted** (`hold`). It is the one entry
 *    eviction must skip even when it is the least recently used, because it is
 *    about to be read.
 *
 * Port-shaped (`CacheFiles`) so every rule is testable under `bun test`; the
 * expo binding is `artifact-cache-expo.ts` (the `outbox-fs-expo.ts` pattern).
 */
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  ARTIFACT_CACHE_BYTES,
  type CacheState,
  EMPTY_CACHE,
  cacheDir,
  cachePath,
  planCache,
  shareName,
} from "./artifact-cache.ts";
import { cacheStep, tooBigNote } from "./artifact-open.ts";

/** A cached version's file name: the content hash, plus the type's extension. */
const VERSION_RE = /^([0-9a-f]{64})(?:\.[A-Za-z0-9]{1,6})?$/;

/** One file the store can see: its name, its bytes and when it was last used. */
export interface CacheFile {
  readonly name: string;
  readonly size: number;
  /** Modification time (ms); only the ORDER between files matters. */
  readonly usedAt: number;
}

/** The filesystem, as much of it as the store needs (sync: a phone's cache dir is small). */
export interface CacheFiles {
  /** The files directly inside `dir`; an absent directory lists empty. */
  list(dir: string): readonly CacheFile[];
  write(path: string, bytes: Uint8Array): void;
  copy(from: string, to: string): void;
  remove(path: string): void;
  /** Delete `dir` and everything in it; a missing directory is not an error. */
  removeDir(dir: string): void;
  mkdir(dir: string): void;
  uriFor(path: string): string;
}

/** One version's arrival: what was written, where it is, and what to say. */
export interface PutResult {
  /** `false` when the bytes were NOT kept (too big, or nothing changed). */
  readonly written: boolean;
  /** `file:` uri of the kept copy, or `null` when it was not kept. */
  readonly uri: string | null;
  /** The one-line note for the viewer (`tooBigNote`), or `null` when it fits. */
  readonly note: string | null;
}

/** A copy named for a person: what the Share sheet hands over (never a hash). */
export interface CachedCopy {
  readonly uri: string;
  readonly name: string;
}

export interface ArtifactCache {
  /** Keep one version, evicting the least recently used as the cap requires. */
  put(computerId: string, meta: ArtifactMeta, bytes: Uint8Array): PutResult;
  /** The version a viewer is showing (`null` once it closes): never evicted. */
  hold(computerId: string, sha256: string | null): void;
  /**
   * The `file:` uri of a version already kept here, or `null` (never cached,
   * evicted, too big): a card's preview is made from it with no dial.
   */
  uriOf(computerId: string, meta: ArtifactMeta): string | null;
  /** A `<sanitized title>.<ext>` copy for Share, or `null` when nothing is cached. */
  shareCopy(computerId: string, meta: ArtifactMeta): CachedCopy | null;
  /** The pairing is gone: the whole directory, share copies included. */
  forgetComputer(computerId: string): void;
  /** What the plan would work from, read off the disk. */
  state(computerId: string): CacheState;
  /** The cap this store enforces (the owner's 200 MB unless a test says otherwise). */
  readonly cap: number;
}

/**
 * The extension a saved/shared copy should carry: the TYPE's, since the cache's
 * own file name is a hash — a `.zip` arriving as `3f2a…e9` cannot be opened by
 * the app that receives it, and WKWebView picks a PDF's renderer by extension.
 */
const MIME_EXT: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/octet-stream": "bin",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "text/html": "html",
  "text/markdown": "md",
  "text/plain": "txt",
};

/** The kind's extension when the type is not one this build knows. */
const KIND_EXT: Readonly<Record<string, string>> = {
  image: "png",
  pdf: "pdf",
  svg: "svg",
  html: "html",
  markdown: "md",
  text: "txt",
  other: "bin",
};

export function artifactFileExt(meta: ArtifactMeta): string {
  return MIME_EXT[meta.mimeType] ?? KIND_EXT[meta.kind] ?? "bin";
}

export function createArtifactCache(deps: {
  readonly files: CacheFiles;
  readonly now: () => number;
  readonly cap?: number;
}): ArtifactCache {
  const cap = deps.cap ?? ARTIFACT_CACHE_BYTES;
  /** The version each computer's open viewer is holding, if any. */
  const holding = new Map<string, string>();

  /**
   * The version a sha lives as on disk, extension included. The byte count and
   * the ORDER come from the file itself; only the hash part names the version.
   */
  const fileFor = (computerId: string, sha256: string): CacheFile | undefined =>
    deps.files
      .list(cacheDir(computerId))
      .find((file) => VERSION_RE.exec(file.name)?.[1] === sha256);

  const state = (computerId: string): CacheState => {
    const entries: { sha256: string; size: number; usedAt: number }[] = [];
    for (const file of deps.files.list(cacheDir(computerId))) {
      const sha256 = VERSION_RE.exec(file.name)?.[1];
      // A name that is not a version (a share copy) is neither counted nor evicted.
      if (sha256 !== undefined) {
        entries.push({ sha256, size: file.size, usedAt: file.usedAt });
      }
    }
    return entries.length === 0 ? EMPTY_CACHE : { entries };
  };

  /** Where a version is written: its hash, plus the type's extension.
   *
   * The extension is NOT decoration: WKWebView picks a PDF's renderer from it,
   * so a `file:` uri with no extension is a PDF that renders blank (Review round
   * 3, finding 2). One file, counted once, named so every viewer can open it.
   */
  const versionPath = (computerId: string, meta: ArtifactMeta): string =>
    cachePath(computerId, meta.sha256, artifactFileExt(meta));

  return {
    cap,
    state,
    put(computerId, meta, bytes) {
      // The plan counts what the DISK would hold, and the bytes' real length (a
      // verified read announces the same number, so this is never a guess).
      const incoming = { ...meta, size: bytes.length };
      const step = cacheStep(
        state(computerId),
        incoming,
        holding.get(computerId) ?? null,
        deps.now(),
        cap,
      );
      const path = versionPath(computerId, meta);
      if (step.wontFit) {
        // Not written at all: the viewer still shows it, it just cannot be shared.
        return { written: false, uri: null, note: step.note ?? tooBigNote(incoming) };
      }
      const existing = fileFor(computerId, meta.sha256);
      if (existing !== undefined) {
        // Already here, byte for byte: the plan says a re-arrival is only a touch.
        return {
          written: false,
          uri: deps.files.uriFor(`${cacheDir(computerId)}/${existing.name}`),
          note: null,
        };
      }
      // The plan's order: write the new file FIRST, then remove what it evicted,
      // so a crash between the two leaves an over-cap cache, never a hole.
      deps.files.mkdir(cacheDir(computerId));
      deps.files.write(path, bytes);
      for (const sha256 of step.evict) {
        const evicted = fileFor(computerId, sha256);
        if (evicted !== undefined) {
          deps.files.remove(`${cacheDir(computerId)}/${evicted.name}`);
        }
      }
      return { written: true, uri: deps.files.uriFor(path), note: null };
    },
    hold(computerId, sha256) {
      if (sha256 === null) {
        holding.delete(computerId);
        return;
      }
      holding.set(computerId, sha256);
    },
    uriOf(computerId, meta) {
      const existing = fileFor(computerId, meta.sha256);
      return existing === undefined
        ? null
        : deps.files.uriFor(`${cacheDir(computerId)}/${existing.name}`);
    },
    shareCopy(computerId, meta) {
      const existing = fileFor(computerId, meta.sha256);
      // Nothing cached (never opened here, evicted, or too big): no copy, and
      // never a uri pointing at a file that is not there.
      if (existing === undefined) {
        return null;
      }
      const name = shareName(meta.title, artifactFileExt(meta));
      const target = `${cacheDir(computerId)}/${name}`;
      deps.files.copy(`${cacheDir(computerId)}/${existing.name}`, target);
      return { uri: deps.files.uriFor(target), name };
    },
    forgetComputer(computerId) {
      holding.delete(computerId);
      // The artifacts may hold workspace content: unpaired means gone, and the
      // share copies live in the same directory.
      deps.files.removeDir(cacheDir(computerId));
    },
  };
}

export { cacheDir, cachePath, EMPTY_CACHE, planCache };
