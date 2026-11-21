import { describe, expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { PNG_CHANNELS, type PngColor, crc32, encodePng } from "../src/png.ts";

const deflate = (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes));

/** A test-only PNG reader: chunks, CRCs checked, IDAT inflated, filter 0 rows. */
function decode(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  const types: string[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
    types.push(type);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      expect(png[at + 16]).toBe(8);
      colorType = png[at + 17] ?? -1;
    }
    if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const raw = inflateSync(new Uint8Array(Buffer.concat(idat)));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * (stride + 1)]).toBe(0);
    pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, colorType, pixels, types };
}

function pattern(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 0xff);
}

describe("encodePng", () => {
  const cases: [PngColor, number, number, number][] = [
    ["gray", 0, 7, 5],
    ["rgb", 2, 13, 3],
    ["rgba", 6, 5, 9],
    ["rgb", 2, 1, 1],
    ["gray", 0, 1, 1],
  ];
  for (const [color, type, w, h] of cases) {
    test(`${color} ${w}×${h} round-trips to identical pixels`, () => {
      const pixels = pattern(w * h * PNG_CHANNELS[color]);
      const out = decode(encodePng(w, h, pixels, color, deflate));
      expect(out.types).toEqual(["IHDR", "IDAT", "IEND"]);
      expect([out.width, out.height, out.colorType]).toEqual([w, h, type]);
      expect([...out.pixels]).toEqual([...pixels]);
    });
  }

  test("CRC-32 matches the known IEND value", () => {
    expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
  });

  test("a buffer of the wrong size throws instead of encoding garbage", () => {
    expect(() => encodePng(2, 2, new Uint8Array(11), "rgb", deflate)).toThrow();
    expect(() => encodePng(0, 2, new Uint8Array(0), "rgb", deflate)).toThrow();
  });
});
