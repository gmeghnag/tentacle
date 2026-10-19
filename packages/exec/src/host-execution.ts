/**
 * Host execution environment — runs tool side-effects directly on the OS where
 * the harness process lives (ADR-005). A container-backed implementation will
 * satisfy the same `ExecutionEnvironment` contract later without changing callers.
 *
 * `exec` combines an optional caller `signal` with an optional `timeoutMs` into a
 * single abort signal so a runaway command is always killed.
 *
 * Writes are confined to the workspace `root` (the launch directory by default):
 * `writeFile` refuses any path that resolves — after following symlinks — outside
 * it. Reads are intentionally unconfined. The shell (`exec`) cannot be confined at
 * the filesystem level on the host; that is gated by the permission engine instead
 * (and fully sandboxed once the container environment lands).
 */
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve, sep } from "node:path";
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

/**
 * Resolve `abs` to its real location, following symlinks on the deepest existing
 * ancestor and re-appending the not-yet-existing tail (which, having been through
 * `path.resolve`, contains no `..`). This catches symlink-based escapes.
 */
function realTarget(abs: string): string {
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) {
      break;
    }
    tail.unshift(basename(existing));
    existing = parent;
  }
  const real = safeRealpath(existing);
  return tail.length > 0 ? resolve(real, ...tail) : real;
}

export class HostExecution implements ExecutionEnvironment {
  readonly id: string;
  private readonly defaultCwd: string;
  private readonly root: string;
  private readonly killGraceMs: number;
  /** Commands whose leader exited (their group was handed to `releaseGroup`). */
  private readonly released = new WeakSet<Subprocess>();

  constructor(config?: HostExecutionConfig) {
    this.id = config?.id ?? "host";
    this.killGraceMs = config?.killGraceMs ?? KILL_GRACE_MS;
    this.defaultCwd = resolve(config?.cwd ?? process.cwd());
    this.root = safeRealpath(resolve(config?.root ?? this.defaultCwd));
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
    const proc = this.spawnShell(command, options);
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
  private spawnShell(command: string, options?: ExecOptions): Subprocess<"ignore", "pipe", "pipe"> {
    const proc = Bun.spawn(["/bin/sh", "-c", command], {
      cwd: options?.cwd ?? this.defaultCwd,
      env: this.childEnv(options),
      stdin: "ignore",
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
    return await Bun.file(resolve(this.defaultCwd, path)).text();
  }

  async writeFile(path: string, contents: string): Promise<void> {
    await Bun.write(this.confineWrite(path), contents);
  }

  /** Absolute write path, or throw if it escapes the workspace root. */
  private confineWrite(path: string): string {
    const abs = resolve(this.defaultCwd, path);
    const target = realTarget(abs);
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new WorkspaceWriteError(
        `refusing to write outside the workspace (${this.root}): ${path}`,
      );
    }
    return abs;
  }
}
