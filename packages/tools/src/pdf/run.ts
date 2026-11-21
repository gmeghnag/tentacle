/**
 * The extraction itself, run INSIDE the PDF worker (`pdf-worker.ts`), with
 * pdf.js's `getDocument` passed in so it can be driven by a test. Never call it
 * on the daemon's main thread: a hostile file can loop here for as long as it
 * likes, and only `worker.terminate()` stops it (docs/feat/pdf-read.md D2).
 */
import { deflateSync } from "node:zlib";
import {
  MAX_PAGES_PER_READ,
  MAX_PDF_TEXT_CHARS,
  type PdfDecodedImage,
  type PdfImageCollector,
  type PdfImageOps,
  type PdfImageOutcome,
  type PdfImagePaint,
  type PdfPageImage,
  buildPageText,
  buildPageTextWithImages,
  createImageCollector,
  parsePageRange,
  walkImagePaints,
} from "@tentacle/core";
import {
  MAX_PDF_PAGES_WITHOUT_RANGE,
  type PdfExtractedPage,
  type PdfExtraction,
  type PdfWorkerRequest,
  pdfDocumentOptions,
  pdfMessage,
} from "./options.ts";

/** pdf.js's per-page object store (`page.objs` / `page.commonObjs`). */
export interface PdfObjectsLike {
  get(
    objId: string,
    callback: (data: unknown) => void,
    errorCallback?: (e: unknown) => void,
  ): unknown;
}

/** An operator list (`page.getOperatorList()`), as far as the image walk cares. */
export interface PdfOperatorListLike {
  fnArray: ArrayLike<number>;
  argsArray: ArrayLike<unknown>;
}

/** The slice of pdf.js this needs (structural, so a test may fake it). */
export interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  getOperatorList?(): Promise<PdfOperatorListLike>;
  objs?: PdfObjectsLike;
  commonObjs?: PdfObjectsLike;
  cleanup(): unknown;
}

/** How long one image object may take to arrive before it counts as undecodable. */
export const PDF_IMAGE_OBJECT_TIMEOUT_MS = 5_000;

function asDecodedImage(obj: unknown): PdfDecodedImage | null {
  if (typeof obj !== "object" || obj === null) return null;
  const c = obj as Partial<PdfDecodedImage>;
  if (
    typeof c.width !== "number" ||
    typeof c.height !== "number" ||
    typeof c.kind !== "number" ||
    !(c.data instanceof Uint8Array || c.data instanceof Uint8ClampedArray)
  ) {
    // An `ImageBitmap` (never asked for: `isOffscreenCanvasSupported: false`)
    // or a failed decode (`null`): no pixels to send.
    return null;
  }
  return c as PdfDecodedImage;
}

/** The decoded object a paint shows, or `null` (failed, missing, or too slow). */
async function resolveImage(
  page: PdfPageLike,
  list: PdfOperatorListLike,
  paint: PdfImagePaint,
): Promise<PdfDecodedImage | null> {
  if (paint.objId === null) {
    const args = list.argsArray[paint.op];
    return asDecodedImage(Array.isArray(args) ? args[0] : null);
  }
  const objId = paint.objId;
  const store = objId.startsWith("g_") ? page.commonObjs : page.objs;
  if (store === undefined) return null;
  const obj = await new Promise<unknown>((resolve) => {
    const timer = setTimeout(() => resolve(null), PDF_IMAGE_OBJECT_TIMEOUT_MS);
    const done = (data: unknown) => {
      clearTimeout(timer);
      resolve(data);
    };
    try {
      store.get(objId, done, () => done(null));
    } catch {
      done(null);
    }
  });
  return asDecodedImage(obj);
}

/** Feed one page's image paints to the collector; `true` when it had any. */
async function collectPageImages(
  page: PdfPageLike,
  n: number,
  ops: PdfImageOps,
  collector: PdfImageCollector,
): Promise<boolean> {
  if (page.getOperatorList === undefined) return false;
  const list = await page.getOperatorList();
  const paints = walkImagePaints(list.fnArray, list.argsArray, ops);
  for (const paint of paints) {
    const image = await resolveImage(page, list, paint);
    collector.add(n, paint, image, paint.objId ?? undefined);
  }
  return paints.length > 0;
}

