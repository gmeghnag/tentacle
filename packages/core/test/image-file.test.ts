/**
 * docs/feat/image-files.md T1/T2: `inspectImageFile` accepts what a provider's
 * decoder accepts and refuses everything else with ONE sentence — before the
 * bytes are stored, because a provider 400 on an image would stay in the
 * history until the tool budget ages it out.
 */
import { describe, expect, test } from "bun:test";
import { crc32, imageFileMarker, imageOverCapReason, inspectImageFile } from "../src/index.ts";

const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u8 = (parts: (number | number[])[]) => new Uint8Array(parts.flat());

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface PngOptions {
  readonly depth?: number;
  readonly colorType?: number;
  readonly interlace?: number;
  /** Flip one byte of the IHDR CRC (a corrupt file). */
  readonly badCrc?: boolean;
  /** Cut the file before its IEND chunk (a truncated download). */
  readonly noIend?: boolean;
  /** Write something other than `IHDR` as the first chunk's type. */
  readonly firstChunk?: string;
}

function png(w: number, h: number, options: PngOptions = {}): Uint8Array {
  const ihdr = u8([
    ...be32(w),
    ...be32(h),
    options.depth ?? 8,
    options.colorType ?? 6,
    0,
    0,
    options.interlace ?? 0,
  ]);
  const type = ascii(options.firstChunk ?? "IHDR");
  let crc = crc32(u8([...type, ...ihdr]));
  if (options.badCrc === true) {
    crc = (crc ^ 0xffffffff) >>> 0;
  }
  const head = u8([...SIGNATURE, ...be32(13), ...type, ...ihdr, ...be32(crc)]);
  if (options.noIend === true) {
    return head;
  }
  const iend = u8([0, 0, 0, 0, ...ascii("IEND"), ...be32(crc32(u8(ascii("IEND"))))]);
  return u8([...head, ...iend]);
}

interface JpegOptions {
  /** The frame marker: SOF0 (baseline) by default. */
  readonly sof?: number;
  readonly precision?: number;
  readonly components?: number;
  /** No frame header at all (a truncated stream). */
  readonly noSof?: boolean;
  /** Cut before the end-of-image marker. */
  readonly noEoi?: boolean;
  /** No scan (`FF DA`) after the frame header. */
  readonly noScan?: boolean;
}

function jpeg(w: number, h: number, options: JpegOptions = {}): Uint8Array {
  const components = options.components ?? 3;
  const sof = options.sof ?? 0xc0;
  const parts: number[] = [
    0xff,
    0xd8,
    0xff,
    0xe0,
    ...be16(16),
    ...ascii("JFIF"),
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ];
  if (options.noSof !== true) {
    parts.push(
      0xff,
      sof,
      ...be16(8 + 3 * components),
      options.precision ?? 8,
      ...be16(h),
      ...be16(w),
      components,
      // Each component's spec: id, sampling factors, quantisation table.
      ...Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0]).flat(),
    );
  }
  if (options.noScan !== true) {
    // SOS: one component, then entropy-coded data, then EOI.
    parts.push(0xff, 0xda, ...be16(8), 1, 1, 0, 0, 63, 0);
    parts.push(0x12, 0x34, 0xff, 0x00, 0x56);
  }
  if (options.noEoi !== true) {
    parts.push(0xff, 0xd9);
  }
  return u8(parts);
}

const limits = { maxEdge: 8000 };

