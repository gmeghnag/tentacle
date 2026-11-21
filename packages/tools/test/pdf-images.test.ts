/**
 * PDF images through the REAL worker and pdf.js (docs/feat/pdf-images.md §Tests
 * S2): synthetic PDFs built in-test, PNGs decoded back to pixels.
 */
import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { DEFAULT_PDF_IMAGE_LIMITS } from "@tentacle/core";
import { type PdfWorkerLike, createPdfExtractor, isPdfExtraction } from "../src/pdf/extract.ts";
import {
  RED_BLUE_JPEG,
  imageOp,
  inlineImageOp,
  makeImagePdf,
  makePdf,
  textOp,
} from "./pdf-fixture.ts";

const realWorker = () =>
  new Worker(new URL("../src/pdf/pdf-worker.ts", import.meta.url).href, {
    type: "module",
  }) as unknown as PdfWorkerLike;
const extract = createPdfExtractor({ spawn: realWorker });

/** A test-only PNG reader for this encoder's output (8-bit, filter 0). */
function decodePng(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Uint8Array[] = [];
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      colorType = png[at + 17] ?? 0;
    }
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const raw = inflateSync(new Uint8Array(Buffer.concat(idat)));
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    pixels.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { width, height, channels, pixels };
}

const gradient = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);

