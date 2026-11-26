/**
 * The codecs `image_view` binds on the daemon side for JPEG pictures
 * (docs/feat/image-region-jpeg.md D5): pdf.js DECODES the untrusted bytes
 * (memory-safe JavaScript, already pinned), and `Bun.Image` ENCODES our own
 * pixels, with a PNG when it cannot.
 */
import { deflateSync } from "node:zlib";
import { type ImageFileMimeType, type JpegDecoder, type PngColor, encodePng } from "@tentacle/core";
// A STATIC specifier, so the bundler embeds the module in the compiled binary.
// (The package ships no typings for this module.)
// @ts-expect-error TS7016: no declaration file for pdf.image_decoders.mjs
import * as pdfjs from "pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs";

/** What this module uses of pdf.js's image decoders. */
interface PdfJsImageDecoders {
  readonly JpegImage: new () => {
    readonly width: number;
    readonly height: number;
    readonly numComponents: number;
    parse(data: Uint8Array): void;
    getData(options: { width: number; height: number; forceRGB: boolean }): Uint8ClampedArray;
  };
  setVerbosityLevel(level: number): void;
}

const { JpegImage, setVerbosityLevel } = pdfjs as unknown as PdfJsImageDecoders;

// pdf.js warns on the console about damaged files, and this process's terminal
// is Ink's during a TUI session (AGENTS §7): errors only, before any decode.
setVerbosityLevel(0);

/** A JPEG's pixels in its STORED frame: gray, or RGB. Lenient and synchronous. */
export const decodeJpegPixels: JpegDecoder = (bytes) => {
  const image = new JpegImage();
  image.parse(bytes);
  const { width, height, numComponents: components } = image;
  const data = image.getData({ width, height, forceRGB: components === 3 });
  return {
    width,
    height,
    components,
    pixels: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
  };
};

/** The one piece of `Bun.Image` used here (`@types/bun` here does not declare it). */
export type BunImageCtor = new (
  bytes: Uint8Array,
) => { jpeg(options: { quality: number }): { bytes(): Promise<Uint8Array> } };

const bunImage = (): BunImageCtor | null =>
  (Bun as unknown as { Image?: BunImageCtor }).Image ?? null;

const JPEG_QUALITY = 85;

export type PictureEncoder = (
  width: number,
  height: number,
  pixels: Uint8Array,
  color: PngColor,
) => Promise<{ readonly bytes: Uint8Array; readonly mimeType: ImageFileMimeType }>;

/** A `Buffer` as the plain bytes it is: a view, never a copy (these are the big buffers). */
export const bytesOf = (b: Buffer): Uint8Array =>
  new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

/**
 * Our pixels → a JPEG (`Bun.Image`, off the JS thread), handed over as an
 * uncompressed PNG. No `Bun.Image` (`null`), or one that fails: a PNG.
 */
export function createJpegEncoder(Image: BunImageCtor | null = bunImage()): PictureEncoder {
  return async (width, height, pixels, color) => {
    if (Image !== null) {
      try {
        const raw = encodePng(width, height, pixels, color, (b) =>
          bytesOf(deflateSync(b, { level: 0 })),
        );
        const bytes = await new Image(raw).jpeg({ quality: JPEG_QUALITY }).bytes();
        return { bytes, mimeType: "image/jpeg" };
      } catch {
        // Fall through to our own PNG.
      }
    }
    const png = encodePng(width, height, pixels, color, (b) => bytesOf(deflateSync(b)));
    return { bytes: png, mimeType: "image/png" };
  };
}
