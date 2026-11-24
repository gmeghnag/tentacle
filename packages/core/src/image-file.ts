/**
 * An image FILE read by `fs_read` (docs/feat/image-files.md D1): PNG and JPEG
 * only, `high` only (the original bytes — nothing downscales yet), stored
 * through image-view's tool-image path.
 *
 * Pure: no I/O. The type comes from the BYTES (`sniffImageType`), never from
 * the extension, and every check here is one a provider's decoder would make
 * later — a 400 on an image stays in the history until the tool budget ages it
 * out, so a variant no decoder accepts is refused up front, with one sentence.
 */
import { MAX_IMAGE_BYTES, formatBytes } from "./attachments.ts";
import { sniffImageType } from "./image-sniff.ts";
import { crc32 } from "./png.ts";
import { TOOL_IMAGE_REF_CHARS } from "./tool-images.ts";

/** The two formats a file read accepts today (Q2: GIF/WebP/HEIC are refused). */
export type ImageFileFormat = "PNG" | "JPEG";

export type ImageFileMimeType = "image/png" | "image/jpeg";

export interface ImageFileInfo {
  readonly ok: true;
  readonly mimeType: ImageFileMimeType;
  readonly format: ImageFileFormat;
  readonly width: number;
  readonly height: number;
}

export interface ImageFileRefusal {
  readonly ok: false;
  readonly reason: string;
}

/** The largest side an image file may have (Q1: decided in wiring, next to the byte cap). */
export interface ImageFileLimits {
  readonly maxEdge: number;
}

/**
 * The fallback side limit when a caller names none: the STRICTER of Q1 (C)'s two
 * — an OpenAI-compatible endpoint takes the original bytes, so a surprise there
 * costs real tokens. Wiring always passes the provider's own value.
 */
export const DEFAULT_IMAGE_FILE_MAX_EDGE = 1568;

/** The PNG signature, byte for byte. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** PNG colour types and the bit depths the spec allows each (table 11.1). */
const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // indexed
  4: [8, 16], // greyscale + alpha
  6: [8, 16], // truecolour + alpha
};

/** How far from the end an `IEND` chunk may sit (it is 12 bytes; slack for trailing junk). */
const PNG_TAIL_BYTES = 1024;

function u16be(b: Uint8Array, i: number): number | undefined {
  const hi = b[i];
  const lo = b[i + 1];
  return hi === undefined || lo === undefined ? undefined : (hi << 8) | lo;
}

function u32be(b: Uint8Array, i: number): number | undefined {
  const hi = u16be(b, i);
  const lo = u16be(b, i + 2);
  return hi === undefined || lo === undefined ? undefined : hi * 0x10000 + lo;
}

function ascii(b: Uint8Array, start: number, length: number): string | undefined {
  if (b.length < start + length) {
    return undefined;
  }
  let text = "";
  for (let i = start; i < start + length; i += 1) {
    text += String.fromCharCode(b[i] as number);
  }
  return text;
}

const corrupt = (what: string): ImageFileRefusal => ({
  ok: false,
  reason: `the ${what} is truncated or corrupt`,
});

