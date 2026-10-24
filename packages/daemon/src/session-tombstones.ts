/**
 * The ids `session/delete` removed, kept for good on a `serve` daemon
 * (docs/feat/session-archive.md, F1): a later `session/open` of one answers
 * `SessionDeleted`, so an offline client's reconnect never recreates a session
 * another device deleted — after a restart too.
 *
 * On disk: `<store dir>/deleted-sessions`, one id per line, appended and
 * fsynced. Not a `.json` file, so the record scan never reads it, and an older
 * daemon ignores it. A line is counted only once its newline is written: a
 * crash mid-append leaves an unterminated tail, which is dropped on load. Every
 * append also starts with a newline, so a torn tail stays a line of its own and
 * never swallows the next id (blank lines are skipped on load).
 */
import { open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isValidSessionId } from "@tentacle/agent";

export const TOMBSTONE_FILE = "deleted-sessions";

/** Where the persister records a deleted id (tests pass a spy). */
export interface TombstoneStore {
  /** Durable once it resolves; rejects if the write failed. */
  add(id: string): Promise<void>;
}

export class TombstoneFile implements TombstoneStore {
  readonly path: string;
  /** Appends run one at a time (one fsync each), in call order. */
  private tail: Promise<void> = Promise.resolve();

  constructor(dir: string) {
    this.path = join(dir, TOMBSTONE_FILE);
  }

  /**
   * Every recorded id (a missing file → none). Throws if the file cannot be
   * read. A terminated line that is no valid id is skipped and handed to
   * `onGarbled` (a lost tombstone must not pass unnoticed).
   */
  async load(onGarbled?: (line: string) => void): Promise<string[]> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    // The last segment has no newline: empty, or a torn append.
    const ids: string[] = [];
    for (const line of text.split("\n").slice(0, -1)) {
      if (line === "") {
        continue;
      }
      if (isValidSessionId(line)) {
        ids.push(line);
      } else {
        onGarbled?.(line);
      }
    }
    return ids;
  }

  add(id: string): Promise<void> {
    if (!isValidSessionId(id)) {
      return Promise.reject(new Error(`invalid session id ${JSON.stringify(id)}`));
    }
    const write = this.tail.then(async () => {
      const created = await stat(this.path).then(
        () => false,
        () => true,
      );
      const handle = await open(this.path, "a", 0o600);
      try {
        // The leading newline ends a torn tail, so it can't swallow this id.
        await handle.appendFile(`\n${id}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (created) {
        await this.syncDir();
      }
    });
    this.tail = write.catch(() => {});
    return write.catch((error) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`couldn't record the deletion of ${id} in ${this.path}: ${reason}`, {
        cause: error,
      });
    });
  }

  /** fsync the directory so the file's first creation is durable (best effort: not every OS opens a directory). */
  private async syncDir(): Promise<void> {
    try {
      const handle = await open(dirname(this.path), "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      // Unsupported here (e.g. Windows): the file itself is already fsynced.
    }
  }
}
