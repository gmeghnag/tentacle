import { FFIType, dlopen, ptr } from "bun:ffi";
/**
 * Process groups for spawned shells, and the process-exit net.
 *
 * Every command runs as `/bin/sh -c …` in its OWN process group (spawned
 * `detached`), so `killGroup` reaches everything `sh` started — pipelines,
 * `a && b`, `npm run dev`'s node child — instead of orphaning it to PID 1.
 *
 * Being detached, those groups no longer get the terminal's SIGINT/SIGHUP, so
 * the explicit net below is the ONLY thing that stops a job outliving
 * tentacle: a registry of live pgids that a `process.on("exit")` handler
 * SIGKILLs. That handler must live on the process's MAIN thread — a Worker's
 * exit handler does not run while it holds a live child, nor on
 * `worker.terminate()` (docs/fix/background-process-groups.md, Revision). So:
 *  - on the main thread `trackGroup` registers the pgid and lazily installs the
 *    net once (plus SIGHUP/SIGTERM listeners that route to `process.exit`,
 *    since a listener-less signal ends the process WITHOUT running `exit`);
 *  - in a Worker it only forwards add/remove through `setGroupForwarder`, and
 *    the main thread applies them with `applyGroupMessage`. Same OS process,
 *    so the main can signal the worker's groups.
 * A signal inherited as IGNORED (`nohup tentacle serve`) gets no listener: it
 * must keep being ignored, not become an exit.
 *
 * A group can outlive its leader: `cmd > log 2>&1 &` exits `sh` at once while
 * `cmd` lives on in the group. So the leader's exit only RELEASES the group
 * (`releaseGroup`): an empty group is untracked, a non-empty one stays tracked
 * as "lingering" and is re-probed until it empties. A group with members keeps
 * its pgid, so a lingering pgid is never a recycled one.
 */
import { isMainThread } from "node:worker_threads";

export type GroupOp = "add" | "remove";
/** Carries a worker's group add/remove to the main thread. */
export type GroupForwarder = (op: GroupOp, pgid: number) => void;

/** The object message a worker posts to forward a group (see `cli/worker.ts`). */
export interface JobGroupMessage {
  readonly type: "job-group";
  readonly op: GroupOp;
  readonly pgid: number;
}

/**
 * Whether each signal was inherited as ignored (`nohup`, `trap '' HUP; exec …`).
 * Node/Bun expose no API for a signal's disposition, so ask libc:
 * `sigaction(signum, NULL, &old)`. `sa_handler` is the first field of `struct
 * sigaction` on macOS and glibc (the pod binary is glibc-linked) and `SIG_IGN`
 * is 1. Must run before any JS listener for the signal exists (Bun's own
 * handler then replaces the disposition), hence at module load. Any failure →
 * "not ignored", i.e. install the listener as if there were no probe.
 */
function probeIgnored(signums: readonly number[]): boolean[] {
  try {
    const libc = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
    const { symbols, close } = dlopen(libc, {
      sigaction: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    });
    try {
      return signums.map((signum) => {
        const old = new BigUint64Array(32); // ≥ sizeof(struct sigaction) on every libc
        return symbols.sigaction(signum, null, ptr(old)) === 0 && old[0] === 1n;
      });
    } finally {
      close();
    }
  } catch {
    return signums.map(() => false);
  }
}

// SIGHUP = 1, SIGTERM = 15 on both macOS and Linux.
const [hupIgnored, termIgnored] = isMainThread ? probeIgnored([1, 15]) : [false, false];

/** How often lingering groups are re-probed for emptiness. */
export const LINGER_PROBE_MS = 5000;

const live = new Set<number>();
let forwarder: GroupForwarder | null = null;
let netInstalled = false;
/** This thread's released-but-not-empty groups (whoever spawned them probes). */
const lingering = new Set<number>();
let probeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * A pgid we may signal as `-pgid`. Never 0 (our own group) or 1 (`kill(-1)` =
 * every process we can signal), never our own pid, never a non-integer.
 */
