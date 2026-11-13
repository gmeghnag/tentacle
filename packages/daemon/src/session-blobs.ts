/**
 * A session's image bytes on disk, beside its log (docs/feat/attachments-durable.md D1):
 * `<dir>/<uid>.attachments/<sha256>` — the raw bytes, the file name the
 * VERIFIED id (never client input). Content-addressed, so a file is immutable
 * once renamed in, and self-verifying (the provider re-checks sha256 + size on
 * every read), so there is no header and no schema version; every scan of the
 * store ignores the dir (an older build too).
 *
 * Shared by the laptop store and `serve`'s: `LogSessionStore` owns one and
 * routes the MUTATIONS (write, link, remove) through the session's queue and
 * lock; reads go straight here. Every path is built from a valid session id
 * and an `ATTACHMENT_ID_RE` id, checked before any `join` (AGENTS §7: a pod
 * chooses refs, never paths).
 */
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { copyFile, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isValidSessionId } from "@tentacle/agent";
import { ATTACHMENT_ID_RE } from "@tentacle/protocol";

export const BLOB_DIR_SUFFIX = ".attachments";

/** `.<sha256>.tmp-<pid>-<hex>`: a write's temp inside a blob dir. */
const BLOB_TEMP = /^\.[0-9a-f]{64}\.tmp-(\d+)-[0-9a-f]+$/;
const STALE_TEMP_MS = 60 * 60 * 1000;

/** The file operations a link makes; injectable so a test can force the copy fallback. */
export interface SessionBlobsIo {
  link(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
  /** Write `bytes` to a NEW file at `path` and fsync it. */
  writeDurable(path: string, bytes: Uint8Array): Promise<void>;
}

const defaultIo: SessionBlobsIo = {
  link: (from, to) => link(from, to),
  copy: (from, to) => copyFile(from, to),
  async writeDurable(path, bytes) {
    const handle = await open(path, "w", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/** A link that cannot be made on this file system: copy instead. */
const NO_LINK = new Set(["EXDEV", "EPERM", "ENOTSUP", "EOPNOTSUPP", "EMLINK"]);

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

export class SessionBlobs {
  private readonly io: SessionBlobsIo;

  constructor(
    private readonly dir: string,
    io?: SessionBlobsIo,
  ) {
    this.io = io ?? defaultIo;
  }

  /** `<dir>/<uid>.attachments` — throws on an invalid session id (never a path from it). */
  private blobDir(uid: string): string {
    if (!isValidSessionId(uid)) {
      throw new Error(`invalid session id ${JSON.stringify(uid)}`);
    }
    return join(this.dir, `${uid}${BLOB_DIR_SUFFIX}`);
  }

  private blobPath(uid: string, id: string): string {
    if (!ATTACHMENT_ID_RE.test(id)) {
      throw new Error(`invalid attachment id ${JSON.stringify(id)}`);
    }
    return join(this.blobDir(uid), id);
  }

  /** Ids + sizes on disk for `uid` (names that are not an id are skipped; no dir → empty). */
  index(uid: string): Map<string, number> {
    const out = new Map<string, number>();
    let names: string[];
    try {
      names = readdirSync(this.blobDir(uid));
    } catch {
      return out;
    }
    for (const name of names) {
      if (!ATTACHMENT_ID_RE.test(name)) continue;
      try {
        const st = statSync(join(this.blobDir(uid), name));
        if (st.isFile()) out.set(name, st.size);
      } catch {
        // Vanished between the two calls: not on disk.
      }
    }
    return out;
  }

  /** The bytes, or `null` when absent or unreadable (never a throw: the caller shows a placeholder). */
  async read(uid: string, id: string): Promise<Uint8Array | null> {
    let path: string;
    try {
      path = this.blobPath(uid, id);
    } catch {
      return null;
    }
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  }

  /** temp + fsync + rename. Idempotent: a file already there at the same size is kept. */
  async write(uid: string, id: string, bytes: Uint8Array): Promise<void> {
    const path = this.blobPath(uid, id);
    if ((await sizeOf(path)) === bytes.length) return;
    const dir = this.blobDir(uid);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `.${id}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
    try {
      await this.io.writeDurable(temp, bytes);
      await rename(temp, path);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  /**
   * Give `toUid` the blobs `ids` of `fromUid` (a `/clear` fork): a hardlink,
   * or a copy where the file system cannot link. A source id that is not on
   * disk is skipped; one the target already has is kept.
   */
  async link(fromUid: string, toUid: string, ids: Iterable<string>): Promise<void> {
    const targetDir = this.blobDir(toUid);
    let made = false;
    for (const id of ids) {
      const from = this.blobPath(fromUid, id);
      const to = this.blobPath(toUid, id);
      const size = await sizeOf(from);
      if (size === null || (await sizeOf(to)) === size) continue;
      if (!made) {
        await mkdir(targetDir, { recursive: true, mode: 0o700 });
        made = true;
      }
      await rm(to, { force: true });
      try {
        await this.io.link(from, to);
      } catch (error) {
        const code = codeOf(error);
        if (typeof code !== "string" || !NO_LINK.has(code)) throw error;
        const temp = join(targetDir, `.${id}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`);
        try {
          await this.io.copy(from, temp);
          await rename(temp, to);
        } catch (copyError) {
          await rm(temp, { force: true }).catch(() => {});
          throw copyError;
        }
      }
    }
  }

  /** `rm -r <uid>.attachments`. */
  async removeAll(uid: string): Promise<void> {
    await rm(this.blobDir(uid), { recursive: true, force: true });
  }

  /** The session ids that have a blob dir (whatever else the folder holds). */
  async owners(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith(BLOB_DIR_SUFFIX) && !name.startsWith("."))
      .map((name) => name.slice(0, -BLOB_DIR_SUFFIX.length))
      .filter((uid) => isValidSessionId(uid));
  }

  /** Remove crash leftovers: temps of dead writers (or very old ones), in every blob dir. Best-effort. */
  async sweep(): Promise<void> {
    for (const uid of await this.owners()) {
      const dir = this.blobDir(uid);
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const temp = BLOB_TEMP.exec(name);
        if (!temp) continue;
        const path = join(dir, name);
        try {
          const pid = Number(temp[1]);
          if (
            pid !== process.pid &&
            (!processAlive(pid) || Date.now() - (await stat(path)).mtimeMs > STALE_TEMP_MS)
          ) {
            await rm(path, { force: true });
          }
        } catch {
          // Vanished: nothing to sweep.
        }
      }
    }
  }
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}
