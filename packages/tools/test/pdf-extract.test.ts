import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PDF_IMAGE_LIMITS,
  MAX_PAGES_PER_READ,
  MAX_PDF_BYTES,
  MAX_PDF_TEXT_CHARS,
} from "@tentacle/core";
import { type PdfWorkerLike, createPdfExtractor, extractPdf } from "../src/pdf/extract.ts";
import { pdfDocumentOptions } from "../src/pdf/options.ts";
import { type GetDocument, runExtraction } from "../src/pdf/run.ts";
import {
  makeEncryptedPdf,
  makeFlateBombPdf,
  makeHeavyPdf,
  makePdf,
  makeToUnicodePdf,
  makeTruncatedPdf,
} from "./pdf-fixture.ts";

/** A worker that only records: the test drives `ready` and answers by hand. */
class FakeWorker implements PdfWorkerLike {
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  onerror: ((event: ErrorEvent) => unknown) | null = null;
  posted: unknown[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}

const hello = () => makePdf([["Hello PDF world"], ["Second page"]]);
const realWorker = () =>
  new Worker(new URL("../src/pdf/pdf-worker.ts", import.meta.url).href, {
    type: "module",
  }) as unknown as PdfWorkerLike;
const hangWorker = () =>
  new Worker(new URL("./fixtures/pdf-hang-worker.ts", import.meta.url).href, {
    type: "module",
  }) as unknown as PdfWorkerLike;

describe("extractPdf (real pdf.js in a worker)", () => {
  test("a two-page PDF → each page's text", async () => {
    const r = await extractPdf(hello());
    expect(r).toEqual({
      ok: true,
      numPages: 2,
      pages: [
        { n: 1, text: "Hello PDF world" },
        { n: 2, text: "Second page" },
      ],
      truncated: false,
    });
  });

  test("text through a /ToUnicode CMap comes out as Unicode", async () => {
    const r = await extractPdf(makeToUnicodePdf());
    expect(r.ok && r.pages[0]?.text).toBe("αé");
  });

  test("a password-protected PDF → encrypted", async () => {
    const r = await extractPdf(makeEncryptedPdf());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("encrypted");
      expect(r.message).toContain("password-protected");
    }
  });

  test("a truncated PDF → corrupt, with pdf.js's reason on one line", async () => {
    const r = await extractPdf(makeTruncatedPdf());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("corrupt");
      expect(r.message).toStartWith("corrupt PDF: ");
      expect(r.message).not.toContain("\n");
    }
  });

  test('pages: "2" reads only page 2', async () => {
    const r = await extractPdf(makePdf([["one"], ["two"], ["three"]]), { pages: "2" });
    expect(r.ok && r.pages).toEqual([{ n: 2, text: "two" }]);
  });

  test("a page range beyond the file → bad-pages naming the page count", async () => {
    const r = await extractPdf(makePdf([["one"], ["two"]]), { pages: "5" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("bad-pages");
      expect(r.message).toContain("2 pages");
    }
  });

  test(`no range on a long PDF reads the first ${MAX_PAGES_PER_READ} pages`, async () => {
    const pages = Array.from({ length: MAX_PAGES_PER_READ + 5 }, (_, i) => [`p${i + 1}`]);
    const r = await extractPdf(makePdf(pages));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.numPages).toBe(MAX_PAGES_PER_READ + 5);
      expect(r.pages.length).toBe(MAX_PAGES_PER_READ);
      expect(r.pages.at(-1)).toEqual({ n: MAX_PAGES_PER_READ, text: `p${MAX_PAGES_PER_READ}` });
    }
  });

  test("over 2000 pages with no range → too-many-pages; with a range → read", async () => {
    const pages = Array.from({ length: 2001 }, () => ["x"]);
    const pdf = makePdf(pages);
    const whole = await extractPdf(pdf);
    expect(!whole.ok && whole.reason).toBe("too-many-pages");
    const ranged = await extractPdf(pdf, { pages: "2001" });
    expect(ranged.ok && ranged.pages).toEqual([{ n: 2001, text: "x" }]);
  }, 30_000);

  test("a content stream of 400 000 text operators parses (no blow-up)", async () => {
    const r = await extractPdf(makeHeavyPdf(400_000));
    expect(r.ok && r.numPages).toBe(1);
  }, 30_000);

  test("the caller's bytes are not detached by the transfer", async () => {
    const bytes = hello();
    await extractPdf(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
  });
});

