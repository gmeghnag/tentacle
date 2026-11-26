/**
 * The reference JPEG decoder for the tests: `Bun.Image` (libjpeg-turbo), which
 * has no raw output, so through a PNG.
 */
import { promisify } from "node:util";
import { inflate as inflateCb } from "node:zlib";
import { type DecodedPng, PNG_CHANNELS, decodePng } from "@tentacle/core";

interface TestImage {
  resize(width: number, height: number): TestImage;
  png(): TestImage;
  jpeg(options?: { quality: number }): TestImage;
  bytes(): Promise<Uint8Array>;
}

/** `Bun.Image` as the tests use it (`@types/bun` here does not declare it). */
export const BunImage = (
  Bun as unknown as {
    Image: new (bytes: Uint8Array, options?: { autoOrient: boolean }) => TestImage;
  }
).Image;

export const fixture = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(
    await Bun.file(`${import.meta.dir}/../../../core/test/fixtures/jpeg/${name}.jpg`).arrayBuffer(),
  );

const inflateAsync = promisify(inflateCb);

export async function decodeAnyPng(png: Uint8Array): Promise<DecodedPng> {
  const result = await decodePng(
    png,
    async (b, max) => new Uint8Array(await inflateAsync(b, { maxOutputLength: max })),
  );
  if ("refused" in result) throw new Error(result.refused);
  return result;
}

/** A JPEG as the reference decoder sees it; `autoOrient` applies its EXIF rotation. */
export async function reference(bytes: Uint8Array, autoOrient: boolean): Promise<DecodedPng> {
  return decodeAnyPng(await new BunImage(bytes, { autoOrient }).png().bytes());
}

/** The per-sample |Δ| between two same-sized pictures, over their colour channels. */
export function difference(a: DecodedPng, b: DecodedPng): { mean: number; max: number } {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`sizes differ: ${a.width}×${a.height} and ${b.width}×${b.height}`);
  }
  const channelsA = PNG_CHANNELS[a.color];
  const channelsB = PNG_CHANNELS[b.color];
  let sum = 0;
  let max = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < pixels; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const x = a.pixels[i * channelsA + (channelsA === 1 ? 0 : c)] as number;
      const y = b.pixels[i * channelsB + (channelsB === 1 ? 0 : c)] as number;
      const delta = Math.abs(x - y);
      sum += delta;
      max = Math.max(max, delta);
    }
  }
  return { mean: sum / (pixels * 3), max };
}
