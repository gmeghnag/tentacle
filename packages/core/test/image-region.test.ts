/**
 * Cropping and rendering a part of a picture (docs/feat/image-region-png.md D3,
 * T5): fractions → pixels, exact crop bytes, the detail cap without ever
 * enlarging, and the byte cap's step-down then refusal.
 */
import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import { deflateSync, inflate as inflateCb } from "node:zlib";
import {
  MIN_REGION_PX,
  type RegionBox,
  cropPixels,
  regionBox,
  renderRegion,
} from "../src/image-region.ts";
import { type DecodedPng, decodePng } from "../src/png-decode.ts";
import type { PngColor } from "../src/png.ts";

const inflateAsync = promisify(inflateCb);
const deflate = (bytes: Uint8Array): Uint8Array => new Uint8Array(deflateSync(bytes));
const decode = async (png: Uint8Array): Promise<DecodedPng> => {
  const result = await decodePng(
    png,
    async (b, max) => new Uint8Array(await inflateAsync(b, { maxOutputLength: max })),
  );
  if ("refused" in result) throw new Error(result.refused);
  return result;
};

const boxOf = (r: ReturnType<typeof regionBox>): RegionBox => {
  if ("refused" in r) throw new Error(r.refused);
  return r;
};
const said = (r: object): string => ("refused" in r ? String(r.refused) : "(accepted)");

/** A picture whose every byte names its position (seeded noise when asked). */
function picture(width: number, height: number, color: PngColor, noise = false): DecodedPng {
  const channels = { gray: 1, rgb: 3, rgba: 4 }[color];
  let seed = 1;
  const pixels = new Uint8Array(width * height * channels).map((_, i) => {
    seed = (seed * 48271) % 2147483647;
    return noise ? seed & 255 : i % 251;
  });
  return { width, height, color, pixels };
}

describe("regionBox", () => {
  test("fractions map outward: floor the start, ceil the end", () => {
    const box = boxOf(regionBox({ left: 0.333, top: 0.5, width: 0.333, height: 0.25 }, 100, 90));
    expect(box).toEqual({ x: 33, y: 45, width: 34, height: 23, clamped: false });
  });

  test("the whole picture, and a part ending exactly at the edge, are not clamped", () => {
    expect(boxOf(regionBox({ left: 0, top: 0, width: 1, height: 1 }, 640, 480))).toEqual({
      x: 0,
      y: 0,
      width: 640,
      height: 480,
      clamped: false,
    });
    expect(boxOf(regionBox({ left: 0.5, top: 0.5, width: 0.5, height: 0.5 }, 99, 99)).clamped).toBe(
      false,
    );
  });

  test("a part spilling past an edge is clamped to it", () => {
    expect(boxOf(regionBox({ left: 0.75, top: 0, width: 0.5, height: 0.5 }, 100, 100))).toEqual({
      x: 75,
      y: 0,
      width: 25,
      height: 50,
      clamped: true,
    });
    expect(boxOf(regionBox({ left: 0, top: 0.5, width: 0.5, height: 1 }, 100, 100))).toEqual({
      x: 0,
      y: 50,
      width: 50,
      height: 50,
      clamped: true,
    });
  });

  test("a start on the edge is refused", () => {
    for (const region of [
      { left: 1, top: 0, width: 0.5, height: 0.5 },
      { left: 0, top: 1, width: 0.5, height: 0.5 },
    ]) {
      expect(said(regionBox(region, 100, 100))).toContain("starts at the picture's edge");
    }
  });

  test(`a side under ${MIN_REGION_PX} px is refused with its size`, () => {
    expect(MIN_REGION_PX).toBe(8);
    expect(said(regionBox({ left: 0, top: 0, width: 0.07, height: 0.5 }, 100, 100))).toBe(
      "7×50 px — too small; pick a larger part",
    );
    expect(said(regionBox({ left: 0, top: 0, width: 0.5, height: 0.07 }, 100, 100))).toBe(
      "50×7 px — too small; pick a larger part",
    );
    expect(boxOf(regionBox({ left: 0, top: 0, width: 0.08, height: 0.08 }, 100, 100)).width).toBe(
      8,
    );
  });
});

