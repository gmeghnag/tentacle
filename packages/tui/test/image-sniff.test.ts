import { describe, expect, test } from "bun:test";
import { HEIF_BRANDS, IMAGE_HEAD_BYTES, sniffImageType } from "../src/image-sniff.ts";

/** A byte array from a `\xNN`-style spec, so a signature reads as it looks. */
function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** ASCII of `text` as bytes, appended after `head`. */
function withAscii(head: number[], text: string, tail: number[] = []): Uint8Array {
  return bytes(...head, ...[...text].map((c) => c.charCodeAt(0)), ...tail);
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("sniffImageType — the bytes decide", () => {
  test("PNG", () => {
    expect(sniffImageType(withAscii(PNG_SIG, "IHDR"))).toEqual({
      kind: "image",
      mimeType: "image/png",
    });
  });

  test("JPEG (SOI + a marker)", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toEqual({
      kind: "image",
      mimeType: "image/jpeg",
    });
  });

  test("a bare SOI (FF D8, truncated) is not a JPEG", () => {
    expect(sniffImageType(bytes(0xff, 0xd8))).toEqual({ kind: "not-image" });
  });

  test("GIF87a and GIF89a", () => {
    expect(sniffImageType(withAscii([], "GIF87a"))).toEqual({
      kind: "image",
      mimeType: "image/gif",
    });
    expect(sniffImageType(withAscii([], "GIF89a"))).toEqual({
      kind: "image",
      mimeType: "image/gif",
    });
  });

  test("WebP is RIFF + size + WEBP", () => {
    const webp = new Uint8Array(12);
    webp.set(
      [...("RIFF" as string)].map((c) => c.charCodeAt(0)),
      0,
    );
    webp.set([0x24, 0x00, 0x00, 0x00], 4);
    webp.set(
      [...("WEBP" as string)].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(sniffImageType(webp)).toEqual({ kind: "image", mimeType: "image/webp" });
  });

  test("a RIFF container that is not WEBP (WAVE audio) is not an image", () => {
    const wave = new Uint8Array(12);
    wave.set(
      [...("RIFF" as string)].map((c) => c.charCodeAt(0)),
      0,
    );
    wave.set(
      [...("WAVE" as string)].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(sniffImageType(wave)).toEqual({ kind: "not-image" });
  });

  test("every HEIF brand is recognised (and is NOT image/png)", () => {
    for (const brand of HEIF_BRANDS) {
      const heic = new Uint8Array(12);
      heic.set([0x00, 0x00, 0x00, 0x18], 0);
      heic.set(
        [...("ftyp" as string)].map((c) => c.charCodeAt(0)),
        4,
      );
      heic.set(
        [...brand].map((c) => c.charCodeAt(0)),
        8,
      );
      expect(sniffImageType(heic)).toEqual({ kind: "heic", brand });
    }
  });

  test("an unknown ftyp brand is not an image", () => {
    const mp4 = new Uint8Array(12);
    mp4.set(
      [...("ftyp" as string)].map((c) => c.charCodeAt(0)),
      4,
    );
    mp4.set(
      [...("isom" as string)].map((c) => c.charCodeAt(0)),
      8,
    );
    expect(sniffImageType(mp4)).toEqual({ kind: "not-image" });
  });

  test("too few bytes to hold a signature is not an image (never a guess)", () => {
    expect(sniffImageType(new Uint8Array(0))).toEqual({ kind: "not-image" });
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e))).toEqual({ kind: "not-image" });
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toEqual({
      kind: "not-image",
    });
  });

  test("text, PDF and an empty file are not images", () => {
    expect(sniffImageType(withAscii([], "hello world\n"))).toEqual({ kind: "not-image" });
    expect(sniffImageType(withAscii([], "%PDF-1.7"))).toEqual({ kind: "not-image" });
  });

  test("the head window covers the furthest signature (WebP/ftyp at offset 8)", () => {
    expect(IMAGE_HEAD_BYTES).toBeGreaterThanOrEqual(12);
  });
});
