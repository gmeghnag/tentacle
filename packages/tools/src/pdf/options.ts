/**
 * The pdf.js `getDocument` options and the worker message shapes, kept apart
 * from `pdf-worker.ts` so a test can inspect them without loading pdf.js
 * (docs/feat/pdf-read.md §Design D2). Every flag here is a SECURITY choice for
 * parsing a hostile file; a test pins each one.
 */

import type { PdfImageLimits, PdfImageSummary, PdfPageImage } from "@tentacle/core";

/** The pdf.js options for text extraction of untrusted bytes. */
export function pdfDocumentOptions(data: Uint8Array) {
  return {
    data,
    // CVE-2024-4367 (GHSA-wgrm-67xf-hhpq): never compile font code to JS.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // No fetch of anything, ever: no worker fetch, and no cMapUrl /
    // standardFontDataUrl (text extraction does not need glyph outlines).
    useWorkerFetch: false,
    // Salvage what parses rather than fail the whole file on one bad object.
    stopAtErrors: false,
    enableXfa: false,
    // Image objects come back as raw pixels (`{kind, data}`), never as an
    // `ImageBitmap` or through a native image decoder: the worker encodes the
    // PNG itself (docs/feat/pdf-images.md D1).
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: 0,
  };
}

/** Pages read when the caller names none and the file is bigger than this. */
export const MAX_PDF_PAGES_WITHOUT_RANGE = 2000;

/** The main thread's request to the worker (sent after its `ready`). */
export interface PdfWorkerRequest {
  bytes: Uint8Array;
  /** A `parsePageRange` spec ("1-5", "7-", "2,4"); absent = from page 1. */
  pages?: string;
  /** Extract each page's images with these limits (D1–D3); absent = text only. */
  images?: PdfImageLimits;
}

export type PdfFailureReason =
  | "encrypted"
  | "corrupt"
  | "too-many-pages"
  | "bad-pages"
  | "timeout"
  | "too-large"
  | "too-much-memory"
  | "aborted"
  | "unavailable";

/**
 * One extracted page: its 1-based number, its cleaned text (with the image
 * markers in place when images were asked for) and those images.
 */
export interface PdfExtractedPage {
  n: number;
  text: string;
  images?: PdfPageImage[];
}

export type PdfExtraction =
  | {
      ok: true;
      numPages: number;
      pages: PdfExtractedPage[];
      truncated: boolean;
      /** What the read did with its images; present only when they were asked for. */
      images?: PdfImageSummary;
    }
  | { ok: false; reason: PdfFailureReason; message: string };

/** The worker's answer: the extraction itself. */
export type PdfWorkerResponse = PdfExtraction;

/** A message from pdf.js, cut to one line of ≤ 200 printable characters. */
export function pdfMessage(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
  const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
}