describe("cropPixels", () => {
  test("exact bytes of the box", () => {
    // 4×3, 2 channels: value = y*10 + x, then +100 for the second channel.
    const pixels = new Uint8Array(
      [0, 1, 2].flatMap((y) => [0, 1, 2, 3].flatMap((x) => [y * 10 + x, 100 + y * 10 + x])),
    );
    const out = cropPixels(pixels, 4, 3, 2, { x: 1, y: 1, width: 2, height: 2, clamped: false });
    expect([...out]).toEqual([11, 111, 12, 112, 21, 121, 22, 122]);
  });

  test("the whole picture is the same buffer", () => {
    const pixels = new Uint8Array(12);
    expect(cropPixels(pixels, 4, 3, 1, { x: 0, y: 0, width: 4, height: 3, clamped: false })).toBe(
      pixels,
    );
  });
});

describe("renderRegion", () => {
  const whole = (p: DecodedPng): RegionBox => ({
    x: 0,
    y: 0,
    width: p.width,
    height: p.height,
    clamped: false,
  });
  const render = (decoded: DecodedPng, box: RegionBox, maxEdge: number, maxBytes = 15e6) =>
    renderRegion({ decoded, box, maxEdge, maxBytes, deflate });
  const done = (r: ReturnType<typeof renderRegion>) => {
    if ("refused" in r) throw new Error(r.refused);
    return r;
  };

  test("the long edge is capped at the detail's size", async () => {
    const decoded = picture(2000, 1000, "rgb");
    for (const [maxEdge, short] of [
      [768, 384],
      [1568, 784],
    ] as const) {
      const out = done(render(decoded, whole(decoded), maxEdge));
      expect([out.width, out.height, out.scaledForBytes]).toEqual([maxEdge, short, false]);
      const back = await decode(out.png);
      expect([back.width, back.height]).toEqual([maxEdge, short]);
    }
  });

  test("a small part is NOT enlarged, and holds exactly the cropped pixels", async () => {
    const decoded = picture(100, 80, "rgb");
    const box = { x: 10, y: 20, width: 30, height: 16, clamped: false };
    const out = done(render(decoded, box, 1568));
    expect([out.width, out.height]).toEqual([30, 16]);
    const back = await decode(out.png);
    expect(back.color).toBe("rgb");
    expect([...back.pixels]).toEqual([...cropPixels(decoded.pixels, 100, 80, 3, box)]);
  });

  test("an opaque RGBA part is sent as RGB; one with transparency stays RGBA", async () => {
    const decoded = picture(32, 16, "rgba");
    for (let i = 0; i < 32 * 16; i += 1) decoded.pixels[i * 4 + 3] = 255;
    // One see-through pixel, in the right half only.
    decoded.pixels[(0 * 32 + 20) * 4 + 3] = 254;
    const left = done(render(decoded, { x: 0, y: 0, width: 16, height: 16, clamped: false }, 768));
    const opaque = await decode(left.png);
    expect(opaque.color).toBe("rgb");
    expect([...opaque.pixels.subarray(0, 6)]).toEqual([
      ...decoded.pixels.subarray(0, 3),
      ...decoded.pixels.subarray(4, 7),
    ]);
    const right = done(
      render(decoded, { x: 16, y: 0, width: 16, height: 16, clamped: false }, 768),
    );
    expect((await decode(right.png)).color).toBe("rgba");
  });

  test("over the byte cap: the long edge steps down by ×0.75 until it fits", () => {
    const decoded = picture(400, 200, "rgb", true);
    // Noise does not compress: 400×200 ≈ 240 KB, 300×150 ≈ 135 KB.
    const out = done(render(decoded, whole(decoded), 768, 150_000));
    expect([out.width, out.height, out.scaledForBytes]).toEqual([300, 150, true]);
    expect(out.png.length).toBeLessThanOrEqual(150_000);
  });

  test("…at most three times, then it refuses", () => {
    const decoded = picture(400, 200, "rgb", true);
    let encodes = 0;
    const result = renderRegion({
      decoded,
      box: whole(decoded),
      maxEdge: 768,
      maxBytes: 100,
      deflate: (b) => {
        encodes += 1;
        return deflate(b);
      },
    });
    expect(encodes).toBe(4);
    expect(said(result)).toBe(
      "the region is too detailed to send under this model's 100 B image limit — pick a smaller part or detail low",
    );
  });
});
