/**
 * PDF images: the pure half of putting a page's pictures into a read
 * (docs/feat/pdf-images.md D1–D3). No pdf.js, no I/O — the worker
 * (`packages/tools/src/pdf/run.ts`) feeds it pdf.js's operator list and the
 * decoded image objects; this file decides where each image sits, which ones
 * are kept, what the marker says and what the PNG is.
 */

import { type Deflate, PNG_CHANNELS, type PngColor, encodePng } from "./png.ts";

/** The operator codes the walk needs (pdf.js `OPS`, passed in). */
export interface PdfImageOps {
  readonly save: number;
  readonly restore: number;
  readonly transform: number;
  readonly paintFormXObjectBegin: number;
  readonly paintFormXObjectEnd: number;
  readonly paintImageXObject: number;
  readonly paintInlineImageXObject: number;
  readonly paintImageXObjectRepeat: number;
}

/**
 * One image paint: where its unit square lands on the page, in PDF user space
 * (y grows UP, the same space as a text item's `transform`).
 */
export interface PdfImagePaint {
  /** Index into the operator list (an inline image's object is `argsArray[op][0]`). */
  readonly op: number;
  /** The XObject id (`page.objs` / `page.commonObjs` for `g_…`); `null` = inline. */
  readonly objId: string | null;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

type Matrix = readonly [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function asMatrix(value: unknown): Matrix | null {
  if (value === null || typeof value !== "object" || !("length" in value)) {
    return null;
  }
  const list = value as ArrayLike<unknown>;
  if (list.length !== 6) {
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < 6; i += 1) {
    const n = list[i];
    if (typeof n !== "number" || !Number.isFinite(n)) {
      return null;
    }
    out.push(n);
  }
  return out as unknown as Matrix;
}

/** `m × ctm` — a `cm` operator's matrix applied to the current CTM. */
function multiply(m: Matrix, ctm: Matrix): Matrix {
  return [
    m[0] * ctm[0] + m[1] * ctm[2],
    m[0] * ctm[1] + m[1] * ctm[3],
    m[2] * ctm[0] + m[3] * ctm[2],
    m[2] * ctm[1] + m[3] * ctm[3],
    m[4] * ctm[0] + m[5] * ctm[2] + ctm[4],
    m[4] * ctm[1] + m[5] * ctm[3] + ctm[5],
  ];
}

function paintAt(op: number, objId: string | null, ctm: Matrix): PdfImagePaint {
  const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
  const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
  return {
    op,
    objId,
    left: Math.min(...xs),
    right: Math.max(...xs),
    bottom: Math.min(...ys),
    top: Math.max(...ys),
  };
}

/**
 * Every image paint of a page's operator list, with its box, in paint order.
 * Tracks the CTM through `save`/`restore`/`transform` and form XObjects (whose
 * begin is a save + its matrix). Stencil masks (`paintImageMaskXObject`) and
 * pdf.js's merged groups of tiny inline images are not images here (D1).
 */
export function walkImagePaints(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: PdfImageOps,
): PdfImagePaint[] {
  const paints: PdfImagePaint[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  for (let i = 0; i < fnArray.length; i += 1) {
    const fn = fnArray[i];
    const args = argsArray[i];
    const arg = (k: number): unknown =>
      args !== null && typeof args === "object" && "length" in args
        ? (args as ArrayLike<unknown>)[k]
        : undefined;
    if (fn === ops.save) {
      stack.push(ctm);
    } else if (fn === ops.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === ops.transform) {
      const m = asMatrix(args);
      if (m !== null) {
        ctm = multiply(m, ctm);
      }
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = asMatrix(arg(0));
      if (m !== null) {
        ctm = multiply(m, ctm);
      }
    } else if (fn === ops.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === ops.paintImageXObject) {
      const id = arg(0);
      if (typeof id === "string") {
        paints.push(paintAt(i, id, ctm));
      }
    } else if (fn === ops.paintInlineImageXObject) {
      paints.push(paintAt(i, null, ctm));
    } else if (fn === ops.paintImageXObjectRepeat) {
      const id = arg(0);
      const sx = arg(1);
      const sy = arg(2);
      const positions = arg(3) as ArrayLike<unknown> | undefined;
      if (
        typeof id === "string" &&
        typeof sx === "number" &&
        typeof sy === "number" &&
        positions !== undefined &&
        positions !== null &&
        typeof positions.length === "number"
      ) {
        for (let j = 0; j + 1 < positions.length; j += 2) {
          const px = positions[j];
          const py = positions[j + 1];
          if (typeof px === "number" && typeof py === "number") {
            paints.push(paintAt(i, id, multiply([sx, 0, 0, sy, px, py], ctm)));
          }
        }
      }
    }
  }
  return paints;
}

/** pdf.js `ImageKind`: 1 = 1-bit gray (packed rows), 2 = RGB, 3 = RGBA. */
export const PDF_IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const;

/** A decoded image object as pdf.js hands it back (`{width, height, kind, data}`). */
export interface PdfDecodedImage {
  readonly width: number;
  readonly height: number;
  readonly kind: number;
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** A decoded image as 8-bit PNG-ready pixels, or `null` when its shape is not one we read. */
export function imagePixels(
  image: PdfDecodedImage,
): { readonly color: PngColor; readonly pixels: Uint8Array } | null {
  const { width, height, kind, data } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    return null;
  }
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (kind === PDF_IMAGE_KIND.RGB_24BPP) {
    return bytes.length === width * height * 3 ? { color: "rgb", pixels: bytes } : null;
  }
  if (kind === PDF_IMAGE_KIND.RGBA_32BPP) {
    return bytes.length === width * height * 4 ? { color: "rgba", pixels: bytes } : null;
  }
  if (kind === PDF_IMAGE_KIND.GRAYSCALE_1BPP) {
    const rowBytes = Math.ceil(width / 8);
    if (bytes.length < rowBytes * height) {
      return null;
    }
    // pdf.js paints a set bit white and a clear bit black (canvas putBinaryImageData).
    const gray = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const byte = bytes[y * rowBytes + (x >> 3)] as number;
        gray[y * width + x] = byte & (0x80 >> (x & 7)) ? 255 : 0;
      }
    }
    return { color: "gray", pixels: gray };
  }
  return null;
}

/** The size a `width × height` image is sent at: its long edge at most `maxEdge`. */
export function scaledSize(
  width: number,
  height: number,
  maxEdge: number,
): { readonly width: number; readonly height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Box (area-average) downscale of 8-bit pixels to `toWidth × toHeight`. */
export function downscalePixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  toWidth: number,
  toHeight: number,
): Uint8Array {
  if (toWidth === width && toHeight === height) {
    return pixels;
  }
  const out = new Uint8Array(toWidth * toHeight * channels);
  const sums = new Float64Array(channels);
  for (let ty = 0; ty < toHeight; ty += 1) {
    const y0 = Math.floor((ty * height) / toHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * height) / toHeight));
    for (let tx = 0; tx < toWidth; tx += 1) {
      const x0 = Math.floor((tx * width) / toWidth);
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * width) / toWidth));
      sums.fill(0);
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const at = (y * width + x) * channels;
          for (let c = 0; c < channels; c += 1) {
            sums[c] = (sums[c] as number) + (pixels[at + c] as number);
          }
        }
      }
      const count = (y1 - y0) * (x1 - x0);
      const to = (ty * toWidth + tx) * channels;
      for (let c = 0; c < channels; c += 1) {
        out[to + c] = Math.round((sums[c] as number) / count);
      }
    }
  }
  return out;
}

