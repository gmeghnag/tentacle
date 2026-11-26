/**
 * Tool images on demand (docs/feat/image-view.md D1): the pictures `fs_read`
 * extracts go into the session's attachment store, the text keeps a marker
 * with a 12-hex ref, and `image_view` puts exactly ONE of them on the wire.
 *
 * Pure: the store contract, the ref normaliser, the label and the limits. The
 * store itself is daemon-side (`AttachmentStore.putTool`); a provider never
 * sees this write-capable type (its `ChatRequest.attachments` stays a
 * read-only `AttachmentSource`).
 */
import type { AttachmentRef } from "@tentacle/protocol";
import { sanitizeAttachmentName } from "./attachments.ts";
import { DEFAULT_PDF_IMAGE_LIMITS, type PdfImageLimits } from "./pdf-images.ts";

/** The tool's name: what the model calls, what the sub-agent filter excludes. */
export const IMAGE_VIEW_TOOL_NAME = "image_view";

/** `detail: "low"`'s long edge, px (the `high` one is the extraction's `maxEdge`, 1568). */
export const TOOL_IMAGE_LOW_EDGE = 768;

/** How many hex characters of an id a marker shows (and `image_view` echoes). */
export const TOOL_IMAGE_REF_CHARS = 12;

/** `model.imageDetail`: `auto` lets the model choose per call. */
export type ImageDetailSetting = "auto" | "low" | "high";

/** The extraction limits of a read that keeps its images for `image_view`. */
export function toolImageLimits(base: PdfImageLimits = DEFAULT_PDF_IMAGE_LIMITS): PdfImageLimits {
  return { ...base, lowEdge: TOOL_IMAGE_LOW_EDGE };
}

/** One variant as the extraction hands it to the store. */
export interface ToolImageVariantInput {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** One stored variant: its ref (named with the entry's label) and its pixel size. */
export interface ToolImageVariant {
  readonly ref: AttachmentRef;
  readonly width: number;
  readonly height: number;
}

/** A stored picture: both variants (`low` IS `high` when the picture is ≤ 768 px). */
export interface ToolImageEntry {
  readonly high: ToolImageVariant;
  readonly low: ToolImageVariant;
  readonly label: string;
}

export interface ToolImagePut {
  readonly variants: { readonly high: ToolImageVariantInput; readonly low?: ToolImageVariantInput };
  readonly mimeType: "image/png" | "image/jpeg";
  readonly label: string;
}

export type ToolImageResolve =
  | { readonly kind: "found"; readonly entry: ToolImageEntry }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous"; readonly labels: readonly string[] };

/**
 * The session store as a tool sees it: write a picture's variants, find an
 * entry by id prefix, check its bytes are still held, and read them (an
 * `image_view` region decodes the picture). Absent in a pod, a sub-agent and a
 * build without vision (the tool is then not registered).
 */
export interface ToolImageStore {
  /** Never throws: a full store or a failed disk write is `{refused}` (a marker note). */
  putTool(input: ToolImagePut): Promise<ToolImageEntry | { readonly refused: string }>;
  resolve(prefix: string): ToolImageResolve;
  holds(ref: AttachmentRef): boolean;
  /** The ref's complete bytes; `null` (never a throw) when this store does not hold them. */
  read(ref: AttachmentRef): Promise<Uint8Array | null>;
}

/**
 * A model-supplied ref, normalised: `sha256:` stripped, lowercased, 8–64 hex
 * characters. Anything else is refused with the expected form.
 */
export function imageRefPrefix(
  raw: string,
): { readonly prefix: string } | { readonly refused: string } {
  const bare = raw
    .trim()
    .toLowerCase()
    .replace(/^sha256:/, "");
  if (!/^[0-9a-f]{8,64}$/.test(bare)) {
    return {
      refused: `"${raw.slice(0, 80)}" is not an image ref: pass the 12 hex characters after \`ref\` in an [image …] marker`,
    };
  }
  return { prefix: bare };
}

/** The label an extracted picture is stored under: `<file> p.<N>`. */
export function toolImageLabel(file: string, page: number): string {
  return sanitizeAttachmentName(`${file} p.${page}`) ?? `p.${page}`;
}
