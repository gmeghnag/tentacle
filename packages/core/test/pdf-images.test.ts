import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import {
  DEFAULT_PDF_IMAGE_LIMITS,
  type PdfDecodedImage,
  type PdfImageOps,
  type PdfImagePaint,
  createImageCollector,
  downscalePixels,
  imageFooter,
  imagePixels,
  scaledSize,
  stripImageMarkers,
  walkImagePaints,
} from "../src/pdf-images.ts";
import { buildPageText, buildPageTextWithImages } from "../src/pdf-text.ts";

const deflate = (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes));

// pdf.js 6.5.438 `OPS` values (the worker passes the real object).
const OPS: PdfImageOps = {
  save: 10,
  restore: 11,
  transform: 12,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintImageXObjectRepeat: 88,
};
const MASK = 83; // paintImageMaskXObject

function rgb(width: number, height: number, fill: number | ((i: number) => number)) {
  const data = new Uint8Array(width * height * 3);
  for (let i = 0; i < data.length; i += 1) data[i] = typeof fill === "number" ? fill : fill(i);
  return { width, height, kind: 2, data } satisfies PdfDecodedImage;
}

const paint = (top: number, left = 100): PdfImagePaint => ({
  op: 0,
  objId: "img",
  left,
  right: left + 50,
  bottom: top - 50,
  top,
});

describe("walkImagePaints (the CTM walk)", () => {
  test("nested save/transform/restore → each paint's box in user space", () => {
    const fn = [
      OPS.save,
      OPS.transform,
      OPS.save,
      OPS.transform,
      OPS.paintImageXObject,
      OPS.restore,
      OPS.transform,
      OPS.paintInlineImageXObject,
      OPS.restore,
      OPS.paintImageXObject,
    ];
    const args = [
      null,
      [2, 0, 0, 2, 10, 20], // scale 2, move (10,20)
      null,
      [50, 0, 0, 30, 5, 5], // 50×30 at (5,5) in the scaled space
      ["img_p0_1", 50, 30],
      null,
      [10, 0, 0, 10, 0, 0],
      [{ width: 1, height: 1 }],
      null,
      ["img_p0_2", 1, 1], // after the outer restore: identity
    ];
    const paints = walkImagePaints(fn, args, OPS);
    expect(paints).toEqual([
      { op: 4, objId: "img_p0_1", left: 20, right: 120, bottom: 30, top: 90 },
      { op: 7, objId: null, left: 10, right: 30, bottom: 20, top: 40 },
      { op: 9, objId: "img_p0_2", left: 0, right: 1, bottom: 0, top: 1 },
    ]);
  });

  test("a form XObject's matrix applies inside it and is undone at its end", () => {
    const fn = [
      OPS.paintFormXObjectBegin,
      OPS.paintImageXObject,
      OPS.paintFormXObjectEnd,
      OPS.paintImageXObject,
    ];
    const args = [
      [
        [1, 0, 0, 1, 100, 200],
        [0, 0, 1, 1],
      ],
      ["a"],
      null,
      ["b"],
    ];
    const paints = walkImagePaints(fn, args, OPS);
    expect(paints.map((p) => [p.objId, p.left, p.bottom])).toEqual([
      ["a", 100, 200],
      ["b", 0, 0],
    ]);
  });

  test("a repeat paints once per position; stencil masks are not images", () => {
    const fn = [OPS.paintImageXObjectRepeat, MASK];
    const args = [["r", 10, 20, [0, 0, 100, 50]], [{ data: new Uint8Array(1) }]];
    const paints = walkImagePaints(fn, args, OPS);
    expect(paints.map((p) => [p.objId, p.left, p.bottom, p.right, p.top])).toEqual([
      ["r", 0, 0, 10, 20],
      ["r", 100, 50, 110, 70],
    ]);
  });

  test("malformed args (hostile operator list) are skipped, never thrown", () => {
    const fn = [OPS.transform, OPS.paintImageXObject, OPS.paintImageXObjectRepeat, OPS.restore];
    const args = [[1, 2, "x"], [42], ["r", 1, 1, null], null];
    expect(walkImagePaints(fn, args, OPS)).toEqual([]);
  });
});

