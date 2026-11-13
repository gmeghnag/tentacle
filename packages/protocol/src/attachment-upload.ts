/**
 * `attachment/put` — chunked, resumable image upload into a session's daemon
 * store (docs/feat/attachments-upload.md).
 *
 * The history carries image REFS only (`attachment.ts`); the bytes live where
 * the provider is read, which for a `serve`/worker runtime is the daemon. This
 * method moves them there: one chunk per request, idempotent, resumable —
 * every answer carries `have`, the contiguous bytes the daemon holds from 0,
 * so a dropped link costs at most one window of resent chunks.
 *
 * Its own module, not `attachment.ts`: that file is imported by `session.ts`,
 * and a `put` needs `SessionIdSchema` from there — keeping them apart avoids
 * an import cycle.
 *
 * Additive on the wire: an older daemon answers `MethodNotFound` (the client
 * maps it to a clear "this daemon cannot receive images"), and an older client
 * never sends it. No `PROTOCOL_VERSION` bump, no `mimeType` (the store holds
 * bytes by hash; the type belongs to the REF and is checked where it enters),
 * and no read-back method (the probe below is the only status).
 */
import { z } from "zod";
import { ATTACHMENT_ID_RE, MAX_IMAGE_BYTES } from "./attachment.ts";
import { SessionIdSchema } from "./session.ts";

/** Raw image bytes per `put` — the flow-control sweet spot (docs/feat/attachments-upload.md P9). */
export const ATTACHMENT_CHUNK_BYTES = 256 * 1024;

/** `ATTACHMENT_CHUNK_BYTES` as base64 (349 528 chars): the cap schema-validated before any handler. */
export const ATTACHMENT_CHUNK_B64_MAX = Math.ceil(ATTACHMENT_CHUNK_BYTES / 3) * 4;

/**
 * One chunk. `data: ""` is the PROBE — it asks for `have` without sending
 * bytes, which is how an upload resumes after a drop (and how a re-attached
 * image is deduped). `offset` is the chunk's position from the blob's start.
 */
export const AttachmentPutParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** sha256 of the WHOLE blob, lowercase hex: the store's key and its check. */
  id: z.string().regex(ATTACHMENT_ID_RE),
  /** The blob's declared size; the store reserves it up front (bounded memory). */
  size: z.number().int().positive().max(MAX_IMAGE_BYTES),
  offset: z.number().int().nonnegative(),
  data: z
    .string()
    .max(ATTACHMENT_CHUNK_B64_MAX)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type AttachmentPutParams = z.infer<typeof AttachmentPutParamsSchema>;

/** `have`: contiguous bytes held from 0 (the client resumes there). `complete`: sha256-verified and readable. */
export const AttachmentPutResultSchema = z.object({
  have: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type AttachmentPutResult = z.infer<typeof AttachmentPutResultSchema>;

/**
 * Why the daemon refused a `put` (`AttachmentRefused`'s `data.reason`) — or a
 * prompt's image ref (docs/feat/attachments-prompt.md D3), so a client branches
 * on a reason and never on text: `images_off` (this session's model takes no
 * images), `invalid_ref` (malformed, over the cap, unsupported type) and
 * `not_uploaded` (the daemon holds no complete blob for that id — upload it
 * again), `store_failed` (a `serve` daemon verified the blob but could not
 * make it durable on disk — retry; docs/feat/attachments-durable.md D2). A TS
 * type only, so adding a reason is additive on the wire.
 */
export type AttachmentRefusedReason =
  | "too_large"
  | "store_full"
  | "hash_mismatch"
  | "bad_chunk"
  | "images_off"
  | "invalid_ref"
  | "not_uploaded"
  | "store_failed";
