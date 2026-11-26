/**
 * What stands between untrusted JPEG bytes and a JPEG decoder
 * (docs/feat/image-region-jpeg.md D2): a STRICT header walk, the decode cost
 * judged from that header BEFORE the decoder runs, and a check of what the
 * decoder hands back.
 *
 * The budget bounds a decode only if the decoder allocates for the frame the
 * walk read and runs the scans the walk counted, so the walk reads the whole
 * image, up to its EOI, and refuses every layout pdf.js (the injected decoder)
 * would read differently. Real encoders write none of them.
 *
 * Pure: `@tentacle/core` imports no decoder, so it is injected. Never throws on
 * bad bytes.
 */
import { type DecodedPng, MAX_PNG_DECODE_BYTES } from "./png-decode.ts";

export type JpegRefusal = { readonly refused: string };

/** EXIF Orientation (tag 0x0112): how the stored pixels are to be displayed. */
export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface JpegHeader {
  /** The STORED size: what the frame header says, before any orientation. */
  readonly width: number;
  readonly height: number;
  readonly components: 1 | 3;
  readonly progressive: boolean;
  /** Each component's sampling factors, in the frame header's order. */
  readonly sampling: readonly { readonly h: number; readonly v: number }[];
  readonly orientation: ExifOrientation;
}

/** A synchronous JPEG decoder (injected). May throw. */
export type JpegDecoder = (bytes: Uint8Array) => {
  readonly width: number;
  readonly height: number;
  readonly components: number;
  readonly pixels: Uint8Array;
};

/** The same budget as a PNG: one decode slot serves both. */
export const MAX_JPEG_DECODE_BYTES = MAX_PNG_DECODE_BYTES;

/**
 * pdf.js walks the frame's blocks once per scan, so the scans bound the CPU.
 * libjpeg writes at most 18, mozjpeg about 20; at the memory budget a costly
 * scan takes about 80 ms.
 */
export const MAX_JPEG_SCANS = 32;

/** The last of a block's 64 coefficients: pdf.js loops on to any `Se` given. */
const LAST_COEFFICIENT = 63;

/** The longest piece of a decoder's own message that reaches a result. */
const MAX_MESSAGE_CHARS = 120;

const SOI = 0xd8;
const EOI = 0xd9;
const SOS = 0xda;
const DQT = 0xdb;
const DNL = 0xdc;
const DRI = 0xdd;
const DHT = 0xc4;
const APP1 = 0xe1;
const COM = 0xfe;
const ORIENTATION_TAG = 0x0112;
const EXIF_SHORT = 3;

/** `C0`–`CF` without `DHT`, `JPG` and `DAC`, which are not frame headers. */
export const isSof = (marker: number, high: number, low: number): boolean =>
  marker >= high && marker <= low && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const isApp = (marker: number): boolean => (marker >= 0xe0 && marker <= 0xef) || marker === COM;

/** The markers that may follow a scan: the end, or more of the file. */
const endsScan = (marker: number): boolean =>
  marker === EOI ||
  marker === DHT ||
  marker === SOS ||
  marker === DQT ||
  marker === DRI ||
  isApp(marker);

/**
 * The frame types and shapes a provider's decoder reliably accepts: SOF0–2, 8
 * bits, 1 or 3 components. One sentence otherwise (`fs_read` shares it).
 */
export function jpegFrameRefusal(frame: {
  readonly marker: number;
  readonly precision: number;
  readonly components: number;
}): string | null {
  const { marker, precision, components } = frame;
  if (components === 4) {
    return "a CMYK JPEG — convert it to RGB first";
  }
  if (components !== 1 && components !== 3) {
    return `a JPEG with ${components} colour components — 1 or 3`;
  }
  if (precision !== 8) {
    return `a ${precision}-bit JPEG — only 8-bit is supported`;
  }
  if (isSof(marker, 0xc9, 0xcf)) {
    return "an arithmetic-coded JPEG — only Huffman coding is supported";
  }
  if (marker === 0xc3 || marker === 0xc5 || marker === 0xc6 || marker === 0xc7) {
    return "a lossless or hierarchical JPEG — only baseline or progressive is supported";
  }
  if (!isSof(marker, 0xc0, 0xc2)) {
    return `an unsupported JPEG frame type (SOF${marker - 0xc0})`;
  }
  return null;
}

const corrupt = (what: string): JpegRefusal => ({ refused: `the JPEG is corrupt (${what})` });

const layout = (what: string): JpegRefusal => ({
  refused: `the JPEG has an unexpected layout (${what})`,
});

const unexpected = (marker: number): JpegRefusal => ({
  refused: `the JPEG has an unexpected marker FF${marker.toString(16).toUpperCase().padStart(2, "0")}`,
});

const u8 = (b: Uint8Array, i: number): number => b[i] ?? 0;
const u16 = (b: Uint8Array, i: number): number => (u8(b, i) << 8) | u8(b, i + 1);

