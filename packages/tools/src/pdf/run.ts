/**
 * The extraction itself, run INSIDE the PDF worker (`pdf-worker.ts`), with
 * pdf.js's `getDocument` passed in so it can be driven by a test. Never call it
 * on the daemon's main thread: a hostile file can loop here for as long as it
 * likes, and only `worker.terminate()` stops it (docs/feat/pdf-read.md D2).
 */
import {
  MAX_PAGES_PER_READ,
  MAX_PDF_TEXT_CHARS,
  buildPageText,
  parsePageRange,
} from "@tentacle/core";
import {
  MAX_PDF_PAGES_WITHOUT_RANGE,
  type PdfExtractedPage,
  type PdfExtraction,
  type PdfWorkerRequest,
  pdfDocumentOptions,
  pdfMessage,
} from "./options.ts";

/** The slice of pdf.js this needs (structural, so a test may fake it). */
export interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  cleanup(): unknown;
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

/** Open `req.bytes`, read the requested pages, return their cleaned text. */
export async function runExtraction(
  getDocument: GetDocument,
  req: PdfWorkerRequest,
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
        page.cleanup();
      } catch {
        // A page that does not parse reads as empty; the verdict names it.
      }
      pages.push({ n, text });
      chars += text.length;
    }
    return { ok: true, numPages, pages, truncated };
  } finally {
    // 6.5.438 has no `doc.destroy()` (R0); the worker is terminated anyway.
    try {
      doc.cleanup?.();
    } catch {}
  }
}
