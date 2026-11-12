/**
 * Image references on a message (docs/feat/attachments-core.md).
 *
 * The history stores REFS, never bytes: a `ChatMessage` carries
 * `attachments: AttachmentRef[]`, and only a provider that actually sends the
 * image turns a ref into bytes (from an `AttachmentSource` on the trusted
 * side). A ref is content-addressed: `id` is the sha256 of the bytes, so a
 * source that answers other bytes is detected, never trusted.
 *
 * The ref rides CRITICAL log entries, so every field is bounded but FREE where
 * a later build may need a new value: `mimeType` is a free `image/*` string
 * (never an enum), because an enum would make a newer build's `image/heic`
 * malformed and refuse the whole log (the `MessageNote` rule, session.ts).
 */
import { z } from "zod";

/** A lowercase hex sha256 of the image's bytes. */
export const ATTACHMENT_ID_RE = /^[0-9a-f]{64}$/;

/**
 * The types every provider accepts as an image. Entry points (`Session.send`,
 * the TUI) accept ONLY these; a ref outside them still PARSES (a ref is a free
 * `image/*` string, above) and is sent as a visible placeholder, never read.
 */
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

/** Most refs one message may carry (owner Q4). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 5;

/**
 * Largest image an entry point accepts, in raw bytes (owner override: 15 MB,
 * no client downscale — `docs/feat/attachments-downscale.md` adds it later).
 * A provider's own limit is lower for some providers: its rejection surfaces as
 * a clear error naming the image and the limit, never a generic failure.
 */
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/**
 * The ONE rule a ref `name` obeys: no control character — `\p{Cc}`, so C0, DEL
 * and the C1 block (NEL, CSI) alike. Exported because an entry point that builds
 * a ref must sanitise a name with the wire's own rule, not a copy of it: a C1
 * name would pass a narrower local filter and then throw at `Session.send`,
 * refusing the WHOLE message.
 */
export const ATTACHMENT_NAME_RE = /^[^\p{Cc}]*$/u;

/**
 * One image reference. `name` is display only — never a path — so it carries no
 * control characters; it is absent when the source had no name.
 */
export const AttachmentRefSchema = z.object({
  id: z.string().regex(ATTACHMENT_ID_RE),
  mimeType: z
    .string()
    .min(1)
    .max(64)
    .regex(/^image\/[a-z0-9.+-]+$/),
  size: z.number().int().positive(),
  name: z
    .string()
    .min(1)
    .max(255)
    // No CONTROL character: a newline would break a placeholder line and a tab
    // reads as corruption in a log field. `\p{Cc}` (the Unicode control
    // category, DEL included) rather than a `\u0000-\u001f` range, which the
    // linter treats as a typo — and a plain regex, not `.refine()`, because the
    // JSON Schema export cannot represent a ZodEffects.
    .regex(ATTACHMENT_NAME_RE, "a name carries no control character")
    .optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

/** A message's refs: at least one, at most `MAX_ATTACHMENTS_PER_MESSAGE`. */
export const AttachmentsSchema = z
  .array(AttachmentRefSchema)
  .min(1)
  .max(MAX_ATTACHMENTS_PER_MESSAGE);
export type Attachments = z.infer<typeof AttachmentsSchema>;

/** True when `ref.mimeType` is one every provider accepts. */
export function isKnownImageType(mimeType: string): mimeType is ImageMimeType {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}
