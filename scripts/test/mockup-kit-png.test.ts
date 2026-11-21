/**
 * The calibration's PNG decoder and pixel diff (docs/feat/mobile-mockup-kit.md
 * Slice 3): fixtures are encoded in-test (`zlib.deflateSync` of known rows).
 */
import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { calibrateCommand } from "../mockup-kit/calibrate.ts";
import { band, concat, crop, decodePng, diffImages } from "../mockup-kit/png.ts";

describe("calibrate: never an empty all-green page", () => {
  test("Chrome missing → exit 2; no e2e run → exit 2", async () => {
    expect(await calibrateCommand(["--chrome", "/nonexistent/chrome"])).toBe(2);
    expect(
      await calibrateCommand(["--chrome", process.execPath, "--run", "/nonexistent/run"]),
    ).toBe(2);
  });
});

type Px = readonly [number, number, number];

const u32 = (n: number): Uint8Array =>
  new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(type);
  return concat([u32(data.length), name, data, new Uint8Array(4)]); // CRC unchecked by the decoder
}

/** RGB PNG of `rows`; `filters[y]` ∈ 0 (none) | 1 (sub) | 2 (up); `ihdr` overrides header bytes. */
function encode(
  rows: readonly (readonly Px[])[],
  filters: readonly number[] = [],
  ihdr: Partial<Record<"depth" | "color" | "interlace", number>> = {},
): Uint8Array {
  const w = rows[0]?.length ?? 0;
  const h = rows.length;
  const header = new Uint8Array(13);
  header.set(u32(w), 0);
  header.set(u32(h), 4);
  header[8] = ihdr.depth ?? 8;
  header[9] = ihdr.color ?? 2;
  header[12] = ihdr.interlace ?? 0;
  const raw: number[] = [];
  let prev: number[] = new Array(w * 3).fill(0);
  rows.forEach((row, y) => {
    const cur = row.flatMap((p) => [...p]);
    const f = filters[y] ?? 0;
    raw.push(f);
    cur.forEach((v, x) => {
      const a = x >= 3 ? (cur[x - 3] ?? 0) : 0;
      const b = prev[x] ?? 0;
      raw.push(f === 1 ? (v - a) & 0xff : f === 2 ? (v - b) & 0xff : v);
    });
    prev = cur;
  });
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
    chunk("IEND", new Uint8Array()),
  ]);
}

const BLACK: Px = [20, 20, 20];
const WHITE: Px = [240, 240, 240];
const fill = (w: number, h: number, at: (x: number, y: number) => Px): Px[][] =>
  Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => at(x, y)));

describe("decodePng", () => {
  test("decodes the exact pixels, through none / sub / up filters", () => {
    const rows = [
      [
        [1, 2, 3],
        [200, 100, 50],
      ],
      [
        [9, 8, 7],
        [10, 250, 0],
      ],
      [
        [255, 0, 128],
        [0, 0, 0],
      ],
    ] as const satisfies readonly (readonly Px[])[];
    const img = decodePng(encode(rows, [0, 1, 2]));
    expect([img.width, img.height]).toEqual([2, 3]);
    expect([...img.rgba]).toEqual([
      1, 2, 3, 255, 200, 100, 50, 255, 9, 8, 7, 255, 10, 250, 0, 255, 255, 0, 128, 255, 0, 0, 0,
      255,
    ]);
  });

  test("an interlaced, 16-bit or palette PNG throws with its header fields", () => {
    const rows = [[BLACK]];
    expect(() => decodePng(encode(rows, [], { interlace: 1 }))).toThrow("interlace 1");
    expect(() => decodePng(encode(rows, [], { depth: 16 }))).toThrow("bit depth 16");
    expect(() => decodePng(encode(rows, [], { color: 3 }))).toThrow("colour type 3");
  });
});

describe("diffImages", () => {
  const half = (shift: number) =>
    decodePng(encode(fill(20, 20, (x) => (x < 10 + shift ? BLACK : WHITE))));

  test("identical → score 1", () => {
    expect(diffImages(half(0), half(0)).score).toBe(1);
  });

  test("an edge shifted 1 px → still ≥ 0.98 (anti-aliasing tolerance)", () => {
    expect(diffImages(half(0), half(1)).score).toBeGreaterThanOrEqual(0.98);
  });

  test("one flipped solid block → the exact ratio, and a mask hides it", () => {
    const a = decodePng(encode(fill(10, 10, () => BLACK)));
    const b = decodePng(
      encode(fill(10, 10, (x, y) => (x >= 4 && x < 6 && y >= 4 && y < 6 ? WHITE : BLACK))),
    );
    const r = diffImages(a, b);
    expect(r.differing).toBe(4);
    expect(r.score).toBeCloseTo(1 - 4 / 100, 10);
    expect(diffImages(a, b, [{ x: 4, y: 4, w: 2, h: 2 }]).score).toBe(1);
  });

  test("a size mismatch throws; crop takes a sub-image; bands carry a glyph and a word", () => {
    expect(() => diffImages(half(0), decodePng(encode(fill(5, 5, () => BLACK))))).toThrow(
      "size mismatch",
    );
    expect(crop(half(0), { x: 9, y: 0, w: 2, h: 1 }).rgba.slice(0, 3)).toEqual(
      new Uint8Array(BLACK),
    );
    expect(band(0.99)).toEqual({ glyph: "✓", label: "match" });
    expect(band(0.95)).toEqual({ glyph: "≈", label: "close" });
    expect(band(0.5)).toEqual({ glyph: "✗", label: "drift" });
  });
});
