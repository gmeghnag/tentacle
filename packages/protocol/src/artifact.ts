/**
 * `artifact/list` + `artifact/read` — the model PRESENTS something to the user
 * (an image, an HTML page, a PDF, Markdown, a file) and a client reads its
 * METADATA and then its BYTES (docs/feat/model-artifacts.md).
 *
 * The mirror of `attachment-upload.ts`, with the traffic the other way: an
 * artifact version is a content-addressed SNAPSHOT taken when the model
 * presented it, so `sha256`/`size` here are the client's own check — a daemon
 * that is a pod is NOT trusted (AGENTS §7), and a client accepts the bytes it
 * received only if every chunk has the announced length and the whole hashes to
 * `sha256`.
 *
 * Every field is bounded because a present can originate in a pod:
 *
 * - `artifactId` is a model-chosen SLUG (`ARTIFACT_ID_RE`) — never a path, so it
 *   can never name a file on anyone's disk;
 * - `title` and `source` are display-only, so they carry no control character
 *   (`ATTACHMENT_NAME_RE`, the ref rule);
 * - `size` is capped at `MAX_ARTIFACT_BYTES` (20 MiB), so neither a client nor
 *   a UI can be made to buffer more than that (the frame itself fails to parse
 *   past it — a hostile 2 GiB announcement never becomes a card);
 * - `mimeType`/`kind` are FREE strings (the `AttachmentRefSchema` rule): an enum
 *   would make a NEWER daemon's kind malformed and refuse the whole frame.
 *   Clients branch on the closed `ARTIFACT_KINDS` through `artifactKindOf`,
 *   which maps an unknown kind to `"other"` — one pure function, not a schema.
 *
 * Additive on the wire: two methods and one error code. An older daemon answers
 * `MethodNotFound` (the client says "needs a newer tentacle on <computer>"), and
 * an older client never calls them and drops the free `artifact` field on
 * `tool_call_update` (showing the tool's text). No `PROTOCOL_VERSION` bump.
 */
import { z } from "zod";
import { ATTACHMENT_CHUNK_B64_MAX, ATTACHMENT_CHUNK_BYTES } from "./attachment-upload.ts";
import { ATTACHMENT_ID_RE, ATTACHMENT_NAME_RE } from "./attachment.ts";
import { SessionIdSchema } from "./session.ts";

/**
 * An artifact id: a lowercase slug, 1–64 chars, starting alphanumeric. The model
 * mints one (`id`) or the daemon does (`a1`, `a2`…). A slug — never a path — so
 * it is safe as a URL fragment, a React key and a temp-file comment alike.
 */
export const ARTIFACT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Largest artifact version, in raw bytes (owner Q3). One version = one snapshot. */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;

/** Most metas one `artifact/list` answers (older versions included); see `truncated`. */
export const MAX_ARTIFACT_LIST = 500;

/**
 * The CLOSED kind set every client branches on: which viewer, which extension a
 * temp file gets, whether a kind may ever be handed to an OS opener. The wire's
 * `kind` is a free string; `artifactKindOf` is the only place it is narrowed.
 *
 * `"chart"` is a CLIENT kind, not a wire one (docs/feat/model-charts.md D3/C8):
 * the `chart` tool presents its canonical spec JSON under it, so the gallery can
 * filter and thumbnail it, and a build whose list predates it files the artifact
 * as `other` — the same narrow, no special case, no protocol version.
 */