/**
 * IFD0's Orientation in an `APP1` payload starting `Exif\0\0`. EXIF is
 * ancillary: anything malformed is orientation 1.
 */
function exifOrientation(payload: Uint8Array): ExifOrientation {
  const tiff = payload.subarray(6);
  try {
    // A DataView over the segment alone: any read past it throws.
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const order = view.getUint16(0);
    if (order !== 0x4949 && order !== 0x4d4d) {
      return 1;
    }
    const little = order === 0x4949;
    if (view.getUint16(2, little) !== 42) {
      return 1;
    }
    const ifd = view.getUint32(4, little);
    const entries = view.getUint16(ifd, little);
    for (let n = 0; n < entries; n += 1) {
      const at = ifd + 2 + n * 12;
      if (view.getUint16(at, little) !== ORIENTATION_TAG) {
        continue;
      }
      if (view.getUint16(at + 2, little) !== EXIF_SHORT || view.getUint32(at + 4, little) !== 1) {
        return 1;
      }
      const value = view.getUint16(at + 8, little);
      return value >= 1 && value <= 8 ? (value as ExifOrientation) : 1;
    }
    return 1;
  } catch {
    return 1;
  }
}

const isExif = (payload: Uint8Array): boolean =>
  [0x45, 0x78, 0x69, 0x66, 0, 0].every((byte, i) => payload[i] === byte);

type Frame = Omit<JpegHeader, "orientation"> & { readonly ids: readonly number[] };

/** The frame header's payload (the bytes after its length field). */
function readFrame(marker: number, payload: Uint8Array): Frame | JpegRefusal {
  const count = u8(payload, 5);
  if (payload.length < 6 || payload.length !== 6 + 3 * count) {
    return layout("a frame header whose length does not match");
  }
  const refused = jpegFrameRefusal({ marker, precision: u8(payload, 0), components: count });
  if (refused !== null) {
    return { refused };
  }
  const height = u16(payload, 1);
  const width = u16(payload, 3);
  const ids: number[] = [];
  const sampling: { h: number; v: number }[] = [];
  for (let at = 6; at < payload.length; at += 3) {
    const h = u8(payload, at + 1) >> 4;
    const v = u8(payload, at + 1) & 15;
    if (h < 1 || h > 4 || v < 1 || v > 4) {
      return corrupt("a sampling factor outside 1…4");
    }
    ids.push(u8(payload, at));
    sampling.push({ h, v });
  }
  if (width < 1 || height < 1) {
    return corrupt("an invalid pixel size");
  }
  return {
    width,
    height,
    components: count === 1 ? 1 : 3,
    progressive: marker === 0xc2,
    sampling,
    ids,
  };
}

/** `DQT`: tables of 65 or 129 bytes that fill the segment exactly. */
function checkQuantization(payload: Uint8Array): JpegRefusal | null {
  let at = 0;
  while (at < payload.length) {
    const precision = u8(payload, at) >> 4;
    if (precision > 1) {
      return layout("a quantization table with an unknown precision");
    }
    at += 1 + 64 * (precision + 1);
  }
  return at === payload.length
    ? null
    : layout("a quantization table that does not fill its segment");
}

/** `DHT`: tables of 17 + Σ counts bytes that fill the segment exactly. */
function checkHuffman(payload: Uint8Array): JpegRefusal | null {
  let at = 0;
  while (at + 17 <= payload.length) {
    let codes = 0;
    for (let i = 1; i <= 16; i += 1) {
      codes += u8(payload, at + i);
    }
    at += 17 + codes;
  }
  return at === payload.length ? null : layout("a Huffman table that does not fill its segment");
}

/**
 * `SOS`: 4 + 2·Ns payload bytes, every selector naming a frame component once,
 * the spectral selection inside the block.
 */
function checkScan(payload: Uint8Array, ids: readonly number[]): JpegRefusal | null {
  const count = u8(payload, 0);
  if (payload.length !== 4 + 2 * count) {
    return layout("a scan header whose length does not match");
  }
  const named = new Set<number>();
  for (let n = 0; n < count; n += 1) {
    const id = u8(payload, 1 + 2 * n);
    if (!ids.includes(id)) {
      return layout("a scan that names a component the frame does not have");
    }
    if (named.has(id)) {
      return layout("a scan that names a component twice");
    }
    named.add(id);
  }
  return u8(payload, 2 + 2 * count) > LAST_COEFFICIENT
    ? layout("a scan that ends past coefficient 63")
    : null;
}

const truncated = (): JpegRefusal => corrupt("it is truncated: no end-of-image marker");

/**
 * A scan's entropy data: the offset of the marker that ends it. Only stuffed
 * bytes, restart markers and fill bytes are skipped. A `DNL` makes pdf.js parse
 * again at another height; a marker under `C0` is one pdf.js skips past, so it
 * could reach a `DNL` or a scan this walk never would.
 */