/** The page's image list as the answer carries it (PNG only when sent). */
function pageImage(outcome: PdfImageOutcome): PdfPageImage {
  const { marker, png, width, height } = outcome;
  return png === undefined ? { marker, width, height } : { marker, png, width, height };
}
export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  cleanup?(): unknown;
}
export type GetDocument = (options: ReturnType<typeof pdfDocumentOptions>) => {
  promise: Promise<PdfDocLike>;
};

/** Map a pdf.js open failure to a typed reason, by exception name. */
export function pdfOpenFailure(error: unknown): PdfExtraction {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name === "PasswordException") {
    return {
      ok: false,
      reason: "encrypted",
      message: "the PDF is password-protected; tentacle cannot open encrypted PDFs",
    };
  }
  // `InvalidPDFException` and anything else: corrupt, with pdf.js's reason.
  return { ok: false, reason: "corrupt", message: `corrupt PDF: ${pdfMessage(message)}` };
}

/**
 * Open `req.bytes`, read the requested pages, return their cleaned text — and,
 * when `req.images` asks for them and `ops` (pdf.js `OPS`) is given, each
 * page's images with their markers placed in that text (docs/feat/pdf-images.md).
 */
export async function runExtraction(
  getDocument: GetDocument,
  req: PdfWorkerRequest,
  ops?: PdfImageOps,
): Promise<PdfExtraction> {
  let doc: PdfDocLike;
  try {
    doc = await getDocument(pdfDocumentOptions(req.bytes)).promise;
  } catch (error) {
    return pdfOpenFailure(error);
  }
  try {
    const numPages = doc.numPages;
    let wanted: readonly number[];
    if (req.pages !== undefined) {
      const range = parsePageRange(req.pages, numPages);
      if (!range.ok) return { ok: false, reason: "bad-pages", message: range.message };
      wanted = range.pages;
    } else {
      if (numPages > MAX_PDF_PAGES_WITHOUT_RANGE) {
        return {
          ok: false,
          reason: "too-many-pages",
          message: `the PDF has too many pages (${numPages}) to read whole; pass pages (e.g. "1-${MAX_PAGES_PER_READ}")`,
        };
      }
      const last = Math.min(numPages, MAX_PAGES_PER_READ);
      wanted = Array.from({ length: last }, (_, i) => i + 1);
    }
    const pages: PdfExtractedPage[] = [];
    const collector =
      req.images !== undefined && ops !== undefined
        ? createImageCollector((bytes) => {
            const z = deflateSync(bytes);
            return new Uint8Array(z.buffer, z.byteOffset, z.byteLength);
          }, req.images)
        : undefined;
    // Text items of the pages that painted images: their markers can only be
    // placed once the whole read is decided (repeats, caps).
    const itemsOf = new Map<number, readonly unknown[]>();
    let chars = 0;
    let truncated = false;
    for (const n of wanted) {
      if (chars >= MAX_PDF_TEXT_CHARS) {
        truncated = true;
        break;
      }
      let text = "";
      try {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        text = buildPageText(content.items);
        if (collector !== undefined && ops !== undefined) {
          try {
            if (await collectPageImages(page, n, ops, collector)) {
              itemsOf.set(n, content.items);
            }
          } catch {
            // An operator list that fails costs this page its images, never its text.
          }
        }
        page.cleanup();
      } catch {
        // A page that does not parse reads as empty; the verdict names it.
      }
      pages.push({ n, text });
      chars += text.length;
    }
    if (collector === undefined) {
      return { ok: true, numPages, pages, truncated };
    }
    const { images, summary } = collector.finish();
    const byPage = new Map<number, PdfImageOutcome[]>();
    for (const image of images) {
      byPage.set(image.page, [...(byPage.get(image.page) ?? []), image]);
    }
    const withImages = pages.map((page): PdfExtractedPage => {
      const outcomes = byPage.get(page.n) ?? [];
      const items = itemsOf.get(page.n);
      if (outcomes.length === 0 || items === undefined) {
        return { ...page, images: [] };
      }
      const placements = outcomes.map((o) => ({
        marker: o.marker,
        left: o.paint.left,
        top: o.paint.top,
        bottom: o.paint.bottom,
      }));
      return {
        n: page.n,
        text: buildPageTextWithImages(items, placements),
        images: outcomes.map(pageImage),
      };
    });
    return { ok: true, numPages, pages: withImages, truncated, images: summary };
  } finally {
    // 6.5.438 has no `doc.destroy()` (R0); the worker is terminated anyway.
    try {
      doc.cleanup?.();
    } catch {}
  }
}
