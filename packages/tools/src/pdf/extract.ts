/**
 * The main-thread side of PDF reading (docs/feat/pdf-read.md §Design D2): one
 * killable Bun Worker per extraction, created lazily, at most two at a time per
 * process. pdf.js is NEVER loaded on this thread, so a hostile file (a loop in
 * a content stream, a decompression bomb) costs one worker thread until its
 * timeout and never blocks another session (AGENTS §7 "don't serialize").
 */
import { MAX_PDF_BYTES, PDF_PARSE_TIMEOUT_MS } from "@tentacle/core";
import type { PdfExtraction, PdfWorkerRequest } from "./options.ts";

export type { PdfExtraction, PdfFailureReason, PdfExtractedPage } from "./options.ts";

/** The slice of a Bun `Worker` the extractor uses (a test fakes it). */
export interface PdfWorkerLike {
  onmessage: ((event: MessageEvent) => unknown) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  postMessage(message: unknown, transfer: ArrayBuffer[]): void;
  terminate(): void;
}

let workerUrl = new URL("./pdf-worker.ts", import.meta.url).href;

/**
 * Where the worker module lives. From source it is next to this file; a
 * compiled binary embeds it as the `packages/cli/src/pdf-worker.ts` entrypoint,
 * and the CLI points here at it (`cli/src/pdf-worker-url.ts`).
 */
export function setPdfWorkerUrl(url: string): void {
  workerUrl = url;
}

export function pdfWorkerUrl(): string {
  return workerUrl;
}

const spawnBunWorker = (): PdfWorkerLike =>
  new Worker(workerUrl, { type: "module" }) as unknown as PdfWorkerLike;

export interface ExtractPdfOptions {
  /** A page-range spec ("1-5", "7-", "2,4"); absent = from page 1. */
  pages?: string;
  /** Aborts the extraction (the tool's signal): the worker is terminated. */
  signal?: AbortSignal;
  /** Total budget, waiting for a slot included. Default 20 s. */
  timeoutMs?: number;
}

export interface PdfExtractorOptions {
  spawn?: () => PdfWorkerLike;
  maxConcurrent?: number;
  /**
   * How much the process RSS may grow while this extractor's workers run
   * before ALL of them are killed (`too-much-memory`). Default 512 MiB.
   */
  memoryBudgetBytes?: number;
  /**
   * How often the RSS is read while a worker runs. Default 10 ms: a bomb
   * grows the RSS in bursts of ~20 MiB/ms (buffer doubling), so the interval
   * bounds the overshoot past the budget.
   */
  memoryPollMs?: number;
  /** Reads the process RSS (a test fakes it). */
  readRss?: () => number;
}

/** The default `memoryBudgetBytes`. */
export const PDF_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

/**
 * The memory kill switch (docs/feat/pdf-read.md §Design D2). A Bun Worker
 * shares the daemon's process and honours no heap limit (`resourceLimits` is
 * ignored, `smol` is not in its typing), so a decompression bomb would grow
 * the daemon until the OS kills it. Instead the main thread — which a busy
 * worker never blocks — polls the process RSS while any worker lives, and
 * kills every live one when it has grown more than the budget since the
 * watch began. The RSS cannot be split per worker, so all of them go.
 */
