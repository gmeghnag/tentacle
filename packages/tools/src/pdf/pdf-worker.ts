/**
 * The PDF worker module: parses ONE PDF and exits (docs/feat/pdf-read.md D2).
 * Embedded in the binary through `packages/cli/src/pdf-worker.ts` (a build
 * entrypoint next to `worker.ts`), spawned by `extract.ts`.
 *
 * Protocol: post `"ready"` once `onmessage` is installed — a message sent
 * before that is silently DROPPED while pdf.js is still importing (R0) — then
 * take one `PdfWorkerRequest` and answer one `PdfWorkerResponse`.
 */
import "./quiet.ts";
// A STATIC specifier, so the bundler embeds pdf.js's worker module: pdf.js
// under Bun otherwise imports `./pdf.worker.mjs` relative to itself, which does
// not exist in `$bunfs`. (The package ships no typings for this module.)
// @ts-expect-error TS7016: no declaration file for pdf.worker.mjs
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import type { PdfWorkerRequest, PdfWorkerResponse } from "./options.ts";
import { type GetDocument, runExtraction } from "./run.ts";

declare const self: Worker;

(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker;
const { getDocument, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");

self.onmessage = async (event: MessageEvent<PdfWorkerRequest>) => {
  const answer: PdfWorkerResponse = await runExtraction(
    getDocument as unknown as GetDocument,
    event.data,
    OPS,
  );
  postMessage(answer, transferList(answer));
};

/**
 * The sent PNGs' buffers, each once: they move to the main thread uncopied (a
 * picture painted twice shares one buffer, and a buffer listed twice throws).
 */
function transferList(answer: PdfWorkerResponse): ArrayBuffer[] {
  if (!answer.ok) return [];
  const buffers = new Set<ArrayBuffer>();
  for (const page of answer.pages) {
    for (const image of page.images ?? []) {
      if (image.png !== undefined && image.png.buffer instanceof ArrayBuffer) {
        buffers.add(image.png.buffer);
      }
    }
  }
  return [...buffers];
}
postMessage("ready");
