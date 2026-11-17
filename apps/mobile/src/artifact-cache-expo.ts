/**
 * The artifact cache's `expo-file-system` binding (docs/feat/model-artifacts.md
 * D9; Review round 3's finding 1). Wiring only, like `outbox-fs-expo.ts`: every
 * rule — the cap, the held version, the note, the share name, the unpair delete
 * — lives in `artifact-cache-store.ts`, which is tested over a fake.
 *
 * The ONLY module in the app that touches `Caches/artifacts/` for the cache, so
 * nothing else can write bytes the plan never saw (that was the bug: the viewer
 * and the thumbnailer each wrote the file themselves, so the 200 MB cap could
 * never see them).
 */
import { Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import {
  type ArtifactCache,
  type CacheFile,
  type CacheFiles,
  createArtifactCache,
} from "./artifact-cache-store.ts";

/** The cache root's own folder name, under `Caches` (`artifact-cache.ts`'s `artifacts/…`). */
const ARTIFACTS_ROOT = "artifacts/";

function fileAt(path: string): File {
  return new File(Paths.cache, path);
}

function dirAt(path: string): Directory {
  return new Directory(Paths.cache, path);
}

const EXPORTS: CacheFiles = {
  list(dir) {
    const directory = dirAt(dir);
    if (!directory.exists) {
      return [];
    }
    const files: CacheFile[] = [];
    for (const entry of directory.list()) {
      // `list()` returns both; only real files are versions.
      if (!(entry instanceof File)) {
        continue;
      }
      const info = entry.info();
      files.push({
        name: entry.name,
        size: info.size ?? 0,
        // A file the OS cannot date is the OLDEST: it is the first to go.
        usedAt: info.modificationTime ?? 0,
      });
    }
    return files;
  },
  write(path, bytes) {
    const file = fileAt(path);
    file.create({ intermediates: true, overwrite: true });
    file.write(bytes);
  },
  copy(from, to) {
    const source = fileAt(from);
    const target = fileAt(to);
    // `overwrite` is safe: the name is the sanitized title, so a re-share of the
    // same artifact rewrites exactly its own copy.
    source.copy(target, { overwrite: true });
  },
  remove(path) {
    const file = fileAt(path);
    if (file.exists) {
      file.delete();
    }
  },
  removeDir(dir) {
    const directory = dirAt(dir);
    if (directory.exists) {
      directory.delete();
    }
  },
  mkdir(dir) {
    dirAt(dir).create({ intermediates: true, idempotent: true });
  },
  uriFor(path) {
    return fileAt(path).uri;
  },
};

/** The app's ONE cache store (the LRU state is the disk, so one instance is enough). */
export const ARTIFACT_CACHE: ArtifactCache = createArtifactCache({
  files: EXPORTS,
  now: () => Date.now(),
});

/**
 * Hand one cache file to the system Share sheet, then delete the copy — the
 * `app-log-fs-expo.ts` F18 pattern (`Share.share` resolves when the sheet
 * closes). Share works on a NAMED copy, so without this every share would leave
 * a second, uncounted file behind until the computer is unpaired.
 *
 * Only a path under the artifact cache is deleted: this is reached from a
 * screen, and a bug there must not become an arbitrary `file:` delete.
 */
export async function shareCachedCopy(uri: string): Promise<void> {
  await Share.share({ url: uri });
  if (!uri.includes(ARTIFACTS_ROOT)) {
    return;
  }
  const file = new File(uri);
  if (file.exists) {
    file.delete();
  }
}
