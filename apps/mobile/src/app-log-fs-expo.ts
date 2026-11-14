/**
 * `app-log-fs.ts`'s file surface, over `expo-file-system` and RN's `Share`
 * (docs/feat/mobile-lock.md D7, Owner Q7). The ONE native import of the log
 * path; every rule lives in `app-log-fs.ts` / `app-log.ts`.
 *
 * Two details that are decisions, not style:
 * - the ring file lives in the DOCUMENT directory, not the cache: iOS may purge
 *   the cache, and "it failed this morning" needs yesterday's file. It is
 *   excluded from iCloud backup by name through `backup: 'none'` (the owner
 *   never wants log text in a backup — a shared file is a deliberate act).
 * - the EXPORT lives in the cache directory: it is transient by design and is
 *   deleted after the share sheet closes (F18).
 */
import { type Directory, File, Paths } from "expo-file-system";
import { Share } from "react-native";
import type { LogFiles } from "./app-log-fs.ts";

/** The ring's file names, in the document directory (versioned by the header line). */
export const LOG_FILE_NAME = "tentacle-log.txt";
/** The predecessor slot a rotation fills. */
export const LOG_PREVIOUS_NAME = "tentacle-log.1.txt";

function liveFile(): File {
  return new File(Paths.document, LOG_FILE_NAME);
}

/**
 * `expo-file-system` + `Share.share`. Every operation that reads is guarded: a
 * missing or unreadable file reads as `""`, as the pure layer expects.
 */
export const APP_LOG_FILES: LogFiles = {
  async readLive(): Promise<string> {
    try {
      const file = liveFile();
      return file.exists ? await file.text() : "";
    } catch {
      return "";
    }
  },
  async writeLive(text: string): Promise<void> {
    // NOTE (drift from D7's "backup-excluded"): `expo-file-system@58.0.10`'s
    // `FileWriteOptions` has only `encoding`/`append` — there is no per-file
    // backup flag. The ring lives in the DOCUMENT directory (it survives iOS
    // cache purges), which is backed up unless the app sets
    // `NSURLIsExcludedFromBackupKey` itself; that needs a native line this task's
    // dependency set does not have. Recorded in Execution as an open item.
    liveFile().write(text);
  },
  async rotateToPrevious(): Promise<void> {
    const live = liveFile();
    const previous = new File(Paths.document, LOG_PREVIOUS_NAME);
    if (previous.exists) {
      previous.delete();
    }
    if (live.exists) {
      // A COPY, not a move: the live file is then rewritten from the header, so
      // a crash between the two leaves the predecessor readable, not a gap.
      previous.write(await live.text());
      live.write("");
    }
  },
  cachesDir(): string {
    return Paths.cache.uri;
  },
  async writeExport(name: string, text: string): Promise<string> {
    const file = new File(Paths.cache, name);
    file.write(text);
    return file.uri;
  },
  async remove(uri: string): Promise<void> {
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  },
  async share(uri: string): Promise<void> {
    // `url` is the iOS-relevant field: the sheet offers Files, Mail, Messages
    // and anything else that accepts a file. Resolves when the sheet closes —
    // the caller deletes the temp file after that (F18).
    await Share.share({ url: uri });
  },
};

/** The caches directory as a `Directory` (kept for the export E2E hook's path). */
export function cachesDirectory(): Directory {
  return Paths.cache;
}
