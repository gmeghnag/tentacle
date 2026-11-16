/**
 * Content blocks — the ACP-shaped payload used for prompts and for streamed
 * agent output. A message body is an ordered array of these blocks, allowing
 * mixed text / image / embedded-resource content.
 */
import { z } from "zod";
import {
  ATTACHMENT_ID_RE,
  ATTACHMENT_NAME_RE,
  AttachmentRefSchema,
  MAX_IMAGE_BYTES,
} from "./attachment.ts";

export const TextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const ImageContentSchema = z.object({
  type: z.literal("image"),
  mimeType: z.string().min(1),
  /** Base64-encoded bytes. */
  data: z.string(),
});

export const ResourceContentSchema = z.object({
  type: z.literal("resource"),
  uri: z.string().min(1),
  mimeType: z.string().optional(),
  /** Inline text contents, when the resource is textual. */
  text: z.string().optional(),
});

export const ContentBlockSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  ResourceContentSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

/**
 * A prompt names an image by REF, never by bytes
 * (docs/feat/attachments-prompt.md): the daemon that runs the model already
 * holds the blob (`attachment/put`), and the laptop that runs it keeps its own
 * (`LaptopImages`). Prompt-only on purpose — a daemon never emits this block, so
 * it stays out of `ContentBlockSchema` and the `session/update` schemas need no
 * class (`UPDATE_CLASS`) and no `client/mapping.ts` reverse mapping.
 */
export const AttachmentContentSchema = z.object({
  type: z.literal("attachment"),
  ref: AttachmentRefSchema,
});
export type AttachmentContent = z.infer<typeof AttachmentContentSchema>;

/**
 * The most text an attached document carries into a prompt (docs/feat/pdf-read.md
 * Q4 (a), the A/V transcript cap): a client-extracted `source.text` over it is
 * refused, and the daemon cuts its own extraction to it.
 */
export const MAX_DOCUMENT_TEXT_CHARS = 64 * 1024;

/**
 * Where an attached document's content comes from — EXACTLY one, by its tag
 * (the JSON Schema export takes no untagged union):
 * `ref`: its bytes are in this daemon's store (`attachment/put`; id = sha256,
 * size bounded by the upload cap), the daemon extracts;
 * `text`: the client extracted it (a pod, where PDF bytes never go).
 */
export const DocumentSourceSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("ref"),
    id: z.string().regex(ATTACHMENT_ID_RE),
    size: z.number().int().positive().max(MAX_IMAGE_BYTES),
  }),
  z.object({
    type: z.literal("text"),
    text: z.string().max(MAX_DOCUMENT_TEXT_CHARS),
    pages: z.number().int().positive().max(1_000_000),
  }),
]);
export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

/**
 * An attached document (docs/feat/pdf-read.md D4). Prompt-only, like
 * `attachment`: no update class, no reverse mapping; the daemon turns it into a
 * `<file>` block in the user text (never a PDF ref in the log).
 */
export const DocumentContentSchema = z.object({
  type: z.literal("document"),
  // A literal on purpose: a daemon that does not know a kind must refuse the
  // prompt loudly (`InvalidParams`), never drop the document.
  kind: z.literal("pdf"),
  name: z.string().min(1).max(255).regex(ATTACHMENT_NAME_RE, "a name carries no control character"),
  source: DocumentSourceSchema,
});
export type DocumentContent = z.infer<typeof DocumentContentSchema>;

/** What `session/prompt` accepts: the update blocks plus a ref-only attachment and a document. */
export const PromptContentBlockSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  ResourceContentSchema,
  AttachmentContentSchema,
  DocumentContentSchema,
]);
export type PromptContentBlock = z.infer<typeof PromptContentBlockSchema>;

/** Convenience constructor for the common text block. */
export function text(value: string): ContentBlock {
  return { type: "text", text: value };
}