describe("buildPageTextWithImages (placement in the reading order)", () => {
  const item = (str: string, y: number, x = 72, hasEOL = false) => ({
    str,
    transform: [1, 0, 0, 1, x, y],
    width: str.length * 6,
    height: 12,
    hasEOL,
  });

  test("an image between two text blocks → its marker between them", () => {
    const items = [item("Question 1", 700, 72, true), item("Answer below", 400, 72, true)];
    const text = buildPageTextWithImages(items, [
      { marker: "[image p.1 · 50×50]", left: 100, top: 600, bottom: 500 },
    ]);
    expect(text).toBe("Question 1\n[image p.1 · 50×50]\nAnswer below");
  });

  test("geometry, not stream order, picks the place (blocks emitted out of order)", () => {
    // Stream order: block 70 (low), block 69 (high, with the picture beside it), block 71.
    const items = [
      item("Domanda 70", 379),
      item("bulkiness", 358),
      item("Domanda 69", 557),
      item("Quale attività", 535),
      item("Domanda 71", 210),
    ];
    const text = buildPageTextWithImages(items, [
      { marker: "[IMG]", left: 249, top: 547, bottom: 504 },
    ]);
    // The last question before the marker is 69 (not 70, its stream neighbour).
    const before = text.slice(0, Math.max(0, text.indexOf("[IMG]")));
    expect([...before.matchAll(/Domanda (\d+)/g)].at(-1)?.[1]).toBe("69");
  });

  test("a figure beside a heading, its top above the heading's baseline, belongs to that heading", () => {
    // Measured on a real quiz page: the figure (221..289) starts above
    // "Domanda 163" (baseline 284); the line above it ends the previous question.
    const items = [
      item("Domanda 162", 499),
      item("Controlla la tua risposta", 352, 244),
      item("Domanda 163", 284),
      item("La dieta deve essere controllata", 263),
    ];
    const text = buildPageTextWithImages(items, [
      { marker: "[IMG]", left: 233, top: 289, bottom: 221 },
    ]);
    expect(text.indexOf("[IMG]")).toBeGreaterThan(text.indexOf("Domanda 163"));
  });

  test("a marker extends past the rest of its visual line, and sits on a line of its own", () => {
    const items = [item("a.", 500, 44), item("antistaminica", 500, 60), item("b.", 480, 44)];
    const text = buildPageTextWithImages(items, [
      { marker: "[IMG]", left: 300, top: 495, bottom: 490 },
    ]);
    expect(text).toBe("a. antistaminica\n[IMG]\nb.");
  });

  test("an image above every text line opens the page; several are ordered top-down", () => {
    const items = [item("Body", 300, 72, true)];
    const text = buildPageTextWithImages(items, [
      { marker: "[LOW]", left: 0, top: 200, bottom: 100 },
      { marker: "[TOP]", left: 0, top: 790, bottom: 700 },
    ]);
    expect(text).toBe("[TOP]\nBody\n[LOW]");
  });

  test("no images → byte-identical to buildPageText", () => {
    const items = [
      item("Hello", 700),
      item("world", 700, 120, true),
      item("", 0, 0, true),
      item("x", 650),
    ];
    expect(buildPageTextWithImages(items, [])).toBe(buildPageText(items));
  });
});