function memoryWatchdog(budget: number, pollMs: number, readRss: () => number) {
  const live = new Set<() => void>();
  let baseline = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = () => {
    if (readRss() - baseline <= budget) return;
    // A kill frees a slot, which may start a waiter synchronously: snapshot,
    // and give whatever is live afterwards a fresh baseline (what the killed
    // workers leave in the RSS is not the newcomer's).
    for (const kill of [...live]) kill();
    baseline = readRss();
  };
  return {
    watch(kill: () => void): () => void {
      if (live.size === 0) {
        baseline = readRss();
        timer = setInterval(tick, pollMs);
      }
      live.add(kill);
      return () => {
        live.delete(kill);
        if (live.size === 0 && timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };
    },
  };
}

export type ExtractPdf = (bytes: Uint8Array, options?: ExtractPdfOptions) => Promise<PdfExtraction>;

/** An extractor with its own concurrency cap (the default one is `extractPdf`). */
export function createPdfExtractor(options: PdfExtractorOptions = {}): ExtractPdf {
  const spawn = options.spawn ?? spawnBunWorker;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const budget = options.memoryBudgetBytes ?? PDF_MEMORY_BUDGET_BYTES;
  const watchdog = memoryWatchdog(
    budget,
    options.memoryPollMs ?? 10,
    options.readRss ?? (() => process.memoryUsage.rss()),
  );
  let active = 0;
  const queue: (() => void)[] = [];

  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };

  return (bytes, opts = {}) => {
    const timeoutMs = opts.timeoutMs ?? PDF_PARSE_TIMEOUT_MS;
    if (bytes.byteLength > MAX_PDF_BYTES) {
      const mib = (bytes.byteLength / 1024 / 1024).toFixed(1);
      return Promise.resolve({
        ok: false,
        reason: "too-large",
        message: `the PDF is ${mib} MiB, over the ${MAX_PDF_BYTES / 1024 / 1024} MiB limit`,
      });
    }
    const signal = opts.signal;
    if (signal?.aborted) {
      return Promise.resolve({ ok: false, reason: "aborted", message: "PDF reading was aborted" });
    }
    return new Promise<PdfExtraction>((resolve) => {
      let settled = false;
      let holding = false;
      let ready = false;
      let worker: PdfWorkerLike | undefined;
      let unwatch: (() => void) | undefined;

      const finish = (result: PdfExtraction) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unwatch?.();
        signal?.removeEventListener("abort", onAbort);
        worker?.terminate();
        if (holding) release();
        else {
          const at = queue.indexOf(start);
          if (at >= 0) queue.splice(at, 1);
        }
        resolve(result);
      };
      const onAbort = () =>
        finish({ ok: false, reason: "aborted", message: "PDF reading was aborted" });
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            reason: "timeout",
            message: `the PDF took too long to parse (limit ${Math.round(timeoutMs / 1000)} s)`,
          }),
        timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });

      function start() {
        holding = true;
        try {
          worker = spawn();
        } catch (error) {
          finish(unavailable(error));
          return;
        }
        unwatch = watchdog.watch(() =>
          finish({
            ok: false,
            reason: "too-much-memory",
            message: `the PDF needed more than ${Math.round(budget / 1024 / 1024)} MiB of memory to parse, so it was stopped (a decompression bomb, or a page too large to read)`,
          }),
        );
        worker.onmessage = (event) => {
          if (event.data === "ready") {
            ready = true;
            // A copy, transferred: the caller's buffer stays theirs (it may be
            // a view into a pooled Buffer), and the worker gets it uncopied.
            const own = bytes.slice();
            const request: PdfWorkerRequest = { bytes: own };
            if (opts.pages !== undefined) request.pages = opts.pages;
            worker?.postMessage(request, [own.buffer]);
            return;
          }
          const data = event.data as { ok?: unknown } | null;
          finish(
            typeof data === "object" && data !== null && typeof data.ok === "boolean"
              ? (data as PdfExtraction)
              : {
                  ok: false,
                  reason: "corrupt",
                  message: "the PDF parser sent an unexpected reply",
                },
          );
        };
        worker.onerror = (event) => {
          finish(
            ready
              ? {
                  ok: false,
                  reason: "corrupt",
                  message: `the PDF parser crashed: ${event.message}`,
                }
              : unavailable(event.message),
          );
        };
      }

      if (active < maxConcurrent) {
        active++;
        start();
      } else {
        queue.push(start);
      }
    });
  };
}

function unavailable(error: unknown): PdfExtraction {
  const reason = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    reason: "unavailable",
    message: `PDF reading is unavailable in this build: ${reason}`,
  };
}

/** The process-wide extractor: at most two PDF workers live at a time. */
export const extractPdf: ExtractPdf = createPdfExtractor();
