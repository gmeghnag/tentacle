/**
 * docs/feat/image-view.md T1 (+ the pure half of D1/D3/D4): the extraction
 * makes both variants and their ids, the marker carries a 12-hex ref, and
 * without `lowEdge`/`sha256` every byte stays as before.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import {
  type PdfDecodedImage,
  type PdfImagePaint,
  createImageCollector,
  imageFooter,
  unkeepImageMarker,
} from "../src/pdf-images.ts";
import { HeuristicTokenCounter } from "../src/token-counter.ts";
import {
  TOOL_IMAGE_LOW_EDGE,
  imageRefPrefix,
  toolImageLabel,
  toolImageLimits,
} from "../src/tool-images.ts";

const deflate = (bytes: Uint8Array) => new Uint8Array(deflateSync(bytes));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function rgb(width: number, height: number, fill: number): PdfDecodedImage {
  return { width, height, kind: 2, data: new Uint8Array(width * height * 3).fill(fill) };
}
const paint = (top: number, left = 100, size = 50): PdfImagePaint => ({
  op: 0,
  objId: "img",
  left,
  right: left + size,
  bottom: top - size,
  top,
});
const limits = toolImageLimits();

describe("createImageCollector with refs (T1)", () => {
  test("a 2000×1000 picture → high 1568×784, low 768×384, two ids, marker `ref <id12>`", () => {
    const c = createImageCollector(deflate, limits, sha256);
    c.add(3, paint(500), rgb(2000, 1000, 9));
    const { images, summary } = c.finish();
    const [img] = images;
    expect(img?.width).toBe(1568);
    expect(img?.height).toBe(784);
    expect(img?.lowWidth).toBe(768);
    expect(img?.lowHeight).toBe(384);
    expect(img?.png).toBeInstanceOf(Uint8Array);
    expect(img?.low).toBeInstanceOf(Uint8Array);
    expect(img?.id).toBe(sha256(img?.png ?? new Uint8Array()));
    expect(img?.lowId).toBe(sha256(img?.low ?? new Uint8Array()));
    expect(img?.id).not.toBe(img?.lowId);
    expect(img?.marker).toBe(`[image p.3 · 1568×784 · ref ${img?.id?.slice(0, 12)}]`);
    expect(summary.refs).toBe(true);
  });

  test("a 600×400 picture → low === high (one blob)", () => {
    const c = createImageCollector(deflate, limits, sha256);
    c.add(1, paint(500), rgb(600, 400, 3));
    const [img] = c.finish().images;
    expect(img?.lowId).toBe(img?.id ?? "missing");
    expect(img?.low).toBeUndefined();
    expect(img?.lowWidth).toBe(600);
  });

  test("without lowEdge/sha256 the marker and the footer are byte-identical to before (golden)", () => {
    const c = createImageCollector(deflate);
    c.add(1, paint(500), rgb(2000, 1000, 9));
    const { images, summary } = c.finish();
    expect(images.map((i) => i.marker)).toEqual(["[image p.1 · 1568×784]"]);
    expect(images[0]?.id).toBeUndefined();
    expect(summary.refs).toBeUndefined();
  });

  test("capped → `not kept: per-read cap`; the footer says `kept for image_view`", () => {
    const c = createImageCollector(deflate, { ...limits, maxSent: 1 }, sha256);
    c.add(1, paint(500), rgb(40, 40, 1));
    c.add(1, paint(400), rgb(40, 40, 2));
    const { images, summary } = c.finish();
    expect(images[1]?.marker).toBe("[image p.1 · 40×40 · not kept: per-read cap]");
    expect(imageFooter(summary)).toBe(
      "[images: 1 kept for image_view, 1 over the per-read cap — read fewer pages to get the rest]",
    );
  });

  test("a paint covering ≥ 50 % of the page box gets the dense-page hint; a small one does not", () => {
    const c = createImageCollector(deflate, limits, sha256);
    c.add(1, paint(700, 0, 500), rgb(40, 40, 1), undefined, 600 * 800);
    c.add(2, paint(700, 0, 100), rgb(40, 40, 2), undefined, 600 * 800);
    const [big, small] = c.finish().images;
    expect(big?.marker).toEndWith(' · full page — detail "high" for small text]');
    expect(small?.marker).not.toContain("full page");
  });

  test("the same pixels give the same ids on a second read (T6 determinism)", () => {
    const ids = [0, 1].map(() => {
      const c = createImageCollector(deflate, limits, sha256);
      c.add(1, paint(500), rgb(1000, 900, 77));
      const [img] = c.finish().images;
      return [img?.id, img?.lowId];
    });
    expect(ids[0]).toEqual(ids[1] ?? []);
  });

  test("the summary counts refused images in the footer", () => {
    expect(
      imageFooter({
        sent: 2,
        repeats: 0,
        tiny: 0,
        capped: 0,
        undecodable: 0,
        unexamined: 0,
        refs: true,
        refused: 1,
      }),
    ).toBe("[images: 2 kept for image_view, 1 not kept (see the markers)]");
  });
});

describe("unkeepImageMarker (D4)", () => {
  test("rewrites every marker of that id, hint included; leaves other ids alone", () => {
    const id = "a1b2c3d4e5f6";
    const text = `x [image p.1 · 9×9 · ref ${id}]\n[image p.2 · 9×9 · ref ${id} · full page — detail "high" for small text]\n[image p.3 · 9×9 · ref ffffffffffff]`;
    expect(unkeepImageMarker(text, `${id}0000`, "image store full")).toBe(
      "x [image p.1 · 9×9 · not kept: image store full]\n[image p.2 · 9×9 · not kept: image store full]\n[image p.3 · 9×9 · ref ffffffffffff]",
    );
  });
});

describe("imageRefPrefix (D1)", () => {
  test("strips sha256:, lowercases, accepts 8–64 hex", () => {
    expect(imageRefPrefix("sha256:A1B2C3D4E5F6")).toEqual({ prefix: "a1b2c3d4e5f6" });
    expect(imageRefPrefix("a1b2c3d4")).toEqual({ prefix: "a1b2c3d4" });
  });
  test("refuses too short, too long, and non-hex", () => {
    for (const bad of ["a1b2c3", "z1b2c3d4e5", "a".repeat(65), ""]) {
      expect("refused" in imageRefPrefix(bad)).toBe(true);
    }
  });
});

describe("labels and limits", () => {
  test("toolImageLabel is `<file> p.<N>`, control characters stripped", () => {
    expect(toolImageLabel("doc\n.pdf", 4)).toBe("doc.pdf p.4");
  });
  test("toolImageLimits sets lowEdge 768", () => {
    expect(limits.lowEdge).toBe(TOOL_IMAGE_LOW_EDGE);
    expect(TOOL_IMAGE_LOW_EDGE).toBe(768);
  });
});

describe("HeuristicTokenCounter imageTokens (T11)", () => {
  test("the override replaces the flat 1600 per ref", () => {
    const ref = { id: "a".repeat(64), mimeType: "image/png", size: 1 };
    const msg = [{ role: "user" as const, content: "", attachments: [ref] }];
    expect(new HeuristicTokenCounter({ imageTokens: 3200 }).countMessages(msg)).toBe(4 + 3200);
    expect(new HeuristicTokenCounter().countMessages(msg)).toBe(4 + 1600);
  });
});