describe("inspectImageFile: PNG", () => {
  test("a valid PNG is accepted with its real size and type", () => {
    expect(inspectImageFile(png(1200, 800), limits)).toEqual({
      ok: true,
      mimeType: "image/png",
      format: "PNG",
      width: 1200,
      height: 800,
    });
  });

  test("every legal depth/colour pair is accepted", () => {
    const pairs: [number, number][] = [
      [1, 0],
      [8, 0],
      [16, 0],
      [8, 2],
      [4, 3],
      [8, 4],
      [16, 6],
    ];
    for (const [depth, colorType] of pairs) {
      expect(inspectImageFile(png(2, 2, { depth, colorType }), limits).ok).toBe(true);
    }
  });

  test("an illegal depth/colour pair is refused", () => {
    const result = inspectImageFile(png(2, 2, { depth: 3, colorType: 0 }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("bit depth 3");
  });

  test("a bad IHDR checksum is refused", () => {
    const result = inspectImageFile(png(2, 2, { badCrc: true }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("checksum does not match");
  });

  test("a first chunk that is not IHDR is refused", () => {
    const result = inspectImageFile(png(2, 2, { firstChunk: "IDAT" }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no IHDR header chunk");
  });

  test("a PNG cut before IEND counts as truncated", () => {
    const result = inspectImageFile(png(640, 480, { noIend: true }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("the PNG is truncated or corrupt");
  });

  test("an interlace byte other than 0/1 is refused", () => {
    const result = inspectImageFile(png(2, 2, { interlace: 2 }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("interlace");
  });

  test("a zero dimension is refused", () => {
    const result = inspectImageFile(png(0, 40), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("invalid pixel size");
  });
});

describe("inspectImageFile: JPEG", () => {
  test("a baseline JPEG is accepted", () => {
    expect(inspectImageFile(jpeg(4032, 3024), { maxEdge: 8000 })).toEqual({
      ok: true,
      mimeType: "image/jpeg",
      format: "JPEG",
      width: 4032,
      height: 3024,
    });
  });

  test("a progressive (SOF2) JPEG is accepted", () => {
    expect(inspectImageFile(jpeg(800, 600, { sof: 0xc2 }), limits).ok).toBe(true);
  });

  test("an extended sequential (SOF1) JPEG at 8 bits is accepted", () => {
    expect(inspectImageFile(jpeg(800, 600, { sof: 0xc1 }), limits).ok).toBe(true);
  });

  test("a greyscale JPEG (1 component) is accepted", () => {
    expect(inspectImageFile(jpeg(40, 30, { components: 1 }), limits).ok).toBe(true);
  });

  test("a CMYK JPEG is refused, naming the fix", () => {
    const result = inspectImageFile(jpeg(800, 600, { components: 4 }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("CMYK JPEG — convert it to RGB first");
  });

  test("a 12-bit JPEG is refused", () => {
    const result = inspectImageFile(jpeg(800, 600, { precision: 12 }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("12-bit JPEG");
  });

  test("an arithmetic-coded JPEG is refused", () => {
    const result = inspectImageFile(jpeg(800, 600, { sof: 0xc9 }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("arithmetic-coded JPEG");
  });

  test("a lossless JPEG is refused", () => {
    const result = inspectImageFile(jpeg(800, 600, { sof: 0xc3 }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("lossless or hierarchical JPEG");
  });

  test("a JPEG with no frame header is refused", () => {
    const result = inspectImageFile(jpeg(0, 0, { noSof: true }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no frame header (SOF)");
  });

  test("a JPEG cut before EOI counts as truncated", () => {
    const result = inspectImageFile(jpeg(800, 600, { noEoi: true }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("the JPEG is truncated or corrupt");
  });

  test("a JPEG with no scan after the frame header is refused", () => {
    const result = inspectImageFile(jpeg(800, 600, { noScan: true }), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("the JPEG is truncated or corrupt");
  });
});

describe("inspectImageFile: the side limit (Q1)", () => {
  test("an image exactly at maxEdge is accepted", () => {
    expect(inspectImageFile(png(8000, 10), { maxEdge: 8000 }).ok).toBe(true);
  });

  test("one pixel over maxEdge is refused with the limit named", () => {
    const result = inspectImageFile(png(10, 8001), { maxEdge: 8000 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(
        "10×8001 is over the 8000 px limit for image files (no downscale yet)",
      );
    }
  });

  test("a narrow maxEdge refuses a phone photo (Q1 C on OpenAI-compatible)", () => {
    expect(inspectImageFile(jpeg(4032, 3024), { maxEdge: 1568 }).ok).toBe(false);
  });
});

describe("inspectImageFile: what is not an image file", () => {
  test("text is not an image", () => {
    const result = inspectImageFile(new TextEncoder().encode("hello"), limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("not a PNG or JPEG image");
  });

  test("a GIF is refused, naming its type (owner Q2)", () => {
    const gif = u8([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]);
    const result = inspectImageFile(gif, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("GIF image is not readable as an image yet");
  });

  test("a WebP is refused, naming its type", () => {
    const webp = u8([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 ")]);
    const result = inspectImageFile(webp, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("WEBP image is not readable");
  });
});

describe("imageOverCapReason (T2)", () => {
  test("names the model's cap when that is the binding one", () => {
    expect(imageOverCapReason(4_000_000, 3_750_000)).toBe(
      "3.8 MB is over this model's 3.6 MB limit",
    );
  });

  test("names the wire's own bound otherwise", () => {
    expect(imageOverCapReason(20_000_000, 15 * 1024 * 1024)).toBe("19 MB is over the 15 MB limit");
  });
});

describe("imageFileMarker", () => {
  test("carries the name, size, format, byte size, the 12-hex ref and `high only`", () => {
    const id = "5f9f01ecb3a4c0ffee";
    expect(imageFileMarker("shot.png", 1200, 800, "PNG", 2048, id)).toBe(
      "[image shot.png · 1200×800 · PNG · 2 KB · ref 5f9f01ecb3a4 · high only]",
    );
  });
});
