/**
 * A minimal PNG decoder + pixel diff for the kit's calibration
 * (docs/feat/mobile-mockup-kit.md Slice 3). Decodes 8-bit RGB/RGBA,
 * non-interlaced only (what the simulator and headless Chrome write); anything
 * else THROWS with the header fields — a case is reported as an error, never
 * skipped. No dependency: `node:zlib` inflate.
 */
import { inflateSync } from "node:zlib";

export interface Image {
  readonly width: number;
  readonly height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  readonly rgba: Uint8Array;
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** Byte arrays end to end. */
export function concat(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function decodePng(bytes: Uint8Array): Image {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error("png: not a PNG (bad signature)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat: Uint8Array[] = [];
  while (pos < bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      const [depth, color, , , interlace] = data.subarray(8, 13);
      channels = color === 6 ? 4 : color === 2 ? 3 : 0;
      if (depth !== 8 || channels === 0 || interlace !== 0) {
        throw new Error(
          `png: unsupported format (bit depth ${depth}, colour type ${color}, interlace ${interlace}); need 8-bit RGB/RGBA, non-interlaced`,
        );
      }
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + len;
  }
  if (width === 0) {
    throw new Error("png: no IHDR");
  }
  const raw = inflateSync(concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? (cur[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      const v = line[x] ?? 0;
      let out: number;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`png: bad filter ${filter} on row ${y}`);
      cur[x] = out & 0xff;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      rgba[o] = cur[x * channels] ?? 0;
      rgba[o + 1] = cur[x * channels + 1] ?? 0;
      rgba[o + 2] = cur[x * channels + 2] ?? 0;
      rgba[o + 3] = channels === 4 ? (cur[x * channels + 3] ?? 0) : 255;
    }
    prev = cur;
  }
  return { width, height, rgba };
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A pixel channel this far off counts as different. */
export const CHANNEL_TOLERANCE = 24;

const near = (a: Image, ai: number, b: Image, bi: number): boolean =>
  Math.abs((a.rgba[ai] ?? 0) - (b.rgba[bi] ?? 0)) <= CHANNEL_TOLERANCE &&
  Math.abs((a.rgba[ai + 1] ?? 0) - (b.rgba[bi + 1] ?? 0)) <= CHANNEL_TOLERANCE &&
  Math.abs((a.rgba[ai + 2] ?? 0) - (b.rgba[bi + 2] ?? 0)) <= CHANNEL_TOLERANCE;

/** Does `img` have a pixel within 1 px of (x, y) matching `ref`'s (x, y)? (AA tolerance) */
function matchNearby(ref: Image, img: Image, x: number, y: number): boolean {
  const ri = (y * ref.width + x) * 4;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= img.width || ny >= img.height) continue;
      if (near(ref, ri, img, (ny * img.width + nx) * 4)) return true;
    }
  }
  return false;
}

export interface DiffResult {
  readonly score: number;
  readonly differing: number;
  readonly area: number;
  /** One flag per pixel of the compared area (the heat-map). */
  readonly mask: Uint8Array;
}

/**
 * Compare two same-size images over their whole area minus `masks`: a pixel
 * differs when no pixel within 1 px in EITHER direction matches it.
 * `score = 1 − differing / area`.
 */
export function diffImages(a: Image, b: Image, masks: readonly Rect[] = []): DiffResult {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`diff: size mismatch ${a.width}×${a.height} vs ${b.width}×${b.height}`);
  }
  const masked = (x: number, y: number) =>
    masks.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h);
  const mask = new Uint8Array(a.width * a.height);
  let differing = 0;
  let area = 0;
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (masked(x, y)) continue;
      area += 1;
      if (!matchNearby(a, b, x, y) || !matchNearby(b, a, x, y)) {
        differing += 1;
        mask[y * a.width + x] = 1;
      }
    }
  }
  return { score: area === 0 ? 1 : 1 - differing / area, differing, area, mask };
}

/** A sub-image. */
export function crop(img: Image, r: Rect): Image {
  if (r.x < 0 || r.y < 0 || r.x + r.w > img.width || r.y + r.h > img.height) {
    throw new Error(`crop: rect ${r.x},${r.y} ${r.w}×${r.h} outside ${img.width}×${img.height}`);
  }
  const rgba = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y += 1) {
    rgba.set(
      img.rgba.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4),
      y * r.w * 4,
    );
  }
  return { width: r.w, height: r.h, rgba };
}

/** The band a score falls in, as text + glyph (never colour alone: owner colour-blind). */
export function band(score: number): { readonly glyph: "✓" | "≈" | "✗"; readonly label: string } {
  if (score >= 0.98) return { glyph: "✓", label: "match" };
  if (score >= 0.92) return { glyph: "≈", label: "close" };
  return { glyph: "✗", label: "drift" };
}