/** A 53-bit hash of decoded pixels + shape: "the same picture" without crypto. */
export function pixelKey(
  width: number,
  height: number,
  color: PngColor,
  pixels: Uint8Array,
): string {
  let h1 = 0xdeadbeef ^ width;
  let h2 = 0x41c6ce57 ^ height;
  for (const byte of pixels) {
    h1 = Math.imul(h1 ^ byte, 2654435761);
    h2 = Math.imul(h2 ^ byte, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return `${width}x${height}:${color}:${hash.toString(36)}`;
}

/** The filters and caps of one read (owner Q4: numbers are configurable). */
export interface PdfImageLimits {
  /** An image whose smaller side is under this many px is skipped (rules, bullets). */
  readonly minSide: number;
  /** An image under this many px² is skipped. */
  readonly minArea: number;
  /** The same pixels this many times in a read = a repeat (logo, header): sent once. */
  readonly repeatAt: number;
  /** Images sent per read at most. */
  readonly maxSent: number;
  /** PNG bytes sent per read at most. */
  readonly maxBytes: number;
  /** A sent image's long edge, in px, at most (box-downscaled past it). */
  readonly maxEdge: number;
  /**
   * Image work per read, in ms, at most. A page reached after it is not
   * examined for images (no operator list, no decode) and is counted, so the
   * text and the read's verdict always come back well inside the parse
   * timeout: a 100-page scan otherwise spends ~18 s on images.
   */
  readonly maxMs: number;
  /**
   * With an id hasher (`createImageCollector`'s `sha256`): also keep a second,
   * smaller variant whose long edge is at most this many px, for `image_view`'s
   * `detail: "low"` (docs/feat/image-view.md D3). Absent = one variant, no ids.
   */
  readonly lowEdge?: number;
}

export const DEFAULT_PDF_IMAGE_LIMITS: PdfImageLimits = {
  minSide: 24,
  minArea: 32 * 32,
  repeatAt: 3,
  maxSent: 32,
  maxBytes: 8 * 1024 * 1024,
  maxEdge: 1568,
  maxMs: 5_000,
};

/** One kept image of a read, as the page carries it (D5). */
export interface PdfPageImage {
  /** The marker line placed in the page's text. */
  readonly marker: string;
  /** The PNG, when this image is sent (S2: dropped at `fs_read`). */
  readonly png?: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The sha256 of `png` (docs/feat/image-view.md D3): set only when the read keeps refs. */
  readonly id?: string;
  /** The `detail: "low"` PNG; absent when the picture is already within `lowEdge` (low = high). */
  readonly low?: Uint8Array;
  /** The low variant's id (`id` itself when `low` is absent) and size. */
  readonly lowId?: string;
  readonly lowWidth?: number;
  readonly lowHeight?: number;
}

/** What a read did with its images — the footer's numbers. */
export interface PdfImageSummary {
  readonly sent: number;
  readonly repeats: number;
  readonly tiny: number;
  readonly capped: number;
  readonly undecodable: number;
  /** Pages not examined for images: reached after `maxMs`. */
  readonly unexamined: number;
  /** The read keeps its images for `image_view` (the footer says so instead of `sent`). */
  readonly refs?: true;
  /** Kept images the session store then refused (`fs_read` counts them). */
  readonly refused?: number;
}

/** One image after the read: its page, its box and what it became. */
export interface PdfImageOutcome extends PdfPageImage {
  readonly page: number;
  readonly paint: PdfImagePaint;
}

/** `[image p.N · W×H]`, with an optional `· <note>` (D2's grammar). */
export function imageMarker(page: number, width: number, height: number, note?: string): string {
  const size = width > 0 && height > 0 ? ` · ${width}×${height}` : "";
  return `[image p.${page}${size}${note === undefined ? "" : ` · ${note}`}]`;
}

/** The dense-page hint (owner Q3): a paint box covering ≥ 50 % of the page box. */
export const FULL_PAGE_HINT = 'full page — detail "high" for small text';

/**
 * Rewrite every marker naming `id` (its first 12 hex characters) from
 * `ref <id12>` (and the dense-page hint after it) to `not kept: <reason>` —
 * the store refused that picture (docs/feat/image-view.md D4).
 */
export function unkeepImageMarker(text: string, id: string, reason: string): string {
  const id12 = id.slice(0, 12);
  return text
    .split(`ref ${id12} · ${FULL_PAGE_HINT}]`)
    .join(`not kept: ${reason}]`)
    .split(`ref ${id12}]`)
    .join(`not kept: ${reason}]`);
}

const MARKER_LINE = /^\[image p\.\d+[^\n]*\]$/;

/**
 * A page's text without its image marker lines — what the "is it a scan?"
 * verdict must judge: a marker is not text the document carries.
 */
export function stripImageMarkers(text: string): string {
  if (!text.includes("[image p.")) {
    return text;
  }
  return text
    .split("\n")
    .filter((line) => !MARKER_LINE.test(line))
    .join("\n");
}

/**
 * The read's image footer, or `""` when every image found was sent (nothing
 * to explain). Counts are listed, never averaged away.
 */
export function imageFooter(summary: PdfImageSummary): string {
  const { repeats, tiny, capped, undecodable, unexamined } = summary;
  const refused = summary.refused ?? 0;
  if (repeats + tiny + capped + undecodable + unexamined + refused === 0) {
    return "";
  }
  const parts = [`${summary.sent} ${summary.refs === true ? "kept for image_view" : "sent"}`];
  if (refused > 0) {
    parts.push(`${refused} not kept (see the markers)`);
  }
  if (summary.repeats > 0) {
    parts.push(`${summary.repeats} ${summary.repeats === 1 ? "repeat" : "repeats"}`);
  }
  if (summary.tiny > 0) {
    parts.push(`${summary.tiny} tiny skipped`);
  }
  if (summary.undecodable > 0) {
    parts.push(`${summary.undecodable} undecodable`);
  }
  if (summary.capped > 0) {
    parts.push(`${summary.capped} over the per-read cap — read fewer pages to get the rest`);
  }
  if (unexamined > 0) {
    parts.push(
      `${unexamined} ${unexamined === 1 ? "page" : "pages"} not examined for images (time limit) — read fewer pages to get them`,
    );
  }
  return `[images: ${parts.join(", ")}]`;
}

interface Occurrence {
  readonly page: number;
  readonly paint: PdfImagePaint;
  readonly key: string | null;
  readonly width: number;
  readonly height: number;
  /** The paint covers ≥ 50 % of its page box (the dense-page hint). */
  readonly fullPage: boolean;
}

interface FirstSeen {
  readonly page: number;
  readonly index: number;
  readonly width: number;
  readonly height: number;
  png: Uint8Array | undefined;
  /** With refs (D3): the ids, and the low variant when it differs. */
  id?: string;
  low?: Uint8Array;
  lowId?: string;
  lowWidth?: number;
  lowHeight?: number;
}

export interface PdfImageCollector {
  /**
   * One paint and its decoded object (`null` when it could not be decoded).
   * `cacheId` (the XObject id) skips re-hashing an object painted again.
   * `pageArea` (the page box, PDF units²) enables the dense-page hint.
   */
  add(
    page: number,
    paint: PdfImagePaint,
    image: PdfDecodedImage | null,
    cacheId?: string,
    pageArea?: number,
  ): void;
  /** One page not examined for images (the read's `maxMs` ran out first). */
  skipPage(): void;
  /** Decide every image of the read: outcomes in paint order, and the summary. */
  finish(): { readonly images: readonly PdfImageOutcome[]; readonly summary: PdfImageSummary };
}

/**
 * The per-read image pipeline (D3): tiny images skipped, the first occurrence
 * of each distinct picture encoded (within the byte cap, which stops further
 * encoding once hit), and at `finish` repeats and the count cap decided —
 * repeats need the whole read, so outcomes come only then. Holds at most the
 * capped PNG bytes, never a decoded image past its `add`.
 */
export function createImageCollector(
  deflate: Deflate,
  limits: PdfImageLimits = DEFAULT_PDF_IMAGE_LIMITS,
  sha256?: (bytes: Uint8Array) => string,
): PdfImageCollector {
  // docs/feat/image-view.md D3: injected, so core stays free of `node:` imports.
  const hash = limits.lowEdge !== undefined ? sha256 : undefined;
  const lowEdge = limits.lowEdge ?? limits.maxEdge;
  const occurrences: Occurrence[] = [];
  const first = new Map<string, FirstSeen>();
  const counts = new Map<string, number>();
  const keyCache = new Map<string, { key: string; color: PngColor; pixels: Uint8Array } | null>();
  let tiny = 0;
  let unexamined = 0;
  let encodedBytes = 0;
  let encodedCount = 0;
  let full = false;

  return {
    add(page, paint, image, cacheId, pageArea) {
      const paintArea = (paint.right - paint.left) * (paint.top - paint.bottom);
      const fullPage =
        hash !== undefined && pageArea !== undefined && pageArea > 0 && paintArea >= pageArea / 2;
      if (image === null) {
        occurrences.push({ page, paint, key: null, width: 0, height: 0, fullPage });
        return;
      }
      const { width, height } = image;
      if (Math.min(width, height) < limits.minSide || width * height < limits.minArea) {
        tiny += 1;
        return;
      }
      let decoded = cacheId === undefined ? undefined : keyCache.get(cacheId);
      if (decoded === undefined) {
        const px = imagePixels(image);
        decoded = px === null ? null : { ...px, key: pixelKey(width, height, px.color, px.pixels) };
        if (cacheId !== undefined) {
          // Only the key is kept across paints; the pixels are dropped below.
          keyCache.set(
            cacheId,
            decoded === null ? null : { ...decoded, pixels: new Uint8Array(0) },
          );
        }
      }
      if (decoded === null) {
        occurrences.push({ page, paint, key: null, width, height, fullPage });
        return;
      }
      const size = scaledSize(width, height, limits.maxEdge);
      const key = decoded.key;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!first.has(key)) {
        const seen: FirstSeen = {
          page,
          index: occurrences.length,
          width: size.width,
          height: size.height,
          png: undefined,
        };
        if (!full && encodedCount < limits.maxSent && decoded.pixels.length > 0) {
          const channels = PNG_CHANNELS[decoded.color];
          const pixels = downscalePixels(
            decoded.pixels,
            width,
            height,
            channels,
            size.width,
            size.height,
          );
          const png = encodePng(size.width, size.height, pixels, decoded.color, deflate);
          if (encodedBytes + png.length > limits.maxBytes) {
            full = true;
          } else {
            seen.png = png;
            encodedBytes += png.length;
            encodedCount += 1;
            if (hash !== undefined) {
              // The low variant from the SAME decoded pixels, while they exist
              // (they are dropped right after this `add`).
              seen.id = hash(png);
              const small = scaledSize(width, height, lowEdge);
              if (small.width === size.width && small.height === size.height) {
                seen.lowId = seen.id;
              } else {
                const lowPx = downscalePixels(
                  decoded.pixels,
                  width,
                  height,
                  channels,
                  small.width,
                  small.height,
                );
                seen.low = encodePng(small.width, small.height, lowPx, decoded.color, deflate);
                seen.lowId = hash(seen.low);
              }
              seen.lowWidth = small.width;
              seen.lowHeight = small.height;
            }
          }
        } else {
          full = true;
        }
        first.set(key, seen);
      }
      occurrences.push({ page, paint, key, width: size.width, height: size.height, fullPage });
    },

    skipPage() {
      unexamined += 1;
    },

    finish() {
      const images: PdfImageOutcome[] = [];
      let sent = 0;
      let repeats = 0;
      let capped = 0;
      let undecodable = 0;
      occurrences.forEach((occ, index) => {
        const base = { page: occ.page, paint: occ.paint, width: occ.width, height: occ.height };
        if (occ.key === null) {
          undecodable += 1;
          images.push({
            ...base,
            marker: imageMarker(occ.page, occ.width, occ.height, "not sent: undecodable"),
          });
          return;
        }
        const seen = first.get(occ.key);
        const count = counts.get(occ.key) ?? 0;
        if (seen !== undefined && count >= limits.repeatAt && seen.index !== index) {
          repeats += 1;
          images.push({
            ...base,
            marker: imageMarker(occ.page, occ.width, occ.height, `same as p.${seen.page}`),
          });
          return;
        }
        if (seen?.png !== undefined && sent < limits.maxSent) {
          sent += 1;
          if (seen.id !== undefined && seen.lowId !== undefined) {
            const hint = occ.fullPage ? ` · ${FULL_PAGE_HINT}` : "";
            const note = `ref ${seen.id.slice(0, 12)}${hint}`;
            images.push({
              ...base,
              marker: imageMarker(occ.page, occ.width, occ.height, note),
              png: seen.png,
              id: seen.id,
              lowId: seen.lowId,
              lowWidth: seen.lowWidth ?? occ.width,
              lowHeight: seen.lowHeight ?? occ.height,
              ...(seen.low !== undefined ? { low: seen.low } : {}),
            });
            return;
          }
          images.push({
            ...base,
            marker: imageMarker(occ.page, occ.width, occ.height),
            png: seen.png,
          });
          return;
        }
        capped += 1;
        const cap = hash !== undefined ? "not kept: per-read cap" : "not sent: per-read cap";
        images.push({ ...base, marker: imageMarker(occ.page, occ.width, occ.height, cap) });
      });
      const summary: PdfImageSummary = { sent, repeats, tiny, capped, undecodable, unexamined };
      return { images, summary: hash !== undefined ? { ...summary, refs: true } : summary };
    },
  };
}