describe("extractPdf with images (real pdf.js in a worker)", () => {
  test("RGB, Indexed+SMask, inline, DCT and a stencil mask: markers in place, pixels decoded", async () => {
    const rgb = gradient(40 * 30 * 3);
    const indexed = Uint8Array.from({ length: 32 * 32 }, (_, i) => i % 2);
    const alpha = Uint8Array.from({ length: 32 * 32 }, (_, i) => Math.floor(i / 32) * 8);
    const inline = gradient(40 * 40 * 3).map((v) => 255 - v);
    const pdf = makeImagePdf([
      {
        content: [
          textOp(72, 700, "Question 1"),
          imageOp("Im1", 100, 500, 120, 90),
          textOp(72, 400, "Answer A"),
        ].join("\n"),
        images: { Im1: { width: 40, height: 30, colorSpace: "/DeviceRGB", data: rgb } },
      },
      {
        content: [
          textOp(72, 700, "Second"),
          imageOp("Im2", 100, 500, 64, 64),
          imageOp("Mk", 300, 500, 64, 64),
          textOp(72, 300, "After"),
        ].join("\n"),
        images: {
          Im2: {
            width: 32,
            height: 32,
            colorSpace: "[/Indexed /DeviceRGB 1 <FF000000FF00>]",
            data: indexed,
            smask: { width: 32, height: 32, colorSpace: "/DeviceGray", data: alpha },
          },
          Mk: { width: 32, height: 32, imageMask: true, data: new Uint8Array(4 * 32).fill(0xaa) },
        },
      },
      {
        content: [
          textOp(72, 700, "Third"),
          inlineImageOp({ width: 40, height: 40, rgb: inline }, [72, 400, 90, 90]),
        ].join("\n"),
      },
      {
        content: [textOp(72, 700, "Fourth"), imageOp("Jp", 72, 400, 64, 48)].join("\n"),
        images: {
          Jp: {
            width: 48,
            height: 32,
            colorSpace: "/DeviceRGB",
            data: RED_BLUE_JPEG,
            filter: "/DCTDecode",
          },
        },
      },
    ]);
    const r = await extract(pdf, { images: DEFAULT_PDF_IMAGE_LIMITS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [p1, p2, p3, p4] = r.pages;

    expect(p1?.text).toBe("Question 1\n[image p.1 · 40×30]\nAnswer A");
    const png1 = p1?.images?.[0]?.png;
    expect(png1 === undefined ? null : decodePng(png1)).toEqual({
      width: 40,
      height: 30,
      channels: 3,
      pixels: rgb,
    });

    // Indexed → RGB, SMask → alpha kept; the stencil mask is not an image.
    expect(p2?.text).toBe("Second\n[image p.2 · 32×32]\nAfter");
    expect(p2?.images).toHaveLength(1);
    const png2 = p2?.images?.[0]?.png;
    const d2 = png2 === undefined ? null : decodePng(png2);
    expect(d2?.channels).toBe(4);
    const px = (i: number) => [...(d2?.pixels.subarray(i * 4, i * 4 + 4) ?? [])];
    expect(px(0)).toEqual([255, 0, 0, 0]); // row 0: red, alpha 0
    expect(px(32 * 5 + 1)).toEqual([0, 255, 0, 40]); // row 5, odd column: green, alpha 40

    // pdf.js hands an inline image back as RGBA (opaque): compare its RGB.
    expect(p3?.text).toBe("Third\n[image p.3 · 40×40]");
    const png3 = p3?.images?.[0]?.png;
    const d3 = png3 === undefined ? null : decodePng(png3);
    const rgb3 = (d3?.pixels ?? new Uint8Array(0)).filter((_, i) => i % 4 !== 3);
    expect([d3?.channels, [...rgb3]]).toEqual([4, [...inline]]);

    // DCT decoded by pdf.js in JS; lossy, so colours are compared loosely.
    expect(p4?.text).toBe("Fourth\n[image p.4 · 48×32]");
    const png4 = p4?.images?.[0]?.png;
    const d4 = png4 === undefined ? null : decodePng(png4);
    const left = [...(d4?.pixels.subarray(0, 3) ?? [])];
    const right = [...(d4?.pixels.subarray(47 * 3, 48 * 3) ?? [])];
    expect((left[0] ?? 0) > 200 && (left[2] ?? 255) < 60).toBe(true);
    expect((right[2] ?? 0) > 200 && (right[0] ?? 255) < 60).toBe(true);

    expect(r.images).toEqual({ sent: 4, repeats: 0, tiny: 0, capped: 0, undecodable: 0 });
  });

  test("an undecodable JPX stream → `not sent: undecodable`, the text survives", async () => {
    const pdf = makeImagePdf([
      {
        content: [
          textOp(72, 700, "Fifth"),
          imageOp("Jx", 72, 400, 80, 80),
          textOp(72, 300, "End"),
        ].join("\n"),
        images: {
          Jx: { width: 40, height: 40, data: new Uint8Array(64).fill(7), filter: "/JPXDecode" },
        },
      },
    ]);
    const r = await extract(pdf, { images: DEFAULT_PDF_IMAGE_LIMITS });
    expect(r.ok && r.pages[0]?.text).toBe("Fifth\n[image p.1 · not sent: undecodable]\nEnd");
    expect(r.ok && r.images?.undecodable).toBe(1);
  });

  test("a PDF with no images reads byte-identically with and without image extraction", async () => {
    const pdf = makePdf([["Hello PDF world", "Line two"], ["Second page"]]);
    const plain = await extract(pdf);
    const withImages = await extract(pdf, { images: DEFAULT_PDF_IMAGE_LIMITS });
    expect(plain.ok && withImages.ok).toBe(true);
    if (!plain.ok || !withImages.ok) return;
    expect(withImages.pages.map((p) => p.text)).toEqual(plain.pages.map((p) => p.text));
    expect(withImages.pages.every((p) => p.images?.length === 0)).toBe(true);
    expect(plain.images).toBeUndefined();
  });

  test("without the images option no image is looked at (attachments keep today's read)", async () => {
    const pdf = makeImagePdf([
      {
        content: [textOp(72, 700, "Only text"), imageOp("Im1", 72, 400, 80, 80)].join("\n"),
        images: { Im1: { width: 40, height: 40, colorSpace: "/DeviceGray", data: gradient(1600) } },
      },
    ]);
    const r = await extract(pdf);
    expect(r.ok && r.pages).toEqual([{ n: 1, text: "Only text" }]);
  });
});

describe("the worker's reply is validated", () => {
  test("a page whose images are malformed → not an extraction", () => {
    const good = { ok: true, numPages: 1, truncated: false, pages: [{ n: 1, text: "x" }] };
    expect(isPdfExtraction(good)).toBe(true);
    expect(
      isPdfExtraction({ ...good, pages: [{ n: 1, text: "x", images: [{ marker: 1 }] }] }),
    ).toBe(false);
    expect(
      isPdfExtraction({
        ...good,
        pages: [{ n: 1, text: "x", images: [{ marker: "m", width: 1, height: 1, png: "AA" }] }],
      }),
    ).toBe(false);
    expect(isPdfExtraction({ ok: true })).toBe(false);
    expect(isPdfExtraction({ ok: false, reason: "corrupt", message: "m" })).toBe(true);
  });
});
