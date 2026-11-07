/**
 * Host execution environment — runs tool side-effects directly on the OS where
 * the harness process lives (ADR-005). A container-backed implementation will
 * satisfy the same `ExecutionEnvironment` contract later without changing callers.
 *
 * `exec` combines an optional caller `signal` with an optional `timeoutMs` into a
 * single abort signal so a runaway command is always killed.
 *
 * Writes are confined to the workspace `root` (the launch directory by default)
 * plus any `writableDirs` (absolute; the config gives the system temp dirs by
 * default, docs/feat/write-tmpdir.md): `writeFile` refuses any path that
 * resolves — after following symlinks — outside all of them, and any dangling
 * or looping link. It replaces the file atomically (temp + rename, never a
 * write through an existing inode). Reads are intentionally unconfined. The shell (`exec`) cannot be confined at
 * the filesystem level on the host; that is gated by the permission engine instead
 * (and fully sandboxed once the container environment lands).
 */
import { randomBytes } from "node:crypto";
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { type FileHandle, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { scrubSensitiveEnv } from "@tentacle/core";
import type {
  BackgroundHandle,
  ExecOptions,
  ExecResult,
  ExecutionEnvironment,
} from "@tentacle/core";
import type { Subprocess } from "bun";
import { isLingering, killGroup, releaseGroup, trackGroup } from "./process-group.ts";

/** Grace between SIGTERM and SIGKILL when killing a command's process group. */
export const KILL_GRACE_MS = 2000;

export interface HostExecutionConfig {
  /** Default working directory for commands and relative file paths. */
  readonly cwd?: string;
  /** Workspace root that writes are confined to (defaults to `cwd`). */
  readonly root?: string;
  readonly id?: string;
  /** SIGTERM → SIGKILL grace when killing a command (default `KILL_GRACE_MS`). */
  readonly killGraceMs?: number;
  /**
   * Explains a missing file: given the absolute path of a read that hit
   * `ENOENT`, text to say instead of the bare OS error (e.g. a spilled tool
   * output that was removed with its session). `undefined` → the OS error.
   */
  readonly readHint?: (absPath: string) => string | undefined;
  /**
   * Directories writable besides `root` (docs/feat/write-tmpdir.md): absolute
   * paths, matched by realpath. An entry that is not absolute (`~` must be
   * expanded by the caller) or that resolves to the filesystem root is dropped
   * and listed in `droppedWritableDirs`. Absent → `root` only.
   */
  readonly writableDirs?: readonly string[];
  /**
   * TEST SEAM ONLY: runs between the confinement check and the `open` of a
   * write, with the checked real path — where a race test swaps in a link.
   */
  readonly beforeOpen?: (realPath: string) => void | Promise<void>;
  /**
   * TEST SEAM ONLY: runs after the temp file is written and chmodded and the
   * last re-checks passed — immediately before the `rename`.
   */
  readonly beforeRename?: (realPath: string) => void | Promise<void>;
}

/** Thrown when a write would escape the workspace root. */
export class WorkspaceWriteError extends Error {
  override readonly name = "WorkspaceWriteError";
  /** The OS errno behind a permission refusal (`EACCES`, `EPERM`), as an in-place write reported it. */
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Realpath `p` if it exists, else return it unchanged (normalized by caller). */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Whether `p` exists as a directory entry — a dangling symlink counts (no follow). */
function entryExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** A path's real location, or the dangling link that stops it (docs/feat/write-tmpdir.md F1). */
type RealTarget =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly dangling: string; readonly loop: boolean };

/**
 * Resolve `abs` to its real location, following symlinks on the deepest existing
 * entry (the kernel's realpath: physical, never lexical) and re-appending the
 * not-yet-existing tail (which, having been through `path.resolve`, contains no
 * `..`). A DANGLING link at that entry (or a loop — `lstat` finds it, `stat`
 * does not) is NOT resolved: the write would create its target wherever the
 * kernel takes it, which only the kernel can say. It is refused, whatever it
 * points at (review F1: a hand-written `readlink` walk got `..` wrong).
 */
function realTarget(abs: string): RealTarget {
  let existing = abs;
  const tail: string[] = [];
  while (!entryExists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    tail.unshift(basename(existing));
    existing = parent;
  }
  if (entryExists(existing) && !existsSync(existing)) {
    let loop = false;
    try {
      statSync(existing);
    } catch (error) {
      loop = errnoOf(error) === "ELOOP";
    }
    return { ok: false, dangling: existing, loop };
  }
  const real = safeRealpath(existing);
  return { ok: true, path: tail.length > 0 ? resolve(real, ...tail) : real };
}

/**
 * `open(2)` flags of the temp file a confined write creates (see
 * `HostExecution.writeFile`): a NEW file only, never a link.
 */
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fsConstants;
const OPEN_TEMP = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Whether `target` is `root` or inside it (`/tmpfoo` is not inside `/tmp`). A
 * root of `/` matches only itself (`"//"` prefix), as before: a writable `/` is
 * dropped at construction, and a project at `/` stays as confined as it was.
 */
function within(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

/**
 * The extra writable roots, realpath'd and de-duplicated; an entry that is not
 * absolute, that resolves to the filesystem root (it would make "confined"
 * meaningless), or that is a dangling link or a loop, is dropped and reported.
 */
function writableRootsOf(dirs: readonly string[]): {
  readonly roots: readonly string[];
  readonly dropped: readonly string[];
} {
  const roots: string[] = [];
  const dropped: string[] = [];
  for (const dir of dirs) {
    if (!isAbsolute(dir)) {
      dropped.push(dir);
      continue;
    }
    // Canonicalised like a target: a dir that does not exist yet still gets its
    // existing ancestors realpath'd (`/var/…` → `/private/var/…` on macOS).
    const resolved = realTarget(resolve(dir));
    const real = resolved.ok ? resolved.path : undefined;
    if (real === undefined || dirname(real) === real) {
      dropped.push(dir);
      continue;
    }
    if (!roots.includes(real)) {
      roots.push(real);
    }
  }
  return { roots, dropped };
}

export class HostExecution implements ExecutionEnvironment {
  readonly id: string;
  private readonly defaultCwd: string;
  private readonly root: string;
  /** Writable besides `root`: realpaths (docs/feat/write-tmpdir.md). */
  private readonly writableRoots: readonly string[];
  /** `writableDirs` entries refused at construction (not absolute, or `/`): for a daemon log. */
  readonly droppedWritableDirs: readonly string[];
  private readonly killGraceMs: number;
  private readonly readHint: ((absPath: string) => string | undefined) | undefined;
  private readonly beforeOpen: ((realPath: string) => void | Promise<void>) | undefined;
  private readonly beforeRename: ((realPath: string) => void | Promise<void>) | undefined;
  /** Commands whose leader exited (their group was handed to `releaseGroup`). */
  private readonly released = new WeakSet<Subprocess>();

  constructor(config?: HostExecutionConfig) {
    this.id = config?.id ?? "host";
    this.killGraceMs = config?.killGraceMs ?? KILL_GRACE_MS;
    this.readHint = config?.readHint;
    this.beforeOpen = config?.beforeOpen;
    this.beforeRename = config?.beforeRename;
    this.defaultCwd = resolve(config?.cwd ?? process.cwd());
    this.root = safeRealpath(resolve(config?.root ?? this.defaultCwd));
    const writable = writableRootsOf(config?.writableDirs ?? []);
    this.writableRoots = writable.roots.filter((r) => r !== this.root);
    this.droppedWritableDirs = writable.dropped;
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const proc = this.spawnShell(command, options);

    const kill = (): void => {
      this.terminate(proc);
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs !== undefined) {
      timer = setTimeout(kill, options.timeoutMs);
    }
    const signal = options?.signal;
    if (signal) {
      if (signal.aborted) {
        kill();
      } else {
        signal.addEventListener("abort", kill, { once: true });
      }
    }

    try {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      // A process killed by a signal reports a null exit code; surface it as a
      // non-zero failure so callers can treat timeout/abort as an error.
      const exitCode = proc.exitCode ?? 124;
      return { stdout, stderr, exitCode };
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener("abort", kill);
      }
    }
  }

  /**
   * Start a command in the background. Unlike `exec`, this does not read the
   * pipes to EOF — it hands the live streams to the caller and resolves
   * `exited` when the process ends, so a server keeps running while the agent
   * continues. `timeoutMs` is ignored here (a background job runs until it
   * exits or is killed).
   */
  spawnBackground(command: string, options?: ExecOptions): BackgroundHandle {
    const proc = this.spawnShell(command, { ...options, stdin: undefined });
    return {
      pid: proc.pid,
      stdout: proc.stdout,
      stderr: proc.stderr,
      // proc.exited resolves with the exit code; a signal-killed process reports
      // a null exitCode, which we preserve to distinguish it from a clean exit.
      exited: proc.exited.then(() => proc.exitCode),
      kill: () => this.terminate(proc),
    };
  }

  /**
   * `sh -c command` as the leader of its OWN process group (`detached`), so a
   * kill can reach everything it starts. The group is registered with the
   * process-exit net until it is empty (see `releaseGroup`).
   */
  private spawnShell(
    command: string,
    options?: ExecOptions,
  ): Subprocess<"ignore" | Uint8Array, "pipe", "pipe"> {
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: options?.cwd ?? this.defaultCwd,
      env: this.childEnv(options),
      // Bytes are written to the child's stdin, which is then closed (EOF).
      stdin: options?.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Not in Bun's TS types, but honoured: the child gets pgid = its pid.
      ...({ detached: true } as object),
    });
    trackGroup(proc.pid);
    void proc.exited.then(() => {
      releaseGroup(proc.pid);
      this.released.add(proc);
    });
    return proc;
  }

  /**
   * SIGTERM the command's whole group, then SIGKILL it after the grace period
   * — unconditionally, since `sh` may die on TERM while a grandchild that
   * ignores it lives on. A group with members keeps its pgid, so the KILL can
   * only miss-hit if the group emptied AND its pgid was recycled within the
   * grace window (needs pid wrap-around); an emptied group just returns ESRCH.
   *
   * After the leader exited the pgid is only ours while the group lingers
   * (still has members); a released, empty group is never signalled — its
   * pgid may already be recycled. True if anything was signalled.
   */
  private terminate(proc: Subprocess): boolean {
    if (this.released.has(proc) && !isLingering(proc.pid)) {
      return false;
    }
    if (!killGroup(proc.pid, "SIGTERM")) {
      return false;
    }
    setTimeout(() => killGroup(proc.pid, "SIGKILL"), this.killGraceMs).unref();
    return true;
  }

  /**
   * The env handed to a spawned child: the host env minus secret-looking vars
   * (a model-run `echo $TENTACLE_MODEL_API_KEY` must not read the user's keys
   * out of the inherited env), with the caller's explicit `options.env` overlaid
   * unscrubbed — an explicit value is an opt-in, same policy as the MCP stdio
   * transport (`mcp/transport.ts`).
   */
  private childEnv(options?: ExecOptions): Record<string, string> {
    const base = scrubSensitiveEnv(process.env);
    return options?.env ? { ...base, ...options.env } : base;
  }

  async readFile(path: string): Promise<string> {
    // Reads are unconfined (by design).
    const abs = resolve(this.defaultCwd, path);
    try {
      return await Bun.file(abs).text();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const hint = this.readHint?.(abs);
        if (hint !== undefined) {
          throw new Error(`${abs}: ${hint}`);
        }
      }
      throw error;
    }
  }

  /**
   * A confined write (docs/feat/write-tmpdir.md, fix round 2): an atomic
   * replace, never a write through an existing inode.
   * 1. The CHECKED REAL path (`confineWrite`; links present at check time are
   *    already followed, so in-root links keep working).
   * 2. `dirChain`: every directory below the containing root, down to the
   *    parent, is a real directory (missing ones created, umask-respecting).
   * 3. The final name, if present, must be a regular file we could write in
   *    place (`access(W_OK)`: a read-only or another user's file is refused, as
   *    an in-place write was); a symlink there appeared after the check:
   *    refused, never replaced. Its permission bits are kept.
   * 4. A temp file `.tt-<hex>.tentacle-tmp` (short, not from the basename) is
   *    created in the parent with mode `0600` (`O_CREAT|O_EXCL|O_NOFOLLOW`), the
   *    chain and the parent's realpath re-checked, the content written and
   *    `fsync`ed, THEN `fchmod`ed to the final bits (the target's, or `0666`
   *    minus the umask), re-checked again with the final name, then `rename`d
   *    over the target. A hard link at the target only loses this name; its
   *    other names keep the old bytes. Owner, group, ACLs and xattrs are not
   *    kept (as in an editor's atomic save). `EACCES`/`EPERM` on the create or
   *    the rename is a refusal naming the directory. Any failure unlinks the
   *    temp; if even that fails, the error says where it was left.
   * Residual (fix round 3): the re-checks narrow but cannot close a race by a
   * user who can write a directory on the path (e.g. one they made in `/tmp`):
   * docs/feat/write-tmpdir.md "Fix round 3".
   */
  async writeFile(path: string, contents: string): Promise<void> {
    const target = this.confineWrite(path);
    const root = this.rootOf(target);
    if (target === root) {
      throw new WorkspaceWriteError(`refused: not a regular file: ${path}`);
    }
    const parent = dirname(target);
    if (!entryExists(root)) {
      // A configured writable dir that does not exist yet (its realpath'd
      // ancestors were pinned at construction; if it is later created as a
      // link outward, `confineWrite` resolves through it and refuses).
      mkdirSync(root, { recursive: true });
    }
    this.dirChain(path, root, parent, "create");
    await this.beforeOpen?.(target);
    this.dirChain(path, root, parent, "recheck");
    const mode = this.finalNameMode(path, target);
    // Short and never derived from the basename: a name near NAME_MAX still works.
    const temp = join(parent, `.tt-${randomBytes(8).toString("hex")}.tentacle-tmp`);
    let fd: FileHandle | undefined;
    try {
      try {
        // 0600 while the content is written: never more readable than the target.
        fd = await open(temp, OPEN_TEMP, 0o600);
      } catch (error) {
        throw this.dirError(error, path, parent, "cannot create a file in");
      }
      this.dirChain(path, root, parent, "recheck");
      await fd.writeFile(contents);
      await fd.sync();
      // The final permission bits only now: the target's, or a new file's default.
      await fd.chmod(mode ?? 0o666 & ~process.umask());
      await fd.close();
      fd = undefined;
      this.dirChain(path, root, parent, "recheck");
      this.finalNameMode(path, target);
      await this.beforeRename?.(target);
      try {
        await rename(temp, target);
      } catch (error) {
        throw this.dirError(error, path, parent, "cannot replace the file in");
      }
    } catch (error) {
      await fd?.close().catch(() => undefined);
      const left = await unlink(temp).then(
        () => undefined,
        (e: unknown) => (errnoOf(e) === "ENOENT" ? undefined : e),
      );
      if (left !== undefined) {
        const why = errnoOf(left) ?? String(left);
        const message = `${error instanceof Error ? error.message : String(error)} (temp file left at ${temp}: ${why})`;
        throw error instanceof WorkspaceWriteError
          ? new WorkspaceWriteError(message, error.code)
          : Object.assign(new Error(message), { code: errnoOf(error) });
      }
      throw error;
    }
  }

  /**
   * `EACCES`/`EPERM` from the temp create or the `rename` → a refusal naming
   * the directory (not the hidden temp). Other errors pass through.
   */
  private dirError(error: unknown, path: string, parent: string, what: string): unknown {
    const code = errnoOf(error);
    if (code !== "EACCES" && code !== "EPERM") {
      return error;
    }
    return new WorkspaceWriteError(
      `refused: ${what} ${parent} (${code}: the directory is not writable for you, or it is sticky and the file is another user's; a file there is never rewritten in place): ${path}`,
      code,
    );
  }

  /**
   * The permission bits (`0o777`; no setuid/setgid/sticky) to keep from an
   * existing target, `undefined` when there is none. Refuses a non-regular file,
   * a symlink (the checked real path had none: it appeared after the check), and
   * a file we could not write in place (`access(W_OK)`: read-only, or another
   * user's) — a `rename` would replace it anyway, so parity with an in-place
   * write is enforced here (review round 3 F2).
   */
  private finalNameMode(path: string, target: string): number | undefined {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(target);
    } catch (error) {
      if (errnoOf(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (st.isSymbolicLink()) {
      throw new WorkspaceWriteError(
        `refused: a symlink at the final path (it appeared after the check): ${path}`,
      );
    }
    if (!st.isFile()) {
      throw new WorkspaceWriteError(`refused: not a regular file: ${path}`);
    }
    try {
      accessSync(target, fsConstants.W_OK);
    } catch (error) {
      const code = errnoOf(error) ?? "EACCES";
      throw new WorkspaceWriteError(
        `refused: read-only file (${code}: permission denied; it is read-only or another user's): ${path}`,
        code,
      );
    }
    return st.mode & 0o777;
  }

  /**
   * Every directory strictly below `root`, down to `parent` (see `writeFile`),
   * must be a real directory (not a symlink). `create`: a missing one is made
   * (default mode: `0777` minus the umask). `recheck` (after the check): every one must exist, and
   * the parent's realpath must still be `parent` — any failure is "moved".
   * No owner/mode rule (fix round 3, owner): `umask 002` and pod `fsGroup`
   * make group-writable project dirs normal.
   */
  private dirChain(path: string, root: string, parent: string, phase: "create" | "recheck"): void {
    const rel = relative(root, parent);
    const parts = rel === "" ? [] : rel.split(sep);
    let dir = root;
    const moved = (why: string): WorkspaceWriteError =>
      new WorkspaceWriteError(`refused: the path moved during the write (${why}): ${path}`);
    const refused = (why: string): WorkspaceWriteError =>
      phase === "recheck" ? moved(why) : new WorkspaceWriteError(`refused: ${why}: ${path}`);
    for (const part of parts) {
      dir = join(dir, part);
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(dir);
      } catch (error) {
        if (errnoOf(error) !== "ENOENT" || phase === "recheck") {
          throw moved(`${dir} is gone`);
        }
        try {
          mkdirSync(dir);
        } catch (mkdirError) {
          if (errnoOf(mkdirError) !== "EEXIST") {
            throw mkdirError;
          }
        }
        st = lstatSync(dir);
      }
      if (!st.isDirectory()) {
        throw refused(`${dir} is not a directory (a symlink or a file)`);
      }
    }
    if (phase === "recheck") {
      let real: string;
      try {
        real = realpathSync(parent);
      } catch {
        throw moved(`${parent} is gone`);
      }
      if (real !== parent) {
        throw moved(`${parent} now resolves to ${real}`);
      }
    }
  }

  /** The most specific root (project or writable dir) that holds the real path `target`. */
  private rootOf(target: string): string {
    let best = this.root;
    let found = within(this.root, target);
    for (const root of this.writableRoots) {
      if (within(root, target) && (!found || root.length > best.length)) {
        best = root;
        found = true;
      }
    }
    return best;
  }

  /** Whether the real path `target` is inside the project or a writable dir. */
  private isAllowed(target: string): boolean {
    return [this.root, ...this.writableRoots].some((root) => within(root, target));
  }

  /** The checked REAL write path, or throw if it escapes the workspace root and every writable dir. */
  private confineWrite(path: string): string {
    const abs = resolve(this.defaultCwd, path);
    const target = realTarget(abs);
    if (!target.ok) {
      throw new WorkspaceWriteError(
        target.loop
          ? `refused: symlink loop at ${target.dangling}: ${path}`
          : `refused: dangling symlink ${target.dangling} (its target does not exist; create it first): ${path}`,
      );
    }
    if (!this.isAllowed(target.path)) {
      const allowed =
        this.writableRoots.length > 0 ? `; writable dirs: ${this.writableRoots.join(", ")}` : "";
      throw new WorkspaceWriteError(
        `refusing to write outside the workspace (${this.root}${allowed}): ${path}`,
      );
    }
    return target.path;
  }
}