/** Does an `IEND` chunk type sit in the file's last 1 KiB? A PNG without one is truncated. */
function hasIend(bytes: Uint8Array): boolean {
  const from = Math.max(0, bytes.length - PNG_TAIL_BYTES);
  for (let i = from; i + 4 <= bytes.length; i += 1) {
    if (
      bytes[i] === 0x49 &&
      bytes[i + 1] === 0x45 &&
      bytes[i + 2] === 0x4e &&
      bytes[i + 3] === 0x44
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The PNG's own header rules: signature, an `IHDR` chunk of exactly 13 bytes
 * whose CRC matches, legal dimensions, a legal depth/colour pair, an interlace
 * byte of 0 or 1, and an `IEND` chunk at the end.
 */
function inspectPng(bytes: Uint8Array): ImageFileInfo | ImageFileRefusal {
  if (!PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return corrupt("PNG");
  }
  const length = u32be(bytes, 8);
  if (length !== 13 || ascii(bytes, 12, 4) !== "IHDR") {
    return { ok: false, reason: "the PNG has no IHDR header chunk" };
  }
  // The CRC covers the chunk's type and data, and is stored after them.
  const covered = bytes.subarray(12, 12 + 4 + length);
  const stored = u32be(bytes, 12 + 4 + length);
  if (stored === undefined || stored !== crc32(covered)) {
    return { ok: false, reason: "the PNG's IHDR checksum does not match — the file is corrupt" };
  }
  const width = u32be(bytes, 16);
  const height = u32be(bytes, 20);
  if (width === undefined || height === undefined || width < 1 || height < 1) {
    return { ok: false, reason: "the PNG reports an invalid pixel size" };
  }
  if (width > 65535 || height > 65535) {
    return { ok: false, reason: `the PNG is ${width}×${height}, over the 65535 px wire limit` };
  }
  const depth = bytes[24] ?? 0;
  const colorType = bytes[25] ?? 0;
  if (PNG_DEPTHS[colorType]?.includes(depth) !== true) {
    return {
      ok: false,
      reason: `the PNG's bit depth ${depth} with colour type ${colorType} is not a legal pair`,
    };
  }
  const interlace = bytes[28] ?? 0;
  if (interlace !== 0 && interlace !== 1) {
    return { ok: false, reason: "the PNG's interlace method is not 0 or 1" };
  }
  if (!hasIend(bytes)) {
    return corrupt("PNG");
  }
  return { ok: true, mimeType: "image/png", format: "PNG", width, height };
}

/** What a JPEG's frame header said, once one was found. */
interface JpegFrame {
  readonly marker: number;
  readonly precision: number;
  readonly width: number;
  readonly height: number;
  readonly components: number;
  /** Offset just past the SOS segment's marker, i.e. where entropy data starts. */
  readonly scanAt: number;
}

const isSof = (marker: number, high: number, low: number): boolean =>
  marker >= high && marker <= low && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

/**
 * Walk the marker segments to the first frame header, then to `SOS`. `JPG`,
 * `DHT` and `DAC` share the `C0`–`CF` range but are not frame headers.
 */
function readJpegFrame(b: Uint8Array): JpegFrame | ImageFileRefusal {
  let i = 2;
  let frame: JpegFrame | undefined;
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) {
      return corrupt("JPEG");
    }
    const marker = b[i + 1] ?? 0;
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers: no length
      continue;
    }
    const length = u16be(b, i + 2);
    if (length === undefined || length < 2) {
      return corrupt("JPEG");
    }
    if (marker === 0xda) {
      if (frame === undefined) {
        return { ok: false, reason: "the JPEG has no frame header (SOF), so its size is unknown" };
      }
      return { ...frame, scanAt: i + 2 };
    }
    if (frame === undefined && isSof(marker, 0xc0, 0xcf)) {
      const precision = b[i + 4];
      const height = u16be(b, i + 5);
      const width = u16be(b, i + 7);
      const components = b[i + 9];
      if (precision === undefined || width === undefined || height === undefined) {
        return corrupt("JPEG");
      }
      frame = { marker, precision, width, height, components: components ?? 0, scanAt: 0 };
    }
    i += 2 + length;
  }
  return frame === undefined
    ? { ok: false, reason: "the JPEG has no frame header (SOF), so its size is unknown" }
    : corrupt("JPEG");
}

/**
 * The JPEG's own header rules: an accepted frame type at 8 bits with 1 or 3
 * components, then a scan, then an end-of-image marker. The variants refused
 * here are the ones provider decoders do not reliably accept.
 */
