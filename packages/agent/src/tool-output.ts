/**
 * Where a large tool output is spilled (docs/fix/tool-output-location.md): the
 * daemon host's cache dir, never the user's project. Layout
 * `<root>/<project-key>/<session>/<tool>-<call>.txt`, dirs `0700`, files `0600`.
 * Written outside the workspace-confined `env` on purpose: the model reads the
 * file back with `fs_read` (reads are unconfined), but its `fs_write` stays
 * confined to the workspace.
 */
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile as writeFileFs,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "./session-store.ts";

/** What an `Agent` needs to spill a result. Resolves to the saved path, or `null`. */
export interface ToolOutputSink {
  write(sessionId: string, tool: string, callId: string, contents: string): Promise<string | null>;
}

export interface ToolOutputStore extends ToolOutputSink {
  /** The root, or `null` when no candidate dir was usable (every write → `null`). */
  readonly root: string | null;
  /** A sink bound to the project at `cwd` (`<project-key>`). */
  forProject(cwd: string): ToolOutputSink;
  /** Whether `absPath` lies under the root (for the "no longer available" hint). */
  owns(absPath: string): boolean;
  /** Remove a session's files from every project dir. Never throws. */
  removeSession(sessionId: string): Promise<void>;
  /** Remove files older than `retentionDays` (`<= 0`: nothing). Silent, never throws. */
  sweep(retentionDays: number, now?: number): Promise<void>;
}

const DAY_MS = 86_400_000;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** One path segment: no separator, never empty, never only dots, max 60. */
export function segment(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
  return s === "" || /^\.+$/.test(s) ? "_" : s;
}

export interface ResolveRootOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly uid?: number;
  readonly tmp?: string;
}

function probe(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `.probe-${randomBytes(4).toString("hex")}`);
    writeFileSync(file, "", { mode: 0o600 });
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/** `tmp/tentacle-<uid>`: a real dir (no symlink), ours, mode 0700 — else unusable. */
function privateTmpParent(dir: string, uid: number | undefined): boolean {
  try {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) {
      return false;
    }
    if (uid !== undefined && st.uid !== uid) {
      return false;
    }
    if ((st.mode & 0o777) !== 0o700) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The one root for this process: `$XDG_CACHE_HOME` or `~/.cache`, then
 * `tentacle/tool-output`; else `os.tmpdir()/tentacle-<uid>/tool-output`; else
 * `null`. Probed by writing a file, so a read-only HOME falls through.
 */
export function resolveToolOutputRoot(options: ResolveRootOptions = {}): string | null {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const cacheBase = env.XDG_CACHE_HOME ? env.XDG_CACHE_HOME : join(home, ".cache");
  const first = join(cacheBase, "tentacle", "tool-output");
  if (probe(first)) {
    return first;
  }
  const uid = options.uid ?? process.getuid?.();
  const parent = join(options.tmp ?? tmpdir(), `tentacle-${uid ?? 0}`);
  if (privateTmpParent(parent, uid)) {
    const second = join(parent, "tool-output");
    if (probe(second)) {
      return second;
    }
  }
  return null;
}

async function isRealDir(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

async function children(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

export function createToolOutputStore(root: string | null): ToolOutputStore {
  const writeIn = async (
    key: string,
    sessionId: string,
    tool: string,
    callId: string,
    contents: string,
  ): Promise<string | null> => {
    if (root === null) {
      return null;
    }
    try {
      const dir = join(root, segment(key), segment(sessionId));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${segment(tool)}-${segment(callId)}.txt`);
      await writeFileFs(path, contents, { mode: 0o600 });
      // An overwritten file keeps its old mode otherwise.
      await chmod(path, 0o600);
      return path;
    } catch {
      return null;
    }
  };

  return {
    root,
    write: (sessionId, tool, callId, contents) => writeIn("_", sessionId, tool, callId, contents),
    forProject: (cwd) => ({
      write: (sessionId, tool, callId, contents) =>
        writeIn(projectKey(cwd), sessionId, tool, callId, contents),
    }),
    owns: (absPath) => root !== null && absPath.startsWith(`${root}/`),
    async removeSession(sessionId) {
      if (root === null || !SAFE_SESSION.test(sessionId)) {
        return;
      }
      try {
        for (const project of await children(root)) {
          const dir = join(root, project, sessionId);
          if (await isRealDir(dir)) {
            await rm(dir, { recursive: true, force: true });
          }
        }
      } catch {
        // best effort
      }
    },
    async sweep(retentionDays, now = Date.now()) {
      if (root === null || !(retentionDays > 0)) {
        return;
      }
      const cutoff = now - retentionDays * DAY_MS;
      try {
        for (const project of await children(root)) {
          const projectDir = join(root, project);
          if (!(await isRealDir(projectDir))) {
            continue;
          }
          for (const session of await children(projectDir)) {
            const sessionDir = join(projectDir, session);
            if (!(await isRealDir(sessionDir))) {
              continue;
            }
            for (const name of await children(sessionDir)) {
              const file = join(sessionDir, name);
              try {
                const st = await lstat(file);
                if (st.isFile() && !st.isSymbolicLink() && st.mtimeMs < cutoff) {
                  await unlink(file);
                }
              } catch {
                // ignore
              }
            }
            await rmdir(sessionDir).catch(() => undefined);
          }
          await rmdir(projectDir).catch(() => undefined);
        }
      } catch {
        // best effort
      }
    },
  };
}
