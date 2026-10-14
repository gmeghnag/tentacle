/**
 * Content blocks — the ACP-shaped payload used for prompts and for streamed
 * agent output. A message body is an ordered array of these blocks, allowing
 * mixed text / image / embedded-resource content.
 */
import { z } from "zod";

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

/** Convenience constructor for the common text block. */
export function text(value: string): ContentBlock {
  return { type: "text", text: value };
}
