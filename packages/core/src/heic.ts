/**
 * HEIC/HEIF → JPEG, the pure half (docs/feat/image-heic.md D1): the ONE truth
 * both entry points (`fs_read`, a TUI attach) share about what is asked of the
 * decoder and what is believed of its answer.
 *
 * Pure: no I/O. The decoder is macOS's own, in a child process
 * (`@tentacle/tools` `heic-convert.ts`), injected here as `HeicOps`.
 */
import { ATTACHMENT_NAME_MAX_CHARS } from "./attachments.ts";
import { type ImageFileInfo, imageOverCapReason, inspectImageFile } from "./image-file.ts";
import { readJpegHeader } from "./jpeg-decode.ts";

/**
 * The longest side an `fs_read` conversion keeps: the 12 MP class, which fits
 * the JPEG decode budget, so `image_view`'s `low`/`region` work on it.
 */
export const HEIC_FILE_MAX_EDGE = 4032;
/**
 * The longest side an attach keeps: the phone's `PHOTO_MAX_EDGE`
 * (`apps/mobile/src/photo-input.ts`), restated — mobile is not importable here.
 */
export const HEIC_ATTACH_MAX_EDGE = 2048;
/** The phone's quality 0.8, in the decoder's 0–100. */
export const HEIC_JPEG_QUALITY = 80;
/** A declared size over this is refused before any decode (48 MP ProRAW passes). */
export const HEIC_MAX_PIXELS = 64_000_000;
/** How many times an output over the byte cap is asked again, ×0.75 each. */
export const HEIC_MAX_STEPS = 3;
/** One child process's whole life. */
export const HEIC_CONVERT_TIMEOUT_MS = 20_000;

/** A converted picture: `width`/`height` are the JPEG's STORED size. */
export interface HeicConverted {
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
}

/** One sentence, with no file name: the caller prefixes the file it knows. */
export interface HeicRefusal {
  readonly refused: string;
}

/** Convert one HEIC's bytes. Never throws: every failure is a refusal. */
export type HeicConverter = (
  bytes: Uint8Array,
  limits: HeicLimits,
) => Promise<HeicConverted | HeicRefusal>;

export interface HeicLimits {
  /** The longest side wanted; a smaller source is never upscaled. */
  readonly maxEdge: number;
  /** The most bytes the JPEG may weigh. */
  readonly maxBytes: number;
}

export interface HeicSize {
  readonly w: number;
  readonly h: number;
}

/** The decoder's two effects, bound to one input. */
export interface HeicOps {
  /** The declared size; `undefined` when there is none to read. */
  size(): Promise<HeicSize | HeicRefusal | undefined>;
  /** Decode to JPEG, shrinking the longest side to `edge` when one is given. */
  toJpeg(edge: number | undefined): Promise<Uint8Array | HeicRefusal>;
}

const BROKEN_OUTPUT = "the HEIC is corrupt or truncated (its decoded JPEG is not whole)";

/**
 * The side to ask for. `downscale` false means "ask for no side": `sips -Z`
 * UPSCALES a smaller picture, so it is passed only to shrink.
 */
export function heicTarget(
  size: HeicSize | undefined,
  maxEdge: number,
): { readonly edge: number; readonly downscale: boolean } | HeicRefusal {
  // `!(x >= 1)` refuses NaN too.
  if (size === undefined || !(size.w >= 1) || !(size.h >= 1)) {
    return { refused: "the HEIC is corrupt (no readable size)" };
  }
  if (size.w * size.h > HEIC_MAX_PIXELS) {
    return {
      refused: `the HEIC is ${size.w}×${size.h}, over the ${HEIC_MAX_PIXELS / 1_000_000} MP limit`,
    };
  }
  const long = Math.max(size.w, size.h);
  const edge = Math.min(maxEdge, long);
  return { edge, downscale: edge < long };
}

/**
 * Is the decoder's output the whole picture asked for? Its exit code says
 * nothing: a truncated input exits 0 with a broken JPEG. So the output passes
 * the file checks AND the strict header walk, and its longest side is the one
 * planned (a lying declared size, or an upscale, fails here).
 */
export function checkHeicOutput(jpeg: Uint8Array, edge: number): ImageFileInfo | HeicRefusal {
  const info = inspectImageFile(jpeg, { maxEdge: edge });
  if (
    !info.ok ||
    info.mimeType !== "image/jpeg" ||
    "refused" in readJpegHeader(jpeg) ||
    Math.max(info.width, info.height) !== edge
  ) {
    return { refused: BROKEN_OUTPUT };
  }
  return info;
}

/** The whole conversion's branching, over the injected effects. */
export async function convertHeicWith(
  limits: HeicLimits,
  ops: HeicOps,
): Promise<HeicConverted | HeicRefusal> {
  const size = await ops.size();
  if (size !== undefined && "refused" in size) {
    return size;
  }
  const target = heicTarget(size, limits.maxEdge);
  if ("refused" in target) {
    return target;
  }
  // `heicTarget` refused an absent size, so there is one here.
  const source = size as HeicSize;
  let { edge, downscale } = target;
  for (let step = 0; ; step += 1) {
    const jpeg = await ops.toJpeg(downscale ? edge : undefined);
    if (!(jpeg instanceof Uint8Array)) {
      return jpeg;
    }
    const info = checkHeicOutput(jpeg, edge);
    if ("refused" in info) {
      return info;
    }
    if (jpeg.length <= limits.maxBytes) {
      return {
        bytes: jpeg,
        width: info.width,
        height: info.height,
        sourceWidth: source.w,
        sourceHeight: source.h,
      };
    }
    if (step >= HEIC_MAX_STEPS) {
      return { refused: imageOverCapReason(jpeg.length, limits.maxBytes) };
    }
    edge = Math.max(1, Math.floor(edge * 0.75));
    downscale = true;
  }
}

/**
 * The name a converted picture wears (the phone's `nameForType` rule): the
 * extension agrees with the bytes; a name with no extension is left alone.
 */
export function heicJpegName(name: string): string {
  const at = name.lastIndexOf(".");
  if (at <= 0 || /^\.jpe?g$/i.test(name.slice(at))) {
    return name;
  }
  // `.jpg` can be WIDER than what it replaces; the wire's name bound holds.
  let stem = name.slice(0, at);
  while (stem.length + ".jpg".length > ATTACHMENT_NAME_MAX_CHARS) {
    stem = [...stem].slice(0, -1).join("");
  }
  return `${stem}.jpg`;
}

/** A marker's format: the source size is named only when the picture shrank. */
export function heicFormatLabel(
  c: Pick<HeicConverted, "width" | "height" | "sourceWidth" | "sourceHeight">,
): string {
  const shrank = Math.max(c.width, c.height) < Math.max(c.sourceWidth, c.sourceHeight);
  return shrank ? `HEIC ${c.sourceWidth}×${c.sourceHeight}→JPEG` : "HEIC→JPEG";
}
