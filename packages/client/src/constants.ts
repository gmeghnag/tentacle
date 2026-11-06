/** URI scheme the daemon uses for an embedded unified-diff resource. */
export const DIFF_SCHEME = "diff://";
/** URI scheme for a user hook's intervention on a call: `hook://<action>/<name>`. */
export const HOOK_SCHEME = "hook://";
/**
 * The bound of an eager attach (`attachSession`) with no progress: no first
 * answer to `session/open`, no new snapshot page, reconnects included
 * (docs/feat/session-settings-apply.md S3, F1). A slow transfer that keeps
 * moving is not bounded. Two liveness windows: one dead-link verdict, one
 * redial, one open.
 */
export const ATTACH_TIMEOUT_MS = 30_000;
