/**
 * A `VersionMismatch` the user can act on (docs/feat/version-mismatch-notice.md).
 * Pure. Every daemon since `VersionMismatchData` words the advice itself and
 * sends a report in the error's `data`: its message is shown unchanged. A
 * daemon that sends NO `data` predates the report — so its protocol is older
 * than any client that has this module — and the client adds the advice.
 * Decided from the error code and the report's presence, never from the text
 * (and never from whether a later daemon's report fits today's schema).
 */
import { DomainErrorCode, RpcError } from "@tentacle/transport";

/** Where the daemon runs — a laptop-side fact: `connect` → `serve`; `run`/`attach` → `container`. */
export type DaemonKind = "serve" | "container";

const OLDER = "the daemon runs an older tentacle (it does not report its version)";

export const OLD_DAEMON_ADVICE = `${OLDER}: update the daemon: run "tentacle update" on that host and restart "tentacle serve"`;

/** The advice for a daemon older than the report, by where it runs. */
export function oldDaemonAdvice(kind: DaemonKind): string {
  return kind === "container"
    ? `${OLDER}: update the container's tentacle: run "tentacle attach" again from an up-to-date laptop (it replaces an older one)`
    : OLD_DAEMON_ADVICE;
}

/** `null` unless `error` is a `VersionMismatch`; else the error to show. */
export function explainVersionMismatch(error: unknown, kind: DaemonKind = "serve"): Error | null {
  if (!(error instanceof RpcError) || error.code !== DomainErrorCode.VersionMismatch) {
    return null;
  }
  if (error.data !== undefined) {
    return error;
  }
  return new RpcError(error.code, `${error.message} — ${oldDaemonAdvice(kind)}`);
}
