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
    let entry = `[${new Date().toISOString()}] ${err.message}\n${err.stack ?? "(no stack)"}\n`;
    // Some errors (e.g. ModelRequestError) truncate their `message` for the TUI
    // but retain the full upstream response body on a `body` field. That body is
    // the point of this log (a truncated tool-call, a provider stack trace), so
    // append it verbatim whenever the message does not already contain it.
    const body = (err as { body?: unknown }).body;
    if (typeof body === "string" && body.length > 0 && !err.message.includes(body)) {
      entry += `Full response body:\n${body}\n`;
    }
    // A wrapper (e.g. ModelConnectionError) keeps the original as `cause`.
    // Bun's connection errors have no stack and carry their identity on
    // `code`, so name, message and code are written out explicitly.
    const cause = err.cause;
    if (cause !== undefined) {
      const c = cause instanceof Error ? cause : new Error(String(cause));
      const code = (c as { code?: unknown }).code;
      entry += `Cause: ${c.name}: ${c.message}${code !== undefined ? ` (code ${String(code)})` : ""}\n`;
      if (c.stack) {
        entry += `${c.stack}\n`;
      }
    }
    entry += "\n";
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, entry);
  } catch {
    // best-effort — logging must never break the daemon.
  }
  return path;
}

/** What `logModelRetry` records (structurally the providers' `RetryInfo`). */
export interface ModelRetryLogEntry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly code: string;
  readonly delayMs: number;
  readonly providerId: string;
}

/**
 * Append one line for a retried model-connection drop. Nothing reaches the
 * screen when the retry recovers, so this line is the only trace — and what
 * tells how often the connection actually blips. Best-effort, never throws.
 */
export function logModelRetry(configDir: string, info: ModelRetryLogEntry): void {
  try {
    const path = daemonErrorLogPath(configDir);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `[${new Date().toISOString()}] model retry ${info.attempt}/${info.maxAttempts - 1} after ${info.code} (no event delivered yet, ${info.providerId}), waiting ${info.delayMs}ms\n\n`,
    );
  } catch {
    // best-effort — logging must never break the daemon.
  }
}
