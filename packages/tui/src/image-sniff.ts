/**
 * What an image IS, from its first bytes (docs/feat/attachments-tui-detect.md).
 *
 * A terminal hands a dragged file to us as a PATH and nothing else: no MIME
 * type, and an extension that may lie (a HEIC export named `.png`, a renamed
 * download). So the type every later step trusts comes from the magic numbers
 * here, and the extension is never consulted.
 *
 * Pure: no I/O, no React — the caller reads the bytes (attach-files.ts).
 */
import type { ImageMimeType } from "@tentacle/core";

/**
 * How many leading bytes a sniff needs: WebP's type sits at offset 8 and an
 * `ftyp` brand at 8..12, which is the furthest any signature reaches.
 */
export const IMAGE_HEAD_BYTES = 12;

/** HEIC/HEIF `ftyp` brands: the ISO-BMFF still-image brand set. */
export const HEIF_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
  "mif1",
  "msf1",
] as const;

/**
 * `image` — a type every provider accepts; `heic` — recognised and REFUSED
 * (sub-task 6 converts it), never reported as "not an image"; `not-image` —
 * anything else, including too few bytes to hold a signature (never a guess).
 */
export type SniffResult =
  | { readonly kind: "image"; readonly mimeType: ImageMimeType }
  | { readonly kind: "heic"; readonly brand: string }
  | { readonly kind: "not-image" };

const NOT_IMAGE: SniffResult = { kind: "not-image" };

/** The bytes of `bytes[i..i+n)` as lowercase ASCII, or null when too short. */
function ascii(bytes: Uint8Array, start: number, length: number): string | null {
  if (bytes.length < start + length) {
    return null;
  }
  let text = "";
  for (let i = start; i < start + length; i += 1) {
    const byte = bytes[i];
    if (byte === undefined) {
      return null;
    }
    text += String.fromCharCode(byte);
  }
  return text;
}

function isPng(bytes: Uint8Array): boolean {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  // The 8-byte PNG signature is the whole test: no partially-matching file is
  // a PNG, so "fewer bytes than the signature needs" is simply not an image.
  return bytes.length >= magic.length && magic.every((byte, i) => bytes[i] === byte);
}

function isJpeg(bytes: Uint8Array): boolean {
  // SOI + the first marker's `FF`: a 2-byte `FF D8` alone would also match a
  // truncated JPEG body, so require the third `FF`.
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isGif(bytes: Uint8Array): boolean {
  return ascii(bytes, 0, 4) === "GIF8";
}

function isWebp(bytes: Uint8Array): boolean {
  // `RIFF` + a 4-byte size + `WEBP`. `RIFF….WAVE` is audio, not an image.
  return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
}

/** The `ftyp` brand of an ISO-BMFF file, or null when it is not one. */
function isoBrand(bytes: Uint8Array): string | null {
  if (ascii(bytes, 4, 4) !== "ftyp") {
    return null;
  }
  return ascii(bytes, 8, 4);
}

/** Sniff `bytes` — the whole answer, and the type is the bytes'. */
export function sniffImageType(bytes: Uint8Array): SniffResult {
  if (isPng(bytes)) {
    return { kind: "image", mimeType: "image/png" };
  }
  if (isJpeg(bytes)) {
    return { kind: "image", mimeType: "image/jpeg" };
  }
  if (isGif(bytes)) {
    return { kind: "image", mimeType: "image/gif" };
  }
  if (isWebp(bytes)) {
    return { kind: "image", mimeType: "image/webp" };
  }
  const brand = isoBrand(bytes);
  if (brand !== null && (HEIF_BRANDS as readonly string[]).includes(brand)) {
    return { kind: "heic", brand };
  }
  return NOT_IMAGE;
}
