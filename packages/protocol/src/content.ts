/**
 * Content blocks — the ACP-shaped payload used for prompts and for streamed
 * agent output. A message body is an ordered array of these blocks, allowing
 * mixed text / image / embedded-resource content.
 */
import { z } from "zod";
import { AttachmentRefSchema } from "./attachment.ts";

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

/** What `session/prompt` accepts: the update blocks plus a ref-only attachment. */
export const PromptContentBlockSchema = z.discriminatedUnion("type", [
  TextContentSchema,
  ImageContentSchema,
  ResourceContentSchema,
  AttachmentContentSchema,
]);
export type PromptContentBlock = z.infer<typeof PromptContentBlockSchema>;

/** Convenience constructor for the common text block. */
export function text(value: string): ContentBlock {
  return { type: "text", text: value };
}
