/**
 * `fs_read` on an image FILE (docs/feat/image-files.md D2): a `.png` / `.jpg` /
 * `.jpeg` in the workspace goes into the session's store through image-view's
 * OWN tool-image path, and the text keeps the same kind of marker — with a ref
 * `image_view` shows. `high` only: nothing downscales yet, so `low` IS `high`.
 * A HEIC is converted to JPEG first, where the host can (image-heic.md D4).
 *
 * Pure over `ctx.env` / `ctx.images`: the decision is here, the bytes and the
 * store are the caller's. `undefined` means "not an image file — run the text
 * path unchanged", so a session without vision (or without a store) keeps
 * today's behaviour byte for byte.
 */
import {
  FileTooLargeError,
  HEIC_FILE_MAX_EDGE,
  type HeicConverter,
  MAX_IMAGE_BYTES,
  PDF_HEAD_BYTES,
  type ToolContext,
  type ToolImageEntry,
  type ToolImageStore,
  type ToolResult,
  heicFormatLabel,
  imageFileMarker,
  imageOverCapReason,
  inspectImageFile,
  looksLikeTextBytes,
  sanitizeAttachmentName,
  sniffImageType,
} from "@tentacle/core";

/** The extensions a file read treats as an image intent (the BYTES still decide). */
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg"];

/** What the image branch needs that `ToolContext` does not carry. */
export interface ImageFileOptions {
  /** This model's own per-image cap (raw bytes) — `imageLimits(...).maxBytes`. */
  readonly maxImageBytes: number;
  /** The largest side accepted (Q1: 8000 px on Anthropic, 1568 on OpenAI-compatible). */
  readonly maxEdge: number;
  /** The host's HEIC decoder; absent where it has none (a HEIC is then refused). */
  readonly heic?: HeicConverter | undefined;
}

/** The hint line a successful read appends: the ref is what `image_view` wants. */
const VIEW_HINT =
  "call image_view with this ref to see it; only high detail is available for image files";

const refused = (content: string): ToolResult => ({ content, isError: true });

/** The last path segment — the name a marker and the store's label carry. */
function displayName(path: string): string {
  const segments = path.split("/").filter((part) => part !== "");
  return segments[segments.length - 1] ?? path;
}

/** True when the name says "an image" — a hint that sharpens ONE refusal only. */
function hasImageExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** The type name a refusal uses: `GIF`, `WebP` — the spelling their own docs use. */
function typeName(mimeType: string): string {
  const bare = mimeType.replace("image/", "");
  return bare === "webp" ? "WebP" : bare.toUpperCase();
}

/**
 * The image branch of `fs_read`. Returns `undefined` when the file is not an
 * image (the caller keeps today's text path), and the result otherwise —
 * including every refusal, which is a sentence naming the file or the image.
 */
