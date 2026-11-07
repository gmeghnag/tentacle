/**
 * Where a large tool output is spilled (docs/fix/tool-output-location.md): the
 * daemon host's cache dir, never the user's project. Layout
 * `<root>/<project-key>/<session>/<tool>-<call>.txt`, dirs `0700`, files `0600`.
 * Written outside the write-confined `env` on purpose: the model reads the
 * file back with `fs_read` (reads are unconfined). Its `fs_write` reaches the
 * project and `tools.writableDirs` (docs/feat/write-tmpdir.md) — so the cache
 * dir is normally not writable for it, but the `os.tmpdir()` fallback root IS inside the
 * default writable dirs (still behind the `fs_write` ask).
 *
 * The store is the one truth on names: a file is created exclusively and a
 * taken name gets a `~N` suffix, so no spill ever replaces another (a server
 * may reuse call ids, and a session's Agents come and go on resume).
 */
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile as writeFileFs,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
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
  /** Whether `absPath` lies under a root of this store (for the "no longer available" hint). */
  owns(absPath: string): boolean;
  /** Remove a session's files from every project dir. Never throws. */
  removeSession(sessionId: string): Promise<void>;
  /** Remove files older than `retentionDays` (`<= 0`: nothing). Silent, never throws. */
  sweep(retentionDays: number, now?: number): Promise<void>;
}

const DAY_MS = 86_400_000;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const MAX_ATTEMPTS = 1000;

/** One path segment: no separator, never empty, never only dots, max 60. */
export function segment(raw: string): string {
  const s = raw.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 60);
  return s === "" || /^\.+$/.test(s) ? "_" : s;
}

/**
 * The directory name of a session id, on BOTH sides (write and remove): an id
 * that is already a safe name is kept as is; any other gets `~<sha256[:16]>`
 * (`~` is not in the safe set, so a hashed name never equals a plain one).
 * Two different ids never share a directory.
 */
export function sessionDirName(sessionId: string): string {
  return SAFE_SESSION.test(sessionId)
    ? sessionId
    : `~${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}`;
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
 * `os.tmpdir()/tentacle-<uid>/tool-output`, or `null` when that parent is not a
 * private real dir of ours.
 */
export function resolveToolOutputTmpRoot(options: ResolveRootOptions = {}): string | null {
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

/**
 * The one root for this process: `$XDG_CACHE_HOME` or `~/.cache`, then
 * `tentacle/tool-output`; else the tmp root; else `null`. Probed by writing a
 * file, so a read-only HOME falls through. Only ABSOLUTE bases count (XDG
 * spec): a relative one would land in the process cwd, maybe the project.
 */
export function resolveToolOutputRoot(options: ResolveRootOptions = {}): string | null {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? homedir();
  const xdg = env.XDG_CACHE_HOME;
  const bases = [
    ...(xdg && isAbsolute(xdg) ? [xdg] : []),
    ...(isAbsolute(home) ? [join(home, ".cache")] : []),
  ];
  const base = bases[0];
  if (base !== undefined) {
    const first = join(base, "tentacle", "tool-output");
    if (probe(first)) {
      return first;
    }
  }
  return resolveToolOutputTmpRoot(options);
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

/** realpath of the nearest existing ancestor + the rest (a not-yet-created dir still resolves, e.g. macOS /var → /private/var). */
function real(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(real(parent), basename(abs));
  }
}

/**
 * Whether `inner` is `outer` or lies under it (both resolved through
 * symlinks). A cwd of `/` contains no root: it is not a project (a pod with
 * WORKDIR `/`), and "inside /" would lose every spill.
 */
function lies(inner: string, outer: string): boolean {
  const i = real(inner);
  const o = real(outer);
  if (o === "/") {
    return false;
  }
  return i === o || i.startsWith(o.endsWith("/") ? o : `${o}/`);
}

/**
 * `alternative`: another root (the tmp one), asked lazily and only for a
 * project whose cwd contains `root` (HOME = the workspace). Nothing is ever
 * written inside the project: with no usable alternative, a spill is `null`.
 */
export function createToolOutputStore(
  root: string | null,
  alternative?: () => string | null,
): ToolOutputStore {
  let alt: string | null | undefined;
  const altRoot = (): string | null => {
    if (alt === undefined) {
      alt = alternative?.() ?? null;
    }
    return alt;
  };
  /** Every root this store may have written to (for read hint, sweep, remove). */
  const roots = (): string[] => {
    const list: string[] = [];
    if (root !== null) {
      list.push(root);
    }
    // Resolved on demand: after a restart the alternative may already hold files.
    const a = altRoot();
    if (a !== null && a !== root) {
      list.push(a);
    }
    return list;
  };

  const rootFor = (cwd: string | undefined): string | null => {
    if (root === null) {
      return null;
    }
    if (cwd === undefined || !lies(root, cwd)) {
      return root;
    }
    const other = altRoot();
    return other !== null && !lies(other, cwd) ? other : null;
  };

  const writeIn = async (
    cwd: string | undefined,
    key: string,
    sessionId: string,
    tool: string,
    callId: string,
    contents: string,
  ): Promise<string | null> => {
    const base = rootFor(cwd);
    if (base === null) {
      return null;
    }
    try {
      const dir = join(base, segment(key), sessionDirName(sessionId));
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const stem = `${segment(tool)}-${segment(callId)}`;
      for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
        const path = join(dir, `${stem}${n === 1 ? "" : `~${n}`}.txt`);
        try {
          // Exclusive: a taken name is never replaced, whoever took it.
          await writeFileFs(path, contents, { mode: 0o600, flag: "wx" });
          return path;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  };

  return {
    root,
    write: (sessionId, tool, callId, contents) =>
      writeIn(undefined, "_", sessionId, tool, callId, contents),
    forProject: (cwd) => ({
      write: (sessionId, tool, callId, contents) =>
        writeIn(cwd, projectKey(cwd), sessionId, tool, callId, contents),
    }),
    owns: (absPath) => roots().some((r) => absPath.startsWith(`${r}/`)),
    async removeSession(sessionId) {
      const name = sessionDirName(sessionId);
      try {
        for (const base of roots()) {
          for (const project of await children(base)) {
            if (!(await isRealDir(join(base, project)))) {
              continue;
            }
            const dir = join(base, project, name);
            if (await isRealDir(dir)) {
              await rm(dir, { recursive: true, force: true });
            }
          }
        }
      } catch {
        // best effort
      }
    },
    async sweep(retentionDays, now = Date.now()) {
      if (!(retentionDays > 0)) {
        return;
      }
      const cutoff = now - retentionDays * DAY_MS;
      try {
        for (const base of roots()) {
          for (const project of await children(base)) {
            const projectDir = join(base, project);
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
        }
      } catch {
        // best effort
      }
    },
  };
}
