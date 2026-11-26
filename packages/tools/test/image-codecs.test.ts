/**
 * The daemon-side JPEG codecs (docs/feat/image-region-jpeg.md D5, T5): pdf.js
 * decodes every fixture like the reference decoder, silently; the orientation
 * geometry agrees with the reference's rotation; and the output encoder makes a
 * JPEG, or a PNG when `Bun.Image` cannot.
 */
import { describe, expect, test } from "bun:test";
import {
  type DecodedPng,
  type ExifOrientation,
  PNG_CHANNELS,
  decodeJpeg,
  orientPixels,
  orientedSize,
  readJpegHeader,
} from "@tentacle/core";
import { type BunImageCtor, createJpegEncoder, decodeJpegPixels } from "../src/image-codecs.ts";
import { decodeAnyPng, difference, fixture, reference } from "./support/jpeg-oracle.ts";

const ORIENTATIONS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const NAMES = [
  "small-baseline",
  "small-progressive",
  "small-gray",
  "small-444",
  "small-rgb-colorspace",
  ...ORIENTATIONS.map((o) => `small-orient-${o}`),
];

async function decodeFixture(name: string): Promise<DecodedPng> {
  const bytes = await fixture(name);
  const header = readJpegHeader(bytes);
  if ("refused" in header) throw new Error(header.refused);
  const decoded = decodeJpeg(bytes, header, decodeJpegPixels);
  if ("refused" in decoded) throw new Error(decoded.refused);
  return decoded;
}

describe("decodeJpegPixels", () => {
  for (const name of NAMES) {
    test(`${name} decodes like the reference decoder`, async () => {
      const decoded = await decodeFixture(name);
      expect([decoded.width, decoded.height]).toEqual([64, 48]);
      expect(decoded.color).toBe(name === "small-gray" ? "gray" : "rgb");
      const delta = difference(decoded, await reference(await fixture(name), false));
      expect(delta.mean).toBeLessThanOrEqual(2);
      expect(delta.max).toBeLessThanOrEqual(32);
    });
  }

  for (const o of ORIENTATIONS) {
    test(`orientation ${o}: our turn equals the reference decoder's`, async () => {
      const stored = await decodeFixture(`small-orient-${o}`);
      const shown = orientedSize(stored.width, stored.height, o as ExifOrientation);
      const ours: DecodedPng = {
        ...shown,
        color: stored.color,
        pixels: orientPixels(
          stored.pixels,
          stored.width,
          stored.height,
          PNG_CHANNELS[stored.color],
          o,
        ),
      };
      const theirs = await reference(await fixture(`small-orient-${o}`), true);
      expect([theirs.width, theirs.height]).toEqual(o < 5 ? [64, 48] : [48, 64]);
      const delta = difference(ours, theirs);
      expect(delta.mean).toBeLessThanOrEqual(2);
      expect(delta.max).toBeLessThanOrEqual(32);
    });
  }

  test("a truncated file writes NOTHING to the console (Ink owns the terminal)", async () => {
    const bytes = await fixture("small-baseline");
    const methods = ["log", "warn", "error", "info", "debug"] as const;
    const real = methods.map((m) => console[m]);
    const written: unknown[][] = [];
    for (const m of methods) {
      console[m] = (...args: unknown[]) => {
        written.push(args);
      };
    }
    try {
      const out = decodeJpegPixels(bytes.slice(0, Math.floor(bytes.length * 0.6)));
      expect([out.width, out.height]).toEqual([64, 48]);
    } finally {
      methods.forEach((m, i) => {
        console[m] = real[i] as (typeof console)[typeof m];
      });
    }
    expect(written).toEqual([]);
  });
});

describe("createJpegEncoder", () => {
  for (const [name, color] of [
    ["small-444", "rgb"],
    ["small-gray", "gray"],
  ] as const) {
    test(`encodes ${color} pixels as a JPEG that looks like them`, async () => {
      const source = await decodeFixture(name);
      const out = await createJpegEncoder()(source.width, source.height, source.pixels, color);
      expect(out.mimeType).toBe("image/jpeg");
      expect([out.bytes[0], out.bytes[1]]).toEqual([0xff, 0xd8]);
      const delta = difference(source, await reference(out.bytes, false));
      expect(delta.mean).toBeLessThanOrEqual(4);
    });
  }

  const rejecting: BunImageCtor = class {
    jpeg() {
      return { bytes: () => Promise.reject(new Error("no encoder")) };
    }
  };
  const throwing: BunImageCtor = class {
    constructor() {
      throw new Error("no encoder");
    }
    jpeg(): { bytes(): Promise<Uint8Array> } {
      throw new Error("unreachable");
    }
  };
  for (const [label, image] of [
    ["Bun.Image is absent", null],
    ["Bun.Image rejects", rejecting],
    ["Bun.Image throws", throwing],
  ] as const) {
    test(`${label}: a PNG of exactly the pixels`, async () => {
      const source = await decodeFixture("small-444");
      const out = await createJpegEncoder(image)(64, 48, source.pixels, "rgb");
      expect(out.mimeType).toBe("image/png");
      const back = await decodeAnyPng(out.bytes);
      expect([back.width, back.height]).toEqual([64, 48]);
      expect([...back.pixels]).toEqual([...source.pixels]);
    });
  }
});