function inspectJpeg(bytes: Uint8Array): ImageFileInfo | ImageFileRefusal {
  const frame = readJpegFrame(bytes);
  if ("ok" in frame) {
    return frame;
  }
  const { marker, precision, components, width, height, scanAt } = frame;
  if (components === 4) {
    return { ok: false, reason: "a CMYK JPEG — convert it to RGB first" };
  }
  if (components !== 1 && components !== 3) {
    return { ok: false, reason: `a JPEG with ${components} colour components — 1 or 3` };
  }
  if (precision !== 8) {
    return { ok: false, reason: `a ${precision}-bit JPEG — only 8-bit is supported` };
  }
  if (isSof(marker, 0xc9, 0xcf)) {
    return { ok: false, reason: "an arithmetic-coded JPEG — only Huffman coding is supported" };
  }
  if (marker === 0xc3 || marker === 0xc5 || marker === 0xc6 || marker === 0xc7) {
    return {
      ok: false,
      reason: "a lossless or hierarchical JPEG — only baseline or progressive is supported",
    };
  }
  if (!isSof(marker, 0xc0, 0xc2)) {
    return { ok: false, reason: `an unsupported JPEG frame type (SOF${marker - 0xc0})` };
  }
  // `FF D9` cannot appear inside stuffed entropy data (`FF` there is followed
  // by `00`), so a plain search past the scan start is reliable.
  let eoi = false;
  for (let i = scanAt; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
      eoi = true;
      break;
    }
  }
  if (!eoi) {
    return corrupt("JPEG");
  }
  if (width < 1 || height < 1) {
    return { ok: false, reason: "the JPEG reports an invalid pixel size" };
  }
  return { ok: true, mimeType: "image/jpeg", format: "JPEG", width, height };
}

/**
 * Inspect an image file's bytes: its real type, its pixel size — or ONE
 * sentence saying why it cannot be sent. The name is not part of it: the
 * caller prefixes the file it knows.
 */
export function inspectImageFile(
  bytes: Uint8Array,
  limits: ImageFileLimits,
): ImageFileInfo | ImageFileRefusal {
  const sniffed = sniffImageType(bytes);
  if (sniffed.kind !== "image") {
    return { ok: false, reason: "the file is not a PNG or JPEG image (no image signature)" };
  }
  let info: ImageFileInfo | ImageFileRefusal;
  if (sniffed.mimeType === "image/png") {
    info = inspectPng(bytes);
  } else if (sniffed.mimeType === "image/jpeg") {
    info = inspectJpeg(bytes);
  } else {
    return {
      ok: false,
      reason: `a ${sniffed.mimeType.replace("image/", "").toUpperCase()} image is not readable as an image yet`,
    };
  }
  if (!info.ok) {
    return info;
  }
  if (Math.max(info.width, info.height) > limits.maxEdge) {
    return {
      ok: false,
      reason: `${info.width}×${info.height} is over the ${limits.maxEdge} px limit for image files (no downscale yet)`,
    };
  }
  return info;
}

/**
 * The ONE sentence an image over the model's byte cap gets — the provider's
 * placeholder (`providers/src/images.ts`) and `fs_read` share it, so the same
 * limit reads the same way in the history and in a tool result.
 */
export function imageOverCapReason(size: number, max: number): string {
  // The MODEL's cap when it is the binding one, named as such so the fix is
  // obvious; `the` when it is the wire's own bound.
  const which = max < MAX_IMAGE_BYTES ? "this model's" : "the";
  return `${formatBytes(size)} is over ${which} ${formatBytes(max)} limit`;
}

/**
 * An image file's marker, in image-view's grammar plus what a file has and a
 * PDF page has not: the format and `high only` (`low` needs a decoder, 3a/3b).
 * `[image <name> · W×H · <format> · <size> · ref <12 hex> · high only]`
 */
export function imageFileMarker(
  name: string,
  width: number,
  height: number,
  format: ImageFileFormat,
  size: number,
  id: string,
): string {
  return `[image ${name} · ${width}×${height} · ${format} · ${formatBytes(size)} · ref ${id.slice(0, TOOL_IMAGE_REF_CHARS)} · high only]`;
}
