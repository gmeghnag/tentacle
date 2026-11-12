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
/**
 * How long a dropped `upload()` waits for its link to come back before it
 * rejects with `UploadLinkLostError` (docs/feat/attachments-upload.md fix
 * round 1, finding 1). A drop mid-upload is resumable, so waiting is right —
 * but not for ever: the caller is holding an image and a spinner, and the
 * daemon keeps what landed, so failing is recoverable where hanging is not.
 */
export const UPLOAD_RECONNECT_MS = 30_000;