describe("extractPdf — the kill switch and the slots", () => {
  test("a looping parse is killed at its timeout, and another extraction runs meanwhile", async () => {
    let n = 0;
    const extract = createPdfExtractor({ spawn: () => (n++ === 0 ? hangWorker() : realWorker()) });
    const t0 = performance.now();
    const [hung, other] = await Promise.all([
      extract(hello(), { timeoutMs: 300 }),
      extract(hello(), { timeoutMs: 10_000 }),
    ]);
    expect(!hung.ok && hung.reason).toBe("timeout");
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(other.ok).toBe(true);
  });

  test("abort terminates the worker → aborted", async () => {
    const fake = new FakeWorker();
    const extract = createPdfExtractor({ spawn: () => fake });
    const ac = new AbortController();
    const pending = extract(hello(), { signal: ac.signal });
    fake.emit("ready");
    ac.abort();
    const r = await pending;
    expect(!r.ok && r.reason).toBe("aborted");
    expect(fake.terminated).toBe(true);
  });

  test("an already-aborted signal never spawns", async () => {
    let spawned = 0;
    const extract = createPdfExtractor({
      spawn: () => {
        spawned++;
        return new FakeWorker();
      },
    });
    const ac = new AbortController();
    ac.abort();
    const r = await extract(hello(), { signal: ac.signal });
    expect(!r.ok && r.reason).toBe("aborted");
    expect(spawned).toBe(0);
  });

  test("nothing is posted before the worker says ready (a too-early post is dropped)", async () => {
    const fake = new FakeWorker();
    const extract = createPdfExtractor({ spawn: () => fake });
    const pending = extract(hello(), { pages: "1" });
    expect(fake.posted).toEqual([]);
    fake.emit("ready");
    expect(fake.posted.length).toBe(1);
    expect(fake.posted[0]).toMatchObject({ pages: "1" });
    fake.emit({ ok: true, numPages: 1, pages: [], truncated: false });
    expect((await pending).ok).toBe(true);
    expect(fake.terminated).toBe(true);
  });

  test("a worker message that is not a result → corrupt, never passed through", async () => {
    const fake = new FakeWorker();
    const extract = createPdfExtractor({ spawn: () => fake });
    const pending = extract(hello());
    fake.emit("ready");
    fake.emit({ unexpected: true });
    const r = await pending;
    expect(!r.ok && r.reason).toBe("corrupt");
    expect(fake.terminated).toBe(true);
  });

  test("at most two workers live; a third waits for a slot", async () => {
    const workers: FakeWorker[] = [];
    const extract = createPdfExtractor({
      spawn: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    const jobs = [extract(hello()), extract(hello()), extract(hello())];
    expect(workers.length).toBe(2);
    workers[0]?.emit({ ok: true, numPages: 1, pages: [], truncated: false });
    await jobs[0];
    expect(workers.length).toBe(3);
    expect(workers.filter((w) => !w.terminated).length).toBe(2);
    for (const w of workers.slice(1))
      w.emit({ ok: true, numPages: 1, pages: [], truncated: false });
    await Promise.all(jobs);
  });

  test("a waiter's timeout covers the wait, and frees its queue place", async () => {
    const workers: FakeWorker[] = [];
    const extract = createPdfExtractor({
      maxConcurrent: 1,
      spawn: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    const first = extract(hello());
    const waiter = await extract(hello(), { timeoutMs: 50 });
    expect(!waiter.ok && waiter.reason).toBe("timeout");
    workers[0]?.emit({ ok: true, numPages: 1, pages: [], truncated: false });
    await first;
    expect(workers.length).toBe(1); // the timed-out waiter never spawned
  });

  test("a worker that cannot load → unavailable, and its slot is released", async () => {
    let calls = 0;
    const extract = createPdfExtractor({
      maxConcurrent: 1,
      spawn: () => {
        calls++;
        if (calls === 1) throw new Error("ModuleNotFound /$bunfs/root/pdf-worker.ts");
        const w = new FakeWorker();
        queueMicrotask(() => w.emit({ ok: true, numPages: 1, pages: [], truncated: false }));
        return w;
      },
    });
    const r = await extract(hello());
    expect(!r.ok && r.reason).toBe("unavailable");
    expect(!r.ok && r.message).toContain("unavailable in this build");
    expect((await extract(hello())).ok).toBe(true);
  });

  test("a real worker whose module is missing fails before ready → unavailable", async () => {
    // A missing URL does not throw from `new Worker`: it fails later, through
    // `onerror`, before the worker ever says `ready`.
    const missing = new URL("./fixtures/no-such-pdf-worker.ts", import.meta.url).href;
    const extract = createPdfExtractor({
      spawn: () => new Worker(missing, { type: "module" }) as unknown as PdfWorkerLike,
    });
    const r = await extract(hello(), { timeoutMs: 5_000 });
    expect(!r.ok && r.reason).toBe("unavailable");
    expect(!r.ok && r.message).toContain("unavailable in this build");
  });

  test("over the memory budget every live worker is killed; a waiter then runs", async () => {
    let rss = 1_000;
    let reads = 0;
    const workers: FakeWorker[] = [];
    const extract = createPdfExtractor({
      memoryBudgetBytes: 100,
      memoryPollMs: 5,
      readRss: () => {
        reads++;
        return rss;
      },
      spawn: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
    });
    const jobs = [extract(hello()), extract(hello()), extract(hello())];
    rss = 1_050; // under budget: nobody is killed
    await Bun.sleep(20);
    expect(workers.filter((w) => w.terminated).length).toBe(0);
    rss = 1_101;
    const [a, b] = await Promise.all([jobs[0], jobs[1]]);
    for (const r of [a, b]) {
      expect(!r?.ok && r?.reason).toBe("too-much-memory");
      expect(!r?.ok && r?.message).toContain("memory");
    }
    // The waiter got a slot with a fresh baseline: the RSS the killed workers
    // left behind does not count against it.
    await Bun.sleep(20);
    expect(workers.length).toBe(3);
    expect(workers[2]?.terminated).toBe(false);
    workers[2]?.emit({ ok: true, numPages: 1, pages: [], truncated: false });
    expect((await jobs[2])?.ok).toBe(true);
    // Idle: the watchdog stops polling.
    const after = reads;
    await Bun.sleep(20);
    expect(reads).toBe(after);
  });

  test("a decompression bomb is killed at the memory budget, with process RSS bounded", async () => {
    const MiB = 1024 * 1024;
    const bomb = makeFlateBombPdf(512 * MiB); // a 0.5 MiB file
    Bun.gc(true);
    const budget = 64 * MiB;
    const extract = createPdfExtractor({ spawn: realWorker, memoryBudgetBytes: budget });
    const base = process.memoryUsage.rss();
    let peak = base;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage.rss());
    }, 5);
    const r = await extract(bomb, { timeoutMs: 15_000 });
    clearInterval(sample);
    expect(!r.ok && r.reason).toBe("too-much-memory");
    // Unbounded, this file grows the RSS by ≈ +650 MiB; capped, ≈ +100 MiB.
    expect(peak - base).toBeLessThan(budget + 128 * MiB);
  }, 30_000);

  test("over the byte cap → too-large, without spawning", async () => {
    let spawned = 0;
    const extract = createPdfExtractor({
      spawn: () => {
        spawned++;
        return new FakeWorker();
      },
    });
    const r = await extract(new Uint8Array(MAX_PDF_BYTES + 1));
    expect(!r.ok && r.reason).toBe("too-large");
    expect(spawned).toBe(0);
  });
});

describe("runExtraction (inside the worker, pdf.js faked)", () => {
  const item = (str: string) => ({
    str,
    transform: [1, 0, 0, 1, 0, 0],
    width: 1,
    height: 1,
    hasEOL: false,
  });
  const fakeDoc =
    (texts: string[], opened: { options?: unknown; pages: number[] }): GetDocument =>
    (options) => {
      opened.options = options;
      return {
        promise: Promise.resolve({
          numPages: texts.length,
          getPage: async (n: number) => {
            opened.pages.push(n);
            return {
              getTextContent: async () => ({ items: [item(texts[n - 1] ?? "")] }),
              cleanup: () => {},
            };
          },
        }),
      };
    };

  test(`text past ${MAX_PDF_TEXT_CHARS} chars stops at a page boundary, truncated`, async () => {
    const opened = { pages: [] as number[] };
    const page = "x".repeat(250_000);
    const r = await runExtraction(fakeDoc([page, page, page], opened), {
      bytes: new Uint8Array(1),
    });
    expect(r.ok && r.truncated).toBe(true);
    expect(r.ok && r.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(opened.pages).toEqual([1, 2]); // page 3 is never even parsed
  });

  test("a page that throws reads as empty; the others survive", async () => {
    const getDocument: GetDocument = () => ({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (n: number) => {
          if (n === 1) throw new Error("bad page");
          return { getTextContent: async () => ({ items: [item("ok")] }), cleanup: () => {} };
        },
      }),
    });
    const r = await runExtraction(getDocument, { bytes: new Uint8Array(1) });
    expect(r.ok && r.pages).toEqual([
      { n: 1, text: "" },
      { n: 2, text: "ok" },
    ]);
  });

  test("image work stops at its time budget: later pages keep their text, the footer counts them", async () => {
    const listed: number[] = [];
    const getDocument: GetDocument = () => ({
      promise: Promise.resolve({
        numPages: 4,
        getPage: async (n: number) => ({
          getTextContent: async () => ({ items: [item(`page ${n}`)] }),
          getOperatorList: async () => {
            listed.push(n);
            return { fnArray: [], argsArray: [] };
          },
          cleanup: () => {},
        }),
      }),
    });
    // A clock that moves 400 ms per read: the start reads 0, then the checks
    // before pages 1–4 read 400, 800, 1200, 1600 against a 1000 ms budget.
    let t = -400;
    const now = () => {
      t += 400;
      return t;
    };
    const r = await runExtraction(
      getDocument,
      { bytes: new Uint8Array(1), images: { ...DEFAULT_PDF_IMAGE_LIMITS, maxMs: 1_000 } },
      {
        save: 10,
        restore: 11,
        transform: 12,
        paintFormXObjectBegin: 74,
        paintFormXObjectEnd: 75,
        paintImageXObject: 85,
        paintInlineImageXObject: 86,
        paintImageXObjectRepeat: 88,
      },
      now,
    );
    expect(listed).toEqual([1, 2]); // pages 3 and 4: no operator list, no decode
    expect(r.ok && r.pages.map((p) => p.text)).toEqual(["page 1", "page 2", "page 3", "page 4"]);
    expect(r.ok && r.images?.unexamined).toBe(2);
  });

  test("the hardened options are what pdf.js is actually called with", async () => {
    const opened: { options?: unknown; pages: number[] } = { pages: [] };
    await runExtraction(fakeDoc(["a"], opened), { bytes: new Uint8Array(1) });
    expect(opened.options).toMatchObject({ isEvalSupported: false, useWorkerFetch: false });
  });
});

describe("pdf.js options and the worker prelude (security)", () => {
  test("getDocument gets the hardened options, and nothing that fetches", () => {
    const opts = pdfDocumentOptions(new Uint8Array(1)) as Record<string, unknown>;
    expect(opts).toMatchObject({
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      stopAtErrors: false,
      enableXfa: false,
      // Raw pixels back, never an ImageBitmap or a native decoder (pdf-images D1).
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      verbosity: 0,
    });
    expect("cMapUrl" in opts).toBe(false);
    expect("standardFontDataUrl" in opts).toBe(false);
    expect("url" in opts).toBe(false);
  });

  test("the prelude silences the console and makes fetch refuse", async () => {
    const w = new Worker(new URL("./fixtures/pdf-quiet-probe.ts", import.meta.url).href, {
      type: "module",
    });
    try {
      const report = await new Promise<{ fetch: string; consoleQuiet: boolean }>((resolve) => {
        w.onmessage = (event) => resolve(event.data);
      });
      expect(report.consoleQuiet).toBe(true);
      expect(report.fetch).toStartWith("refused: network access is disabled");
    } finally {
      w.terminate();
    }
  });
});
