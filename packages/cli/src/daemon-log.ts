/**
 * Persistent capture of daemon-side (worker) errors, so a crash in an RPC
 * handler is never silently reduced to the client's opaque "internal error".
 *
 * The worker's `Connection` is wired to append here on every reported error
 * (`worker.ts`). The file is append-only, timestamped, and includes the stack —
 * so an error that recurs can be retrieved and reported verbatim, long after the
 * TUI line scrolled away. Writing to a FILE (not stdout) is deliberate: the TUI
 * owns the terminal during a session, so a live write would corrupt the render.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** The daemon error log path for a given config dir (`<configDir>/logs/daemon-errors.log`). */
export function daemonErrorLogPath(configDir: string): string {
  return join(configDir, "logs", "daemon-errors.log");
}

/**
 * Append one error (ISO timestamp + message + stack) to the daemon error log.
 * Best-effort: never throws (a logging failure must not take down the daemon).
 * Returns the log path so the caller can point the user at it.
 */
export function logDaemonError(configDir: string, error: unknown): string {
  const path = daemonErrorLogPath(configDir);
  try {
    const err = error instanceof Error ? error : new Error(String(error));
    const entry = `[${new Date().toISOString()}] ${err.message}\n${err.stack ?? "(no stack)"}\n\n`;
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entry);
  } catch {
    // best-effort — logging must never break the daemon.
  }
  return path;
}