function skipScan(bytes: Uint8Array, start: number): number | JpegRefusal {
  for (let i = start; i + 1 < bytes.length; i += 1) {
    if (bytes[i] !== 0xff) {
      continue;
    }
    const marker = u8(bytes, i + 1);
    if (marker === 0xff) {
      continue; // fill byte
    }
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 1;
      continue;
    }
    if (marker === DNL) {
      return layout("a DNL marker that changes the height");
    }
    return endsScan(marker) ? i : unexpected(marker);
  }
  return truncated();
}

/**
 * The STRICT walk: SOI, then only the segments a real encoder writes, each
 * exactly as long as its content, with at most `MAX_JPEG_SCANS` scans, up to the
 * EOI (what follows it is not part of the image). Never throws.
 */
export function readJpegHeader(bytes: Uint8Array): JpegHeader | JpegRefusal {
  if (bytes[0] !== 0xff || bytes[1] !== SOI) {
    return corrupt("no start-of-image marker");
  }
  let i = 2;
  let frame: Frame | undefined;
  let orientation: ExifOrientation | undefined;
  let afterApp = false;
  let scans = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      return layout("data where a marker was expected");
    }
    const marker = u8(bytes, i + 1);
    if (marker === 0xff) {
      // Without a marker right after it, pdf.js searches an APP or COM
      // payload for one and parses what it finds there.
      if (afterApp) {
        return layout("a fill byte after an application or comment segment");
      }
      i += 1;
      continue;
    }
    if (marker === EOI && frame !== undefined && scans > 0) {
      const { ids: _, ...header } = frame;
      return { ...header, orientation: orientation ?? 1 };
    }
    const sof = isSof(marker, 0xc0, 0xcf);
    if (!(sof || endsScan(marker)) || marker === EOI) {
      return unexpected(marker);
    }
    const length = u16(bytes, i + 2);
    const end = i + 2 + length;
    if (i + 4 > bytes.length || length < 2 || end > bytes.length) {
      return corrupt("a segment runs past the end of the file");
    }
    const payload = bytes.subarray(i + 4, end);
    afterApp = isApp(marker);
    let next = end;
    let refused: JpegRefusal | null = null;
    if (sof) {
      if (frame !== undefined) {
        return layout("a second frame header");
      }
      const read = readFrame(marker, payload);
      if ("refused" in read) {
        return read;
      }
      frame = read;
    } else if (marker === DQT) {
      refused = checkQuantization(payload);
    } else if (marker === DHT) {
      refused = checkHuffman(payload);
    } else if (marker === DRI) {
      refused = length === 4 ? null : layout("a restart interval segment of the wrong length");
    } else if (marker === APP1 && orientation === undefined && isExif(payload)) {
      orientation = exifOrientation(payload);
    } else if (marker === SOS) {
      if (frame === undefined) {
        return corrupt("no frame header before the image data");
      }
      scans += 1;
      if (scans > MAX_JPEG_SCANS) {
        return layout(`more than ${MAX_JPEG_SCANS} scans`);
      }
      const scan = checkScan(payload, frame.ids) ?? skipScan(bytes, end);
      if (typeof scan !== "number") {
        return scan;
      }
      next = scan;
    }
    if (refused !== null) {
      return refused;
    }
    i = next;
  }
  return scans > 0 ? truncated() : corrupt("it ends before its image data");
}

/**
 * What pdf.js allocates for this frame: per component a 16-bit coefficient
 * buffer over whole MCUs (plus one column), then the 8-bit pixels.
 */
export function jpegDecodeCost(header: JpegHeader): number {
  const { width, height, components, sampling } = header;
  const maxH = Math.max(...sampling.map((s) => s.h));
  const maxV = Math.max(...sampling.map((s) => s.v));
  const mcusPerLine = Math.ceil(width / 8 / maxH);
  const mcusPerColumn = Math.ceil(height / 8 / maxV);
  return sampling.reduce(
    (sum, { h, v }) => sum + 2 * 64 * (mcusPerColumn * v) * (mcusPerLine * h + 1),
    width * height * components,
  );
}

const mib = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));

/** Decode `bytes` to 8-bit gray or RGB, in the STORED frame. Never throws. */
export function decodeJpeg(
  bytes: Uint8Array,
  header: JpegHeader,
  decoder: JpegDecoder,
): DecodedPng | JpegRefusal {
  const { width, height, components } = header;
  const cost = jpegDecodeCost(header);
  if (cost > MAX_JPEG_DECODE_BYTES) {
    return {
      refused: `the JPEG is ${width}×${height}: decoding it needs ${mib(cost)} MiB, over the ${mib(MAX_JPEG_DECODE_BYTES)} MiB limit`,
    };
  }
  let decoded: ReturnType<JpegDecoder>;
  try {
    decoded = decoder(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return corrupt(message.slice(0, MAX_MESSAGE_CHARS));
  }
  if (
    decoded.width !== width ||
    decoded.height !== height ||
    decoded.components !== components ||
    decoded.pixels.length !== width * height * components
  ) {
    return corrupt("decoded size differs from its header");
  }
  return { width, height, color: components === 1 ? "gray" : "rgb", pixels: decoded.pixels };
}