describe("createImageCollector (filters, repeats, caps)", () => {
  test("a 10×10 or 20×100 image is skipped as tiny, counted, never marked", () => {
    const c = createImageCollector(deflate);
    c.add(1, paint(500), rgb(10, 10, 1));
    c.add(1, paint(400), rgb(20, 100, 2));
    c.add(1, paint(300), rgb(40, 40, 3));
    const { images, summary } = c.finish();
    expect(images.map((i) => i.marker)).toEqual(["[image p.1 · 40×40]"]);
    expect(summary).toMatchObject({ sent: 1, tiny: 2 });
  });

  test("the same picture twice is sent twice (a reused quiz figure is not a logo)", () => {
    const c = createImageCollector(deflate);
    c.add(30, paint(500), rgb(40, 30, 7));
    c.add(31, paint(500), rgb(40, 30, 7));
    const { images, summary } = c.finish();
    expect(images.map((i) => [i.marker, i.png !== undefined])).toEqual([
      ["[image p.30 · 40×30]", true],
      ["[image p.31 · 40×30]", true],
    ]);
    expect(summary.repeats).toBe(0);
  });

  test("three times → sent once, the others `same as p.M` without bytes", () => {
    const c = createImageCollector(deflate);
    for (const page of [2, 3, 4]) c.add(page, paint(780), rgb(100, 30, 9));
    const { images, summary } = c.finish();
    expect(images.map((i) => [i.marker, i.png !== undefined])).toEqual([
      ["[image p.2 · 100×30]", true],
      ["[image p.3 · 100×30 · same as p.2]", false],
      ["[image p.4 · 100×30 · same as p.2]", false],
    ]);
    expect(summary).toMatchObject({ sent: 1, repeats: 2 });
    expect(imageFooter(summary)).toBe("[images: 1 sent, 2 repeats]");
  });

  test(`40 images → ${DEFAULT_PDF_IMAGE_LIMITS.maxSent} sent, the rest marked, the footer says read fewer pages`, () => {
    const c = createImageCollector(deflate);
    for (let i = 0; i < 40; i += 1) c.add(1 + i, paint(500), rgb(32, 32, i));
    const { images, summary } = c.finish();
    expect(images.filter((i) => i.png !== undefined)).toHaveLength(32);
    expect(images[32]?.marker).toBe("[image p.33 · 32×32 · not sent: per-read cap]");
    expect(summary).toMatchObject({ sent: 32, capped: 8 });
    expect(imageFooter(summary)).toBe(
      "[images: 32 sent, 8 over the per-read cap — read fewer pages to get the rest]",
    );
  });

  test("pictures shown twice count toward the cap too: 20 pairs → 32 sent, 8 marked", () => {
    const c = createImageCollector(deflate);
    for (let i = 0; i < 20; i += 1) {
      c.add(1 + i, paint(500), rgb(32, 32, i));
      c.add(1 + i, paint(300), rgb(32, 32, i));
    }
    const { images, summary } = c.finish();
    expect(summary).toMatchObject({ sent: 32, capped: 8, repeats: 0 });
    expect(images.filter((i) => i.png !== undefined)).toHaveLength(32);
  });

  test("the 8 MiB PNG cap stops sending once reached", () => {
    // Incompressible pixels: each PNG is ≈ 3 MB, so the third would pass 8 MiB.
    const noise = () => {
      const data = new Uint8Array(1000 * 1000 * 3);
      for (let at = 0; at < data.length; at += 65_536) {
        crypto.getRandomValues(data.subarray(at, at + 65_536));
      }
      return { width: 1000, height: 1000, kind: 2, data };
    };
    const c = createImageCollector(deflate);
    for (let i = 0; i < 3; i += 1) c.add(1, paint(500), noise());
    const { images, summary } = c.finish();
    const sentBytes = images.reduce((sum, i) => sum + (i.png?.length ?? 0), 0);
    expect(summary).toMatchObject({ sent: 2, capped: 1 });
    expect(sentBytes).toBeLessThanOrEqual(DEFAULT_PDF_IMAGE_LIMITS.maxBytes);
    expect(images[2]?.marker).toContain("not sent: per-read cap");
  });

  test("an undecodable object (null, or a bitmap) keeps its marker and is counted", () => {
    const c = createImageCollector(deflate);
    c.add(5, paint(500), null);
    c.add(5, paint(400), { width: 40, height: 40, kind: 9, data: new Uint8Array(3) });
    const { images, summary } = c.finish();
    expect(images.map((i) => i.marker)).toEqual([
      "[image p.5 · not sent: undecodable]",
      "[image p.5 · 40×40 · not sent: undecodable]",
    ]);
    expect(imageFooter(summary)).toBe("[images: 0 sent, 2 undecodable]");
  });

  test("a large image is box-downscaled to the long-edge cap; the marker names the sent size", () => {
    const c = createImageCollector(deflate);
    c.add(1, paint(500), rgb(3136, 40, 200));
    const { images } = c.finish();
    expect(images[0]).toMatchObject({ width: 1568, height: 20, marker: "[image p.1 · 1568×20]" });
  });

  test("limits are parameters (owner Q4: configurable)", () => {
    const c = createImageCollector(deflate, {
      ...DEFAULT_PDF_IMAGE_LIMITS,
      minSide: 1,
      minArea: 1,
      maxSent: 1,
    });
    c.add(1, paint(500), rgb(2, 2, 1));
    c.add(1, paint(400), rgb(2, 2, 2));
    expect(c.finish().summary).toMatchObject({ sent: 1, capped: 1, tiny: 0 });
  });

  test("everything sent → no footer", () => {
    expect(
      imageFooter({ sent: 3, repeats: 0, tiny: 0, capped: 0, undecodable: 0, unexamined: 0 }),
    ).toBe("");
  });

  test("pages past the time budget are counted in the footer, and in the summary", () => {
    const c = createImageCollector(deflate);
    c.add(1, paint(500), rgb(40, 40, 1));
    c.skipPage();
    c.skipPage();
    const { summary } = c.finish();
    expect(summary).toMatchObject({ sent: 1, unexamined: 2 });
    expect(imageFooter(summary)).toBe(
      "[images: 1 sent, 2 pages not examined for images (time limit) — read fewer pages to get them]",
    );
  });
});

describe("pixels", () => {
  test("1-bit gray unpacks set bits to white, clear to black, rows byte-padded", () => {
    const px = imagePixels({
      width: 10,
      height: 2,
      kind: 1,
      data: new Uint8Array([0b10100000, 0b01000000, 0xff, 0xc0]),
    });
    expect(px?.color).toBe("gray");
    expect([...(px?.pixels ?? [])]).toEqual([
      255, 0, 255, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    ]);
  });

  test("a data length that does not match the shape → null (never garbage)", () => {
    expect(imagePixels({ width: 4, height: 4, kind: 2, data: new Uint8Array(47) })).toBeNull();
    expect(imagePixels({ width: 4, height: 4, kind: 3, data: new Uint8Array(64) })?.color).toBe(
      "rgba",
    );
  });

  test("box downscale averages each source block", () => {
    // 4×2 gray → 2×1: blocks [10,20,30,40] and [50,60,70,80]
    const out = downscalePixels(new Uint8Array([10, 20, 50, 60, 30, 40, 70, 80]), 4, 2, 1, 2, 1);
    expect([...out]).toEqual([25, 65]);
    expect(scaledSize(2480, 3508, 1568)).toEqual({ width: 1109, height: 1568 });
    expect(scaledSize(100, 50, 1568)).toEqual({ width: 100, height: 50 });
  });

  test("stripImageMarkers removes marker lines only", () => {
    expect(stripImageMarkers("a\n[image p.3 · 10×10]\nb [image p.1] inline")).toBe(
      "a\nb [image p.1] inline",
    );
  });
});
