/**
 * Per-path mutual exclusion for read-modify-write file tools.
 *
 * `fs_edit` / `fs_multi_edit` read a file, transform it, and write it back; two
 * overlapping edits on one path silently lose an update. `PathLocks` serialises
 * the critical section per path (FIFO, in-process). It is not a file lock: a
 * shell `sed -i` bypasses it, and two spellings of one file the lexical
 * normalisation cannot unify get two locks: a relative vs an absolute path,
 * differently-cased names on a case-insensitive filesystem (`F.txt` / `f.txt`),
 * and paths through a symlink (`link/f` / `real/f`). Known limits, not handled
 * (the env contract has no cwd, case rules or realpath).
 *
 * One instance per `ExecutionEnvironment` (`pathLocksFor`): the parent agent and
 * every sub-agent share their env, so they share the locks.
 */
import type { ExecutionEnvironment } from "./execution.ts";

/** Lexical key: collapse `.`/`..`/repeated slashes so `a//b` and `a/./b` agree. */
export function lockKey(path: string): string {
  const absolute = path.startsWith("/");
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") {
        parts.pop();
      } else if (!absolute) {
        parts.push(part);
      }
    } else {
      parts.push(part);
    }
  }
  return (absolute ? "/" : "") + parts.join("/");
}

/**
 * The round executor's resource name for a file path
 * (docs/feat/parallel-tools.md): the case-folded BASENAME of `lockKey`.
 * Deliberately coarse — `a.ts`, `./x/../a.ts`, `/ws/a.ts` and `A.ts` all
 * agree (which `PathLocks` does not unify) at the cost of serialising two
 * different files that share a basename. A false conflict only serialises.
 * Paths through symlinks with different basenames stay undetected.
 */
export function pathResource(path: string): string {
  const key = lockKey(path);
  const base = key.slice(key.lastIndexOf("/") + 1);
  return `path:${base.toLowerCase()}`;
}

export class PathLocks {
  /** Tail of each path's queue; an entry is removed once its queue drains. */
  private readonly tails = new Map<string, Promise<void>>();

  /** Paths with a holder or waiter right now (0 when idle); for tests. */
  get size(): number {
    return this.tails.size;
  }

  /** Run `fn` while holding `path`'s lock. Released on return or throw. */
  async withLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = lockKey(path);
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }
}

const byEnv = new WeakMap<ExecutionEnvironment, PathLocks>();

/** The shared `PathLocks` of an environment (created on first use). */
export function pathLocksFor(env: ExecutionEnvironment): PathLocks {
  let locks = byEnv.get(env);
  if (!locks) {
    locks = new PathLocks();
    byEnv.set(env, locks);
  }
  return locks;
}
