/**
 * A part of a picture (docs/feat/image-region-png.md D3): fractions of its size
 * → source pixels → crop → at most the detail's size (never enlarged) → a PNG
 * under the model's byte cap.
 *
 * Pure: the caller hands in `deflate` (see `png.ts`).
 */
import { formatBytes } from "./attachments.ts";
import { downscalePixels, scaledSize } from "./pdf-images.ts";
import type { DecodedPng } from "./png-decode.ts";
import { type Deflate, PNG_CHANNELS, type PngColor, encodePng } from "./png.ts";

/** A part with a side under this many source px shows nothing: refused. */
export const MIN_REGION_PX = 8;

/** Each step-down over the byte cap scales the long edge by this… */
const BYTE_STEP = 0.75;
/** …at most this many times. */
const MAX_BYTE_STEPS = 3;

/** Absorbs float noise (`0.07 × 100` is 7.000000000000001, which is 7 px, not 8). */
const EPSILON = 1e-9;

/** A part of a picture, each number a fraction 0–1 of its size (O1). */
export interface ImageRegion {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** The part in the source picture's pixels. */
export interface RegionBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** It spilled past an edge and was cut there (O3). */
  readonly clamped: boolean;
}

/** `region` in the pixels of a `width × height` picture: start floored, end ceiled. */
export function regionBox(
  region: ImageRegion,
  width: number,
  height: number,
): RegionBox | { readonly refused: string } {
  if (region.left >= 1 || region.top >= 1) {
    return {
      refused: "the region starts at the picture's edge — left and top must be under 1",
    };
  }
  const right = region.left + region.width;
  const bottom = region.top + region.height;
  const x = Math.floor(region.left * width + EPSILON);
  const y = Math.floor(region.top * height + EPSILON);
  const w = Math.ceil(Math.min(1, right) * width - EPSILON) - x;
  const h = Math.ceil(Math.min(1, bottom) * height - EPSILON) - y;
  if (w < MIN_REGION_PX || h < MIN_REGION_PX) {
    return { refused: `${w}×${h} px — too small; pick a larger part` };
  }
  return { x, y, width: w, height: h, clamped: right > 1 + EPSILON || bottom > 1 + EPSILON };
}

/** The box's pixels, row-major; the SAME buffer when the box is the whole picture. */
export function cropPixels(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  box: RegionBox,
): Uint8Array {
  if (box.x === 0 && box.y === 0 && box.width === width && box.height === height) {
    return pixels;
  }
  const stride = box.width * channels;
  const out = new Uint8Array(stride * box.height);
  for (let y = 0; y < box.height; y += 1) {
    const from = ((box.y + y) * width + box.x) * channels;
    out.set(pixels.subarray(from, from + stride), y * stride);
  }
  return out;
}

/** An RGBA buffer with every pixel opaque, as RGB (a quarter fewer bytes, O5). */
function withoutOpaqueAlpha(
  pixels: Uint8Array,
  color: PngColor,
): { readonly color: PngColor; readonly pixels: Uint8Array } {
  if (color !== "rgba") {
    return { color, pixels };
  }
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] !== 255) {
      return { color, pixels };
    }
  }
  const rgb = new Uint8Array((pixels.length / 4) * 3);
  for (let from = 0, to = 0; from < pixels.length; from += 4, to += 3) {
    rgb[to] = pixels[from] as number;
    rgb[to + 1] = pixels[from + 1] as number;
    rgb[to + 2] = pixels[from + 2] as number;
  }
  return { color: "rgb", pixels: rgb };
}

export interface RenderedRegion {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** It was made smaller than the detail's size to fit the byte cap. */
  readonly scaledForBytes: boolean;
}

/** The PNG of one part: long edge ≤ `maxEdge`, bytes ≤ `maxBytes`. */
export function renderRegion(input: {
  readonly decoded: DecodedPng;
  readonly box: RegionBox;
  readonly maxEdge: number;
  readonly maxBytes: number;
  readonly deflate: Deflate;
}): RenderedRegion | { readonly refused: string } {
  const { decoded, box, maxEdge, maxBytes, deflate } = input;
  const cropped = cropPixels(
    decoded.pixels,
    decoded.width,
    decoded.height,
    PNG_CHANNELS[decoded.color],
    box,
  );
  const { color, pixels } = withoutOpaqueAlpha(cropped, decoded.color);
  let edge = maxEdge;
  for (let step = 0; step <= MAX_BYTE_STEPS; step += 1) {
    const size = scaledSize(box.width, box.height, edge);
    const scaled = downscalePixels(
      pixels,
      box.width,
      box.height,
      PNG_CHANNELS[color],
      size.width,
      size.height,
    );
    const png = encodePng(size.width, size.height, scaled, color, deflate);
    if (png.length <= maxBytes) {
      return { png, ...size, scaledForBytes: step > 0 };
    }
    edge = Math.max(1, Math.floor(Math.max(size.width, size.height) * BYTE_STEP));
  }
  return {
    refused: `the region is too detailed to send under this model's ${formatBytes(maxBytes)} image limit — pick a smaller part or detail low`,
  };
}
