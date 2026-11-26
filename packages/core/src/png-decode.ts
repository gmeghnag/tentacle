/**
 * A PNG decoder with no native code (docs/feat/image-region-png.md D2): every
 * legal depth/colour pair, palette and tRNS, Adam7 — always to 8-bit gray, RGB
 * or RGBA. gAMA/iCCP/sRGB/eXIf and the animation chunks are ignored (an APNG
 * shows its default image).
 *
 * The bytes are UNTRUSTED: every refusal is one sentence, nothing throws, and
 * the size is judged from the header BEFORE any inflate — which is then capped
 * at the exact size that header declares.
 *
 * Pure: `@tentacle/core` imports no `node:` module, so `inflate` is injected.
 */
import { PNG_CHANNELS, type PngColor, crc32 } from "./png.ts";

/**
 * zlib inflate (e.g. `node:zlib` `inflate`). MUST reject, with `code:
 * "ERR_BUFFER_TOO_LARGE"`, rather than produce more than `maxOutputLength`.
 */
export type Inflate = (bytes: Uint8Array, maxOutputLength: number) => Promise<Uint8Array>;

/** The most one decode may allocate: the inflated stream plus the 8-bit output. */
export const MAX_PNG_DECODE_BYTES = 128 * 1024 * 1024;

/** PNG colour types and the bit depths the spec allows each (table 11.1). */
export const PNG_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16], // greyscale
  2: [8, 16], // truecolour
  3: [1, 2, 4, 8], // indexed
  4: [8, 16], // greyscale + alpha
  6: [8, 16], // truecolour + alpha
};

/** Samples per pixel of each colour type, as the file stores them. */
const SAMPLES: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The largest side the format itself allows. */
const MAX_SIDE = 0x7fffffff;

export interface PngHeader {
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly colorType: number;
  readonly interlace: 0 | 1;
  readonly palette?: Uint8Array;
  /** The tRNS chunk's data, when the picture has one. */
  readonly transparency?: Uint8Array;
  readonly idat: readonly Uint8Array[];
  /** The exact size the IDAT stream must inflate to. */
  readonly rawBytes: number;
  /** The colour of the decoded pixels. */
  readonly outColor: PngColor;
}

export interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly color: PngColor;
  readonly pixels: Uint8Array;
}

export type PngRefusal = { readonly refused: string };

const corrupt = (what: string): PngRefusal => ({ refused: `the PNG is corrupt (${what})` });

interface Pass {
  readonly x0: number;
  readonly y0: number;
  readonly dx: number;
  readonly dy: number;
  readonly width: number;
  readonly height: number;
}

/** Adam7's grid: `[x0, y0, dx, dy]` per pass. */
const ADAM7: readonly (readonly [number, number, number, number])[] = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];

/** The sub-images the stream holds, empty ones left out (they have no bytes). */
function passes(width: number, height: number, interlace: 0 | 1): Pass[] {
  if (interlace === 0) {
    return [{ x0: 0, y0: 0, dx: 1, dy: 1, width, height }];
  }
  return ADAM7.map(([x0, y0, dx, dy]) => ({
    x0,
    y0,
    dx,
    dy,
    width: Math.ceil((width - x0) / dx),
    height: Math.ceil((height - y0) / dy),
  })).filter((pass) => pass.width > 0 && pass.height > 0);
}

const rowBytes = (width: number, colorType: number, depth: number): number =>
  Math.ceil((width * (SAMPLES[colorType] as number) * depth) / 8);

function outColorOf(colorType: number, transparency: boolean): PngColor {
  if (colorType === 4 || colorType === 6 || transparency) {
    return "rgba";
  }
  return colorType === 0 ? "gray" : "rgb";
}

