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
 * resolves — after following symlinks, dangling ones included — outside all of
 * them. Reads are intentionally unconfined. The shell (`exec`) cannot be confined at
 * the filesystem level on the host; that is gated by the permission engine instead
 * (and fully sandboxed once the container environment lands).
 */
import { existsSync, constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
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
}

/** Thrown when a write would escape the workspace root. */
export class WorkspaceWriteError extends Error {
  override readonly name = "WorkspaceWriteError";
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
  | { readonly ok: false; readonly dangling: string };

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
    return { ok: false, dangling: existing };
  }
  const real = safeRealpath(existing);
  return { ok: true, path: tail.length > 0 ? resolve(real, ...tail) : real };
}

/** `open(2)` flags of a confined write; see `HostExecution.writeFile`. */
const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW, O_NONBLOCK } = fsConstants;
const OPEN_NEW = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK;
const OPEN_EXISTING = O_WRONLY | O_NOFOLLOW | O_NONBLOCK;

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
  /** Commands whose leader exited (their group was handed to `releaseGroup`). */
  private readonly released = new WeakSet<Subprocess>();

  constructor(config?: HostExecutionConfig) {
    this.id = config?.id ?? "host";
    this.killGraceMs = config?.killGraceMs ?? KILL_GRACE_MS;
    this.readHint = config?.readHint;
    this.beforeOpen = config?.beforeOpen;
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
   * A confined write (docs/feat/write-tmpdir.md, review F2). After the path
   * check, the CHECKED REAL path is opened — never re-resolved by name:
   * - `O_NOFOLLOW`: a symlink swapped in at the final component after the check
   *   is refused by the kernel (a link that was there at check time was already
   *   followed, so in-root links keep working);
   * - `O_EXCL` first, so it is known whether this write created the file, and no
   *   `O_TRUNC`: nothing is truncated before the checks below pass;
   * - `O_NONBLOCK`: a FIFO with no reader fails at once instead of hanging;
   * - on the descriptor: a regular file only, `nlink === 1` (a hard link to a
   *   file elsewhere is invisible to realpath), and the parent's realpath re-read
   *   AFTER the open must still be inside a root, with the name there being this
   *   very inode (dev + ino) — a parent dir swapped for a link is caught.
   * Then truncate and write through the descriptor.
   */
  async writeFile(path: string, contents: string): Promise<void> {
    const target = this.confineWrite(path);
    await mkdir(dirname(target), { recursive: true });
    await this.beforeOpen?.(target);
    const fd = await this.openConfined(path, target);
    try {
      const st = await fd.stat();
      if (!st.isFile()) {
        throw new WorkspaceWriteError(`refused: not a regular file: ${path}`);
      }
      if (st.nlink > 1) {
        throw new WorkspaceWriteError(
          `refused: hard link (${st.nlink} names; one may be outside the workspace): ${path}`,
        );
      }
      let named: { dev: number; ino: number } | undefined;
      let parent: string | undefined;
      try {
        parent = realpathSync(dirname(target));
        named = lstatSync(join(parent, basename(target)));
      } catch {
        named = undefined;
      }
      if (
        parent === undefined ||
        named === undefined ||
        !this.isAllowed(join(parent, basename(target))) ||
        named.dev !== st.dev ||
        named.ino !== st.ino
      ) {
        throw new WorkspaceWriteError(
          `refused: the path moved during the write (a directory was swapped): ${path}`,
        );
      }
      await fd.truncate(0);
      await fd.writeFile(contents);
    } finally {
      await fd.close();
    }
  }

  /** Open the checked real path for writing; see `writeFile`. */
  private async openConfined(path: string, target: string): Promise<FileHandle> {
    const refuse = (error: unknown): never => {
      const code = errnoOf(error);
      if (code === "ELOOP" || code === "EMLINK") {
        // EMLINK: FreeBSD's O_NOFOLLOW errno; Linux and macOS say ELOOP.
        throw new WorkspaceWriteError(
          `refused: a symlink at the final path (it appeared after the check): ${path}`,
        );
      }
      if (code === "ENXIO") {
        throw new WorkspaceWriteError(`refused: not a regular file: ${path}`);
      }
      throw error;
    };
    try {
      return await open(target, OPEN_NEW, 0o666);
    } catch (error) {
      if (errnoOf(error) !== "EEXIST") {
        return refuse(error);
      }
    }
    try {
      return await open(target, OPEN_EXISTING);
    } catch (error) {
      return refuse(error);
    }
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
        `refused: dangling symlink ${target.dangling} (its target does not exist; create it first): ${path}`,
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
