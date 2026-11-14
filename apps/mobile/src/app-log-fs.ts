/**
 * The log's file side (docs/feat/mobile-lock.md D7, Owner Q7): the rotating
 * on-disk copy and the export handoff.
 *
 * Rotation is `2 × 256 KB` with a versioned header line, so a crash or a killed
 * app leaves a file a person can still share ("it failed this morning" is the
 * common report — that is why this is not memory-only). An unknown header
 * version is IGNORED for export and rotated away, never parsed as if it were
 * ours (F19), and nothing here can throw into the launch path.
 *
 * Pure parts (the header codec, the rotation decision) are exported for tests;
 * the file system is injected (`expo-file-system` in the app), so this module
 * imports no native code (AGENTS §7).
 */
import { type AppLogEntry, entriesToText, exportFileName, exportText } from "./app-log.ts";

/** The header line's version: a newer file is ignored, not parsed (F19). */
export const LOG_FILE_VERSION = 1;

/** The rotation bound (Owner Q7). */
export const LOG_FILE_MAX_BYTES = 256 * 1024;
/** How many files a rotation keeps (the live one and one predecessor). */
export const LOG_FILE_COUNT = 2;

/** The header line: `tentacle-log v1` — one line, first in the file. */
export function logHeader(version = LOG_FILE_VERSION): string {
  return `tentacle-log v${version}`;
}

/** Does this file start with a header this build understands? (F19) */
export function isReadableLog(text: string): boolean {
  const firstLine = text.slice(0, text.indexOf("\n") === -1 ? text.length : text.indexOf("\n"));
  return firstLine === logHeader();
}

/**
 * The bytes to keep after appending `line`: the ROTATION decision. Over the
 * bound, the whole file becomes the line alone (the predecessor file already
 * holds the history: rotation COPIES, it never concatenates, so no entry is
 * counted twice in an export).
 */
export function afterAppend(current: string, line: string): string {
  const next = current === "" ? `${logHeader()}\n${line}\n` : `${current}${line}\n`;
  if (next.length <= LOG_FILE_MAX_BYTES) {
    return next;
  }
  return `${logHeader()}\n${line}\n`;
}

/** What the file surface needs: three operations and a size (all injected). */
export interface LogFiles {
  /** The live file's text, or `""` when there is none (never throws). */
  readLive(): Promise<string>;
  /** Write the live file (atomically enough: one replace). */
  writeLive(text: string): Promise<void>;
  /** Copy the live file to the predecessor slot, then start the live one over. */
  rotateToPrevious(): Promise<void>;
  /** The directory exports are written into (the caches dir). */
  cachesDir(): string;
  /** Write a text file and return its URI. */
  writeExport(name: string, text: string): Promise<string>;
  /** Delete a file by URI (the export's cleanup; absent already is fine). */
  remove(uri: string): Promise<void>;
  /** Share a file: opens the system sheet and resolves when it closes. */
  share(uri: string): Promise<void>;
}

export interface AppLogFile {
  /** Append one entry, rotating when the bound is reached. Never rejects. */
  append(entry: AppLogEntry): Promise<void>;
  /**
   * The entries a previous run left, for the export ("it failed this morning").
   * Unreadable or unknown-version content is ignored (F19) — never a crash.
   */
  previousEntries(): Promise<string>;
  /**
   * Write the export file and hand it to the share sheet. The temp file is
   * deleted whatever the sheet did (F18: a cancel still cleans up).
   */
  exportNow(
    header: {
      readonly appVersion: string;
      readonly build: string;
      readonly osVersion: string;
      readonly deviceModel: string;
      readonly exportedAt: number;
      readonly droppedEntries: number;
    },
    entries: readonly AppLogEntry[],
  ): Promise<string>;
}

export function createAppLogFile(files: LogFiles): AppLogFile {
  return {
    async append(entry: AppLogEntry): Promise<void> {
      try {
        const current = await files.readLive();
        let base = current === "" || isReadableLog(current) ? current : "";
        if (current !== "" && !isReadableLog(current)) {
          // F19: an unknown or corrupt file is rotated away, never appended to.
          await files.rotateToPrevious();
        }
        const line = entriesToText([entry]);
        // Rotate BEFORE writing: the predecessor is what keeps the history, so
        // the decision is "would appending overflow the live file". After a
        // rotation the live file starts over at the header (the just-rotated
        // content is the predecessor's).
        if (base !== "" && base.length + line.length + 1 > LOG_FILE_MAX_BYTES) {
          await files.rotateToPrevious();
          base = "";
        }
        await files.writeLive(afterAppend(base, line));
      } catch {
        // The log is diagnostics: it must never break the app or the launch path.
      }
    },
    async previousEntries(): Promise<string> {
      try {
        const text = await files.readLive();
        if (!isReadableLog(text)) {
          return "";
        }
        const body = text.slice(text.indexOf("\n") + 1);
        return body;
      } catch {
        return "";
      }
    },
    async exportNow(header, entries): Promise<string> {
      const text = exportText(header, entries);
      const name = exportFileName(header.exportedAt);
      const uri = await files.writeExport(name, text);
      try {
        await files.share(uri);
      } finally {
        // F18: the sheet closed (shared, saved or cancelled) — the copy goes.
        await files.remove(uri).catch(() => {});
      }
      return uri;
    },
  };
}