export async function readImageFile(
  path: string,
  range: { readonly offset?: number | undefined; readonly limit?: number | undefined },
  ctx: Pick<ToolContext, "env" | "images">,
  options: ImageFileOptions,
): Promise<ToolResult | undefined> {
  const store = ctx.images;
  const readBytes = ctx.env.readBytes?.bind(ctx.env);
  // Without a store there is nowhere to put the image, and without a byte read
  // there is nothing to put: both keep today's behaviour, byte for byte.
  if (store === undefined || readBytes === undefined) {
    return undefined;
  }
  // One bounded head: magic bytes sit in the first handful, so a non-image read
  // in a vision session costs one small read — and only after the PDF branch
  // already decided the file is not a PDF (D2).
  const head = await readBytes(path, { readLimitBytes: PDF_HEAD_BYTES });
  const sniffed = sniffImageType(head);
  const name = displayName(path);
  if (sniffed.kind === "heic") {
    return readHeicFile(path, range, readBytes, store, options);
  }
  const imageType = sniffed.kind === "image" ? sniffed.mimeType : undefined;
  if (imageType !== undefined && imageType !== "image/png" && imageType !== "image/jpeg") {
    // GIF/WebP reach a provider, but reading one needs a decoder this task does
    // not add (owner Q2): a sentence naming the type beats today's mojibake.
    return refused(`${name}: ${typeName(imageType)} images are not readable as images yet`);
  }
  if (imageType === undefined) {
    // A file NAMED an image that is not one, and is not text either: today's
    // path would return mojibake, so name the real problem instead. A `.png`
    // holding text stays text (the same rule `notes.pdf` follows).
    if (hasImageExtension(name) && !looksLikeTextBytes(head)) {
      return refused(`${name} is not a PNG or JPEG image (no image signature)`);
    }
    return undefined;
  }
  if (range.offset !== undefined || range.limit !== undefined) {
    return refused(`${path} is an image: no line ranges`);
  }
  const max = Math.min(options.maxImageBytes, MAX_IMAGE_BYTES);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(path, { maxBytes: max });
  } catch (error) {
    // Refused BEFORE the body was read (F1): the model gets the shared sentence.
    if (error instanceof FileTooLargeError) {
      return refused(`[image omitted: ${imageOverCapReason(error.sizeBytes, max)} — ${name}]`);
    }
    throw error;
  }
  const inspected = inspectImageFile(bytes, { maxEdge: options.maxEdge });
  if (!inspected.ok) {
    return refused(`${name}: ${inspected.reason}`);
  }
  const { width, height, format, mimeType } = inspected;
  const put = await keepImageFile(store, bytes, { width, height, mimeType }, name);
  if ("refused" in put) {
    return refused(`[image ${name} · ${width}×${height} · not kept: ${put.refused}]`);
  }
  const marker = imageFileMarker(name, width, height, format, bytes.length, put.high.ref.id);
  // 0 refs, like a PDF read: the ref is text in the marker, so no message this
  // read writes can exceed one.
  return { content: `${marker}\n${VIEW_HINT}` };
}

/**
 * A HEIC (docs/feat/image-heic.md D4): converted ONCE to a JPEG, which then is
 * the picture — stored, marked and viewed like any JPEG file. The input is
 * bounded by the wire's cap; the model's cap applies to the JPEG.
 */
async function readHeicFile(
  path: string,
  range: { readonly offset?: number | undefined; readonly limit?: number | undefined },
  readBytes: NonNullable<ToolContext["env"]["readBytes"]>,
  store: ToolImageStore,
  options: ImageFileOptions,
): Promise<ToolResult> {
  const name = displayName(path);
  if (range.offset !== undefined || range.limit !== undefined) {
    return refused(`${path} is an image: no line ranges`);
  }
  if (options.heic === undefined) {
    return refused(
      `${name}: HEIC/HEIF pictures are converted by macOS's own decoder, and this host (${process.platform}) has none — convert it to JPEG first`,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(path, { maxBytes: MAX_IMAGE_BYTES });
  } catch (error) {
    if (error instanceof FileTooLargeError) {
      return refused(
        `[image omitted: ${imageOverCapReason(error.sizeBytes, MAX_IMAGE_BYTES)} — ${name}]`,
      );
    }
    throw error;
  }
  const converted = await options.heic(bytes, {
    maxEdge: Math.min(options.maxEdge, HEIC_FILE_MAX_EDGE),
    maxBytes: Math.min(options.maxImageBytes, MAX_IMAGE_BYTES),
  });
  if ("refused" in converted) {
    return refused(`${name}: ${converted.refused}`);
  }
  const { width, height } = converted;
  const jpeg = converted.bytes;
  const size = { width, height, mimeType: "image/jpeg" } as const;
  const put = await keepImageFile(store, jpeg, size, name);
  if ("refused" in put) {
    return refused(`[image ${name} · ${width}×${height} · not kept: ${put.refused}]`);
  }
  const format = heicFormatLabel(converted);
  const marker = imageFileMarker(name, width, height, format, jpeg.length, put.high.ref.id);
  return { content: `${marker}\n${VIEW_HINT}` };
}

/** Write the file's ONE variant to the store; a refusal is a marker note, never a throw. */
function keepImageFile(
  store: ToolImageStore,
  bytes: Uint8Array,
  size: {
    readonly width: number;
    readonly height: number;
    readonly mimeType: "image/png" | "image/jpeg";
  },
  name: string,
): Promise<ToolImageEntry | { readonly refused: string }> {
  return store.putTool({
    variants: { high: { bytes, width: size.width, height: size.height } },
    mimeType: size.mimeType,
    label: sanitizeAttachmentName(name) ?? "image",
  });
}
