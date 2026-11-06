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
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
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

/** Symlink hops followed before giving up (the kernel's own limit is ~40). */
const MAX_LINK_HOPS = 40;

/**
 * Resolve `abs` to its real location, following symlinks on the deepest existing
 * ancestor and re-appending the not-yet-existing tail (which, having been through
 * `path.resolve`, contains no `..`). This catches symlink-based escapes —
 * including a DANGLING link (`existsSync` would call it absent, and the write
 * would then create its target wherever it points): its target is resolved in
 * turn. Too many hops (a loop) → `undefined`, which the caller refuses.
 */
function realTarget(abs: string, hops = 0): string | undefined {
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
  if (!existsSync(existing) && entryExists(existing)) {
    // A dangling symlink (or a loop): follow it by hand.
    if (hops >= MAX_LINK_HOPS) {
      return undefined;
    }
    let link: string;
    try {
      link = readlinkSync(existing);
    } catch {
      return undefined;
    }
    return realTarget(resolve(dirname(existing), link, ...tail), hops + 1);
  }
  const real = safeRealpath(existing);
  return tail.length > 0 ? resolve(real, ...tail) : real;
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
 * meaningless) or through a symlink loop, is dropped and reported.
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
    const real = realTarget(resolve(dir));
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
  /** Commands whose leader exited (their group was handed to `releaseGroup`). */
  private readonly released = new WeakSet<Subprocess>();

  constructor(config?: HostExecutionConfig) {
    this.id = config?.id ?? "host";
    this.killGraceMs = config?.killGraceMs ?? KILL_GRACE_MS;
    this.readHint = config?.readHint;
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

  async writeFile(path: string, contents: string): Promise<void> {
    await Bun.write(this.confineWrite(path), contents);
  }

  /** Absolute write path, or throw if it escapes the workspace root and every writable dir. */
  private confineWrite(path: string): string {
    const abs = resolve(this.defaultCwd, path);
    const target = realTarget(abs);
    if (
      target === undefined ||
      ![this.root, ...this.writableRoots].some((root) => within(root, target))
    ) {
      const allowed =
        this.writableRoots.length > 0 ? `; writable dirs: ${this.writableRoots.join(", ")}` : "";
      throw new WorkspaceWriteError(
        `refusing to write outside the workspace (${this.root}${allowed}): ${path}`,
      );
    }
    return abs;
  }
}
