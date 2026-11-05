import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { RefusalError, StaleBuildError, type WorkloadNotFoundError } from "./engine-host.ts";
import { untrustedText } from "./untrusted-text.ts";

/** The most the file keeps: the TAIL of what the pod daemon wrote to its stderr. */
export const DAEMON_LOG_CAP_BYTES = 64 * 1024;

/**
 * The pod daemon's stderr, kept in a per-run file and never written to the
 * terminal (docs/feat/run-prompt.md round 4): the daemon says routine things
 * there (`[daemon] bridge: no resident … starting one`) and the laptop adds its
 * own RPC errors (`[laptop rpc] model connection lost …`). While the TUI owns the
 * screen nothing may be written raw anyway (AGENTS §7).
 */
export interface DaemonLog {
  /** Append text; the file keeps the last `cap` bytes. Never throws. */
  onStderr(text: string): void;
  /** The file, or undefined if it could not be created (then nothing is kept). */
  readonly path: string | undefined;
  /** Something was written (a startup failure names the log only then). */
  hasContent(): boolean;
}

/** Append `text`; over `cap` bytes the OLDEST are dropped (the newest stay). */
function appendBounded(file: string, text: string, cap: number): void {
  appendFileSync(file, text);
  if (statSync(file).size > cap) {
    const data = readFileSync(file);
    writeFileSync(file, Uint8Array.from(data.subarray(data.length - cap)));
  }
}

/**
 * Open the log at `path` for APPENDING (created 0600 if absent, narrowed to 0600
 * if not; earlier runs' text stays, round 5). `label` (`run box`, `attach box`)
 * writes one separator line first: `--- <ISO time> <label> ---`. The file stays
 * under `capBytes`, newest bytes kept. `undefined` or a path that cannot be
 * written gives a log that keeps nothing and has no `path`.
 */
export function openDaemonLog(
  path: string | undefined,
  capBytes: number = DAEMON_LOG_CAP_BYTES,
  label?: string,
): DaemonLog {
  let file: string | undefined;
  if (path !== undefined) {
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, "", { mode: 0o600 });
      chmodSync(path, 0o600);
      if (label !== undefined) {
        appendBounded(path, `--- ${new Date().toISOString()} ${label} ---\n`, capBytes);
      }
      file = path;
    } catch {
      file = undefined;
    }
  }
  return {
    onStderr(text) {
      if (file === undefined) {
        return;
      }
      try {
        appendBounded(file, text, capBytes);
      } catch {
        // A log that cannot be written must never break the run.
      }
    },
    get path() {
      return file;
    },
    hasContent() {
      if (file === undefined) {
        return false;
      }
      try {
        return statSync(file).size > 0;
      } catch {
        return false;
      }
    },
  };
}

/** `path` with the home directory written `~` (what the one-line report shows). */
export function tildePath(path: string, home: string = homedir()): string {
  return home !== "" && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
}

const SHORT_CAUSE_MAX = 120;

function firstLine(message: string): string {
  return (
    message
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l !== "") ?? "unknown error"
  );
}

/** The first non-empty line of a failure's text, cut to ~120 chars (`…`). */
export function shortCause(message: string): string {
  const first = firstLine(message);
  return first.length > SHORT_CAUSE_MAX ? `${first.slice(0, SHORT_CAUSE_MAX - 1)}…` : first;
}

/**
 * A failure of setup/startup, for the one-line report (docs/feat/run-prompt.md
 * round 4): the WHOLE text goes to the run's log, the error is tagged with the
 * log's path (`failureLogPath`), and its message stays as it was (callers and
 * tests still match on it). A non-Error, or a log that was not created, is
 * returned untouched. Returns `error` so it can be thrown in one expression.
 */
export function recordFailure(error: unknown, log: DaemonLog): unknown {
  if (!(error instanceof Error) || log.path === undefined) {
    return error;
  }
  log.onStderr(`[tentacle] failed: ${error.message}\n`);
  Object.defineProperty(error, "logPath", { value: log.path, enumerable: false });
  return error;
}

/** The log path `recordFailure` tagged on `error`, if any. */
export function failureLogPath(error: unknown): string | undefined {
  const path = (error as { logPath?: unknown } | null | undefined)?.logPath;
  return typeof path === "string" ? path : undefined;
}

/**
 * `[container] failed: <short cause> · log: ~/…/daemon.log\n` — the ONE line a
 * failed startup prints; the log part only when the failure was recorded.
 */
export function failedLine(noun: string, error: unknown, home: string = homedir()): string {
  if (error instanceof StaleBuildError) {
    return `[${noun}] ${untrustedText(error.message)}\n`;
  }
  const path = failureLogPath(error);
  const where = path === undefined ? "" : ` · log: ${tildePath(path, home)}`;
  const up = stillUpName(error);
  const left = up === undefined ? "" : ` · still up: tentacle rm ${untrustedText(up)}`;
  // The cause can carry pod-supplied text: sanitised before it reaches the terminal.
  // A refusal is short and complete at the source: never cut mid-hint.
  const text = error instanceof Error ? error.message : String(error);
  const cause = untrustedText(error instanceof RefusalError ? firstLine(text) : shortCause(text));
  return `[${noun}] failed: ${cause}${where}${left}\n`;
}

/**
 * `attach <name>` where `<name>` is not in `tentacle ps` and the engine has no
 * such workload either: ONE line, no `failed:`, no log, never cut.
 */
export function notListedLine(name: string, error: WorkloadNotFoundError): string {
  return `[error] ${untrustedText(name)}: not in tentacle ps, and no ${error.noun} with that name ${untrustedText(error.place)}\n`;
}

/**
 * A setup failure that left a KEPT workload up (it exists, nothing removed it):
 * tag the error with its name so the one failure line says how to remove it.
 */
export function markStillUp(error: unknown, name: string): unknown {
  if (error instanceof Error) {
    Object.defineProperty(error, "stillUp", { value: name, enumerable: false });
  }
  return error;
}

function stillUpName(error: unknown): string | undefined {
  const name = (error as { stillUp?: unknown } | null | undefined)?.stillUp;
  return typeof name === "string" ? name : undefined;
}