/** Walk every chunk: structure and CRCs are checked before anything is inflated. */
export function readPngHeader(bytes: Uint8Array): PngHeader | PngRefusal {
  if (!SIGNATURE.every((byte, i) => bytes[i] === byte)) {
    return corrupt("bad signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let shape: Pick<PngHeader, "width" | "height" | "depth" | "colorType" | "interlace"> | undefined;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  let idatClosed = false;
  let ended = false;
  let at = SIGNATURE.length;
  while (!ended && at < bytes.length) {
    if (at + 12 > bytes.length) {
      return corrupt("truncated inside a chunk");
    }
    const length = view.getUint32(at);
    if (length > bytes.length - at - 12) {
      return corrupt("truncated inside a chunk");
    }
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) {
      return corrupt("a chunk with no valid type");
    }
    const data = bytes.subarray(at + 8, at + 8 + length);
    if (view.getUint32(at + 8 + length) !== crc32(bytes.subarray(at + 4, at + 8 + length))) {
      return corrupt(`bad ${type} checksum`);
    }
    at += 12 + length;
    if (shape === undefined) {
      if (type !== "IHDR" || length !== 13) {
        return corrupt("no IHDR header chunk first");
      }
      const head = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const width = head.getUint32(0);
      const height = head.getUint32(4);
      const [depth, colorType, compression, filter, interlace] = data.subarray(8) as unknown as [
        number,
        number,
        number,
        number,
        number,
      ];
      if (width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
        return corrupt("invalid pixel size");
      }
      if (!PNG_DEPTHS[colorType]?.includes(depth)) {
        return corrupt(`bit depth ${depth} with colour type ${colorType}`);
      }
      if (compression !== 0 || filter !== 0) {
        return corrupt("unknown compression or filter method");
      }
      if (interlace !== 0 && interlace !== 1) {
        return corrupt("unknown interlace method");
      }
      shape = { width, height, depth, colorType, interlace };
      continue;
    }
    if (type !== "IDAT" && idat.length > 0) {
      idatClosed = true;
    }
    if (type === "IHDR") {
      return corrupt("a second IHDR chunk");
    }
    if (type === "PLTE") {
      if (palette !== undefined || idat.length > 0) {
        return corrupt("a misplaced PLTE chunk");
      }
      if (length === 0 || length % 3 !== 0 || length > 768) {
        return corrupt(`a PLTE chunk of ${length} bytes`);
      }
      palette = data;
    } else if (type === "tRNS") {
      // Only before the pixels, and only where the format gives it a meaning.
      if (idat.length === 0 && (shape.colorType === 0 || shape.colorType === 2)) {
        if (length !== (shape.colorType === 0 ? 2 : 6)) {
          return corrupt("a tRNS chunk of the wrong size");
        }
        transparency = data;
      } else if (idat.length === 0 && shape.colorType === 3) {
        if (palette === undefined || length > palette.length / 3) {
          return corrupt("a tRNS chunk that does not fit the PLTE");
        }
        transparency = data;
      }
    } else if (type === "IDAT") {
      if (idatClosed) {
        return corrupt("IDAT chunks are not consecutive");
      }
      if (shape.colorType === 3 && palette === undefined) {
        return corrupt("no PLTE chunk before the pixels");
      }
      idat.push(data);
    } else if (type === "IEND") {
      ended = true;
    } else if (type.charCodeAt(0) < 0x61) {
      // An uppercase first letter = critical: a picture we cannot show right.
      return corrupt(`unknown critical chunk ${type}`);
    }
  }
  if (shape === undefined) {
    return corrupt("no IHDR header chunk");
  }
  if (idat.length === 0) {
    return corrupt("no IDAT chunk");
  }
  if (!ended) {
    return corrupt("no IEND chunk");
  }
  const { width, height, depth, colorType, interlace } = shape;
  const rawBytes = passes(width, height, interlace).reduce(
    (sum, pass) => sum + pass.height * (1 + rowBytes(pass.width, colorType, depth)),
    0,
  );
  return {
    ...shape,
    ...(colorType === 3 && palette !== undefined ? { palette } : {}),
    ...(transparency !== undefined ? { transparency } : {}),
    idat,
    rawBytes,
    outColor: outColorOf(colorType, transparency !== undefined),
  };
}

/** What a decode of this picture allocates. */
export function pngDecodeCost(header: PngHeader): number {
  return header.rawBytes + header.width * header.height * PNG_CHANNELS[header.outColor];
}

function paeth(a: number, b: number, c: number): number {
  const pa = Math.abs(b - c);
  const pb = Math.abs(a - c);
  const pc = Math.abs(a + b - 2 * c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

/**
 * Undo one row's filter in place. `row` and `above` are views into the same
 * stream; `above` is the previous row, already unfiltered (absent on a pass's
 * first row). `false` = an unknown filter byte.
 */
function unfilter(
  filter: number,
  row: Uint8Array,
  above: Uint8Array | undefined,
  step: number,
): boolean {
  if (filter > 4) {
    return false;
  }
  if (filter === 0) {
    return true;
  }
  for (let i = 0; i < row.length; i += 1) {
    const a = i >= step ? (row[i - step] as number) : 0;
    const b = above === undefined ? 0 : (above[i] as number);
    const c = above === undefined || i < step ? 0 : (above[i - step] as number);
    const add = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : paeth(a, b, c);
    // A Uint8Array store wraps modulo 256, which is the filter's arithmetic.
    row[i] = (row[i] as number) + add;
  }
  return true;
}

/** Sample `index` of a row, at the file's depth. */
function sampleAt(row: Uint8Array, index: number, depth: number): number {
  if (depth === 8) {
    return row[index] as number;
  }
  if (depth === 16) {
    return ((row[index * 2] as number) << 8) | (row[index * 2 + 1] as number);
  }
  const bit = index * depth;
  return ((row[bit >> 3] as number) >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
}

/** Expand one unfiltered row of a pass into `out`; a sentence when it cannot. */
function expandRow(
  header: PngHeader,
  row: Uint8Array,
  pass: Pass,
  passRow: number,
  out: Uint8Array,
): string | undefined {
  const { depth, colorType, palette, transparency, width } = header;
  const channels = PNG_CHANNELS[header.outColor];
  const samples = SAMPLES[colorType] as number;
  // A sample as 8 bits: 16 → the high byte; 1/2/4 → scaled to 0–255.
  const to8 = (v: number): number =>
    depth === 16 ? v >> 8 : depth === 8 ? v : (v * 255) / ((1 << depth) - 1);
  // The tRNS key, compared at the file's depth.
  const key =
    transparency !== undefined && colorType !== 3
      ? Array.from(
          { length: samples },
          (_, c) =>
            (((transparency[c * 2] as number) << 8) | (transparency[c * 2 + 1] as number)) &
            ((1 << depth) - 1),
        )
      : undefined;
  const y = pass.y0 + passRow * pass.dy;
  for (let px = 0; px < pass.width; px += 1) {
    const to = (y * width + pass.x0 + px * pass.dx) * channels;
    const first = sampleAt(row, px * samples, depth);
    if (colorType === 3) {
      const entry = first * 3;
      if (palette === undefined || entry >= palette.length) {
        return "a pixel points past the palette";
      }
      out[to] = palette[entry] as number;
      out[to + 1] = palette[entry + 1] as number;
      out[to + 2] = palette[entry + 2] as number;
      if (channels === 4) {
        out[to + 3] = transparency?.[first] ?? 255;
      }
      continue;
    }
    if (colorType === 0 || colorType === 4) {
      const gray = to8(first);
      if (channels === 1) {
        out[to] = gray;
        continue;
      }
      out[to] = gray;
      out[to + 1] = gray;
      out[to + 2] = gray;
      out[to + 3] =
        colorType === 4
          ? to8(sampleAt(row, px * samples + 1, depth))
          : first === key?.[0]
            ? 0
            : 255;
      continue;
    }
    let keyed = key !== undefined;
    for (let c = 0; c < samples; c += 1) {
      const value = sampleAt(row, px * samples + c, depth);
      out[to + c] = to8(value);
      keyed = keyed && value === key?.[c];
    }
    if (colorType === 2 && channels === 4) {
      out[to + 3] = keyed ? 0 : 255;
    }
  }
  return undefined;
}

const mib = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));

/** Decode `bytes` to 8-bit pixels. Never throws on bad bytes. */
export async function decodePng(
  bytes: Uint8Array,
  inflate: Inflate,
): Promise<DecodedPng | PngRefusal> {
  const header = readPngHeader(bytes);
  if ("refused" in header) {
    return header;
  }
  const { width, height, depth, colorType, rawBytes, outColor } = header;
  const cost = pngDecodeCost(header);
  if (cost > MAX_PNG_DECODE_BYTES) {
    return {
      refused: `the PNG is ${width}×${height}: decoding it needs ${mib(cost)} MiB, over the ${mib(MAX_PNG_DECODE_BYTES)} MiB limit`,
    };
  }
  const stream = new Uint8Array(header.idat.reduce((sum, part) => sum + part.length, 0));
  let filled = 0;
  for (const part of header.idat) {
    stream.set(part, filled);
    filled += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = await inflate(stream, rawBytes);
  } catch (error) {
    return corrupt(
      (error as { code?: unknown } | null)?.code === "ERR_BUFFER_TOO_LARGE"
        ? "more image data than its header declares"
        : "the compressed image data is truncated or invalid",
    );
  }
  if (raw.length !== rawBytes) {
    return corrupt(
      raw.length < rawBytes
        ? "less image data than its header declares"
        : "more image data than its header declares",
    );
  }
  const pixels = new Uint8Array(width * height * PNG_CHANNELS[outColor]);
  // 8-bit rows already in the output's layout are copied whole.
  const direct =
    header.interlace === 0 &&
    depth === 8 &&
    header.transparency === undefined &&
    (colorType === 0 || colorType === 2 || colorType === 6);
  const step = Math.ceil(((SAMPLES[colorType] as number) * depth) / 8);
  let at = 0;
  for (const pass of passes(width, height, header.interlace)) {
    const stride = rowBytes(pass.width, colorType, depth);
    let above: Uint8Array | undefined;
    for (let y = 0; y < pass.height; y += 1) {
      const row = raw.subarray(at + 1, at + 1 + stride);
      if (!unfilter(raw[at] as number, row, above, step)) {
        return corrupt(`unknown filter byte ${raw[at]}`);
      }
      if (direct) {
        pixels.set(row, y * stride);
      } else {
        const wrong = expandRow(header, row, pass, y, pixels);
        if (wrong !== undefined) {
          return corrupt(wrong);
        }
      }
      above = row;
      at += 1 + stride;
    }
  }
  return { width, height, color: outColor, pixels };
}