function isSignalablePgid(pgid: unknown): pgid is number {
  return Number.isInteger(pgid) && (pgid as number) > 1 && pgid !== process.pid;
}

/**
 * Signal the whole process group led by `pgid`. Never throws: a group already
 * gone (`ESRCH`) or an invalid pgid returns false.
 */
export function killGroup(pgid: number, signal: NodeJS.Signals): boolean {
  if (!isSignalablePgid(pgid)) {
    return false;
  }
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

function killAll(): void {
  for (const pgid of live) {
    killGroup(pgid, "SIGKILL");
  }
}

function installNet(): void {
  if (netInstalled) {
    return;
  }
  netInstalled = true;
  // SIGKILL, not TERM: an exit handler is synchronous and cannot wait out a
  // grace period. Orderly shutdown is `BackgroundJobs.dispose()`'s job.
  process.on("exit", killAll);
  // SIGINT is left alone: every mode already routes it to `process.exit`.
  if (!hupIgnored) {
    process.on("SIGHUP", () => process.exit(129));
  }
  if (!termIgnored) {
    process.on("SIGTERM", () => process.exit(143));
  }
}

/** Register a live group so tentacle's exit kills it. */
export function trackGroup(pgid: number): void {
  if (!isSignalablePgid(pgid)) {
    return;
  }
  if (!isMainThread) {
    forwarder?.("add", pgid);
    return;
  }
  live.add(pgid);
  installNet();
}

/** Forget a group whose leader exited (so the net never hits a recycled pgid). */
export function untrackGroup(pgid: number): void {
  if (!isSignalablePgid(pgid)) {
    return;
  }
  if (!isMainThread) {
    forwarder?.("remove", pgid);
    return;
  }
  live.delete(pgid);
}

/** Whether the group still has members. `EPERM` counts as alive (conservative). */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code !== "ESRCH";
  }
}

/**
 * The leader of `pgid` exited: forget the group if it is empty, else keep it
 * tracked as lingering (children it backgrounded still hold it) until a probe
 * finds it empty.
 */
export function releaseGroup(pgid: number): void {
  if (!isSignalablePgid(pgid)) {
    return;
  }
  if (!groupAlive(pgid)) {
    untrackGroup(pgid);
    return;
  }
  lingering.add(pgid);
  if (probeTimer === null) {
    probeTimer = setInterval(probeLingering, LINGER_PROBE_MS);
    probeTimer.unref();
  }
}

/** Untrack every lingering group that has emptied (run by the probe timer). */
export function probeLingering(): void {
  for (const pgid of lingering) {
    if (!groupAlive(pgid)) {
      lingering.delete(pgid);
      untrackGroup(pgid);
    }
  }
  if (lingering.size === 0 && probeTimer !== null) {
    clearInterval(probeTimer);
    probeTimer = null;
  }
}

/** Whether `pgid` was released by its leader but still has members. */
export function isLingering(pgid: number): boolean {
  return lingering.has(pgid);
}

/** In a Worker: where to send group add/remove (the main thread owns the net). */
export function setGroupForwarder(fn: GroupForwarder | null): void {
  forwarder = fn;
}

/**
 * Main thread: apply a worker's forwarded `job-group` message. Returns true if
 * `data` was one (well-formed or not), so the caller stops routing it; a
 * malformed one is dropped, never turned into a `kill(-0|-1|NaN)`.
 */
export function applyGroupMessage(data: unknown): boolean {
  if (
    typeof data !== "object" ||
    data === null ||
    (data as { type?: unknown }).type !== "job-group"
  ) {
    return false;
  }
  const { op, pgid } = data as { op?: unknown; pgid?: unknown };
  if (!isSignalablePgid(pgid)) {
    return true;
  }
  if (op === "add") {
    trackGroup(pgid);
  } else if (op === "remove") {
    untrackGroup(pgid);
  }
  return true;
}

/** The pgids the net would kill now (tests). */
export function trackedGroups(): readonly number[] {
  return [...live];
}
