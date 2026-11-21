/**
 * A PNG encoder with no native code (docs/feat/pdf-images.md D4): 8-bit gray,
 * RGB or RGBA, filter "None" on every row, one IDAT.
 *
 * Pure: `@tentacle/core` is imported by the phone app too, so it imports no
 * `node:` module — the caller hands in `deflate` (the PDF worker passes
 * `node:zlib`'s `deflateSync`). A PNG's IDAT is a zlib stream, which is exactly
 * what `deflateSync` produces.
 */

/** The colour types this encoder writes (PNG colour type 0, 2, 6). */
export type PngColor = "gray" | "rgb" | "rgba";

/** zlib-wrapped deflate of `bytes` (e.g. `node:zlib` `deflateSync`). */
export type Deflate = (bytes: Uint8Array) => Uint8Array;

const COLOR_TYPE: Record<PngColor, number> = { gray: 0, rgb: 2, rgba: 6 };

/** Bytes per pixel of each colour type at 8 bits per channel. */
export const PNG_CHANNELS: Record<PngColor, number> = { gray: 1, rgb: 3, rgba: 4 };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | undefined;

function table(): Uint32Array {
  if (crcTable !== undefined) {
    return crcTable;
  }
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  crcTable = t;
  return t;
}

/** CRC-32 (ISO 3309), as PNG chunks carry it. */
export function crc32(bytes: Uint8Array): number {
  const t = table();
  let c = 0xffffffff;
  for (const byte of bytes) {
    c = (t[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i += 1) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * Encode `pixels` (row-major, `width × height × channels` bytes) as a PNG.
 * Throws on a size mismatch: a wrong-sized buffer is a caller bug, and a PNG
 * built from it would show garbage rather than fail.
 */
export function encodePng(
  width: number,
  height: number,
  pixels: Uint8Array,
  color: PngColor,
  deflate: Deflate,
): Uint8Array {
  const channels = PNG_CHANNELS[color];
  const stride = width * channels;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    pixels.length !== stride * height
  ) {
    throw new Error(`encodePng: ${width}×${height} ${color} needs ${stride * height} bytes`);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = COLOR_TYPE[color];
  // compression 0, filter method 0, interlace 0: the zero bytes already there
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    // filter byte 0 (None), then the row
    raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const parts = [
    new Uint8Array(SIGNATURE),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflate(raw)),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