export const ARTIFACT_KINDS = [
  "image",
  "svg",
  "html",
  "pdf",
  "markdown",
  "text",
  "chart",
  "other",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/**
 * ONE artifact VERSION. `version` counts from 1 per `artifactId`; older versions
 * stay listed and readable (re-presenting an id is a new version, not a
 * replacement). `callId` is the `present` tool call, so a resumed transcript can
 * put the card under its row.
 */
export const ArtifactMetaSchema = z.object({
  artifactId: z.string().regex(ARTIFACT_ID_RE),
  version: z.number().int().positive(),
  /** sha256 of the bytes, lowercase hex: the store's key and the client's check. */
  sha256: z.string().regex(ATTACHMENT_ID_RE),
  size: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
  /** Free `type/subtype`, like a ref's: never an enum (a newer type must parse). */
  mimeType: z
    .string()
    .min(1)
    .max(127)
    .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  /** Free `kind`: map it with `artifactKindOf`, never branch on the raw string. */
  kind: z.string().min(1).max(32),
  /** Shown on the card and as the artifact's name. Display only. */
  title: z.string().min(1).max(120).regex(ATTACHMENT_NAME_RE),
  /** The `present` call that produced this version. */
  callId: z.string().min(1).max(256),
  /** Daemon clock, display only (never compared across machines). */
  createdAt: z.number().int().nonnegative(),
  /** Workspace-relative path it was read from, display only; absent for generated content. */
  source: z.string().max(512).regex(ATTACHMENT_NAME_RE).optional(),
  /** Images: the dimensions sniffed daemon-side, so a card can say `1280×720`. */
  width: z.number().int().positive().max(65535).optional(),
  height: z.number().int().positive().max(65535).optional(),
});
export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

/**
 * Which viewer a client uses: one pure narrowing of the wire's free `kind` onto
 * the closed set. An unknown kind from a NEWER daemon reads as `"other"` — a
 * generic file (save/Share), never something a viewer would execute.
 */
export function artifactKindOf(meta: { readonly kind: string }): ArtifactKind {
  return (ARTIFACT_KINDS as readonly string[]).includes(meta.kind)
    ? (meta.kind as ArtifactKind)
    : "other";
}

/** `artifact/list`: the artifacts of ONE session this connection has open. */
export const ArtifactListParamsSchema = z.object({
  sessionId: SessionIdSchema,
});
export type ArtifactListParams = z.infer<typeof ArtifactListParamsSchema>;

/**
 * Every version of every artifact of the session, OLDEST FIRST (the order the
 * gallery folds them in). `truncated` says more versions exist than
 * `MAX_ARTIFACT_LIST` (a client shows the newest it has and notes the cut).
 */
export const ArtifactListResultSchema = z.object({
  artifacts: z.array(ArtifactMetaSchema).max(MAX_ARTIFACT_LIST),
  truncated: z.boolean().optional(),
});
export type ArtifactListResult = z.infer<typeof ArtifactListResultSchema>;

/**
 * `artifact/read`: ONE chunk. `offset` counts raw bytes from the version's start
 * and must be a multiple of `ATTACHMENT_CHUNK_BYTES` (the daemon refuses a
 * misaligned one), which makes a read resumable: a dropped link costs the chunk
 * in flight, never the whole file.
 */
export const ArtifactReadParamsSchema = z.object({
  sessionId: SessionIdSchema,
  sha256: z.string().regex(ATTACHMENT_ID_RE),
  offset: z.number().int().nonnegative(),
});
export type ArtifactReadParams = z.infer<typeof ArtifactReadParamsSchema>;

/**
 * At most one chunk of bytes (base64), plus the version's declared total size.
 * `size` is bounded like a meta's: a client may size its buffer or its progress
 * from the read reply, so a hostile 2 GiB announcement must fail to parse here
 * rather than become a `reserve`. (The client still checks `size === meta.size`.)
 */
export const ArtifactReadResultSchema = z.object({
  data: z
    .string()
    .max(ATTACHMENT_CHUNK_B64_MAX)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
  size: z.number().int().positive().max(MAX_ARTIFACT_BYTES),
});
export type ArtifactReadResult = z.infer<typeof ArtifactReadResultSchema>;

/**
 * Why an `artifact/read` failed (`DomainErrorCode.ArtifactUnavailable`'s
 * `data.reason`): `unknown` (this session's store holds no such version — ask to
 * present it again), `evicted` (a memory-host daemon dropped the bytes to stay
 * in budget; the meta is still listed) and `store_failed` (the `serve` daemon
 * could not read its disk). A TS type only, so adding a reason is additive.
 */
export type ArtifactUnavailableReason = "unknown" | "evicted" | "store_failed";
