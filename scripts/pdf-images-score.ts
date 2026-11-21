/**
 * The blind acceptance of docs/feat/pdf-images.md (D9). NOT part of `bun test`;
 * it holds no data of its own — the PDF and the ground truth are arguments.
 *
 *   bun scripts/pdf-images-score.ts <pdf> <gt-dir> [--mutate-page-end]
 *
 * 1. Runs the REAL extraction (`runExtraction` + pdf.js, the code the worker
 *    runs) over the whole PDF in 100-page reads, with the default caps and no
 *    layout hint — the extractor knows nothing about the document.
 * 2. Each marker that carries a PNG is paired with the last `Domanda N` that
 *    occurs BEFORE it in the concatenated text (the scorer's only knowledge of
 *    the ground truth's naming).
 * 3. Ground truth: `<gt-dir>/<N>.png` → (N, pixel key). Pixel key = W×H + the
 *    sha256 of the decoded 8-bit RGB (alpha dropped, gray expanded): exact
 *    decoded-pixel equality, honest across encoders.
 * 4. Score = |GT pairs ∩ extracted pairs| / |GT pairs|; every miss and every
 *    extra is printed, never averaged away.
 *
 * `--mutate-page-end` puts every marker at the end of its page instead (the
 * non-vacuity check: the score must drop).
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { DEFAULT_PDF_IMAGE_LIMITS, MAX_PAGES_PER_READ } from "../packages/core/src/index.ts";
import type { PdfImageOps } from "../packages/core/src/index.ts";
import { type GetDocument, runExtraction } from "../packages/tools/src/pdf/run.ts";

const PDFJS = new URL("../packages/tools/node_modules/pdfjs-dist/legacy/build/", import.meta.url);

/** A PNG decoder for the ground truth: 8-bit, colour types 0/2/4/6, no interlace. */
function decodePng(bytes: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let depth = 8;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  while (at < bytes.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      depth = bytes[at + 16] ?? 0;
      colorType = bytes[at + 17] ?? 0;
      interlace = bytes[at + 20] ?? 0;
    }
    if (type === "IDAT") idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  if (depth !== 8 || interlace !== 0 || colorType === 3) {
    throw new Error(
      `unsupported PNG (depth ${depth}, colour ${colorType}, interlace ${interlace})`,
    );
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const raw = inflateSync(new Uint8Array(Buffer.concat(idat)));
  const stride = width * bpp;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? (out[y * stride + x - bpp] ?? 0) : 0;
      const b = y > 0 ? (out[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= bpp && y > 0 ? (out[(y - 1) * stride + x - bpp] ?? 0) : 0;
      let v = raw[y * (stride + 1) + 1 + x] ?? 0;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    if (bpp >= 3) {
      rgb.set(out.subarray(i * bpp, i * bpp + 3), i * 3);
    } else {
      const g = out[i * bpp] ?? 0;
      rgb[i * 3] = g;
      rgb[i * 3 + 1] = g;
      rgb[i * 3 + 2] = g;
    }
  }
  return { width, height, rgb };
}

function pixelKey(png: Uint8Array): string {
  const { width, height, rgb } = decodePng(png);
  return `${width}x${height}:${createHash("sha256").update(rgb).digest("hex").slice(0, 16)}`;
}

/** Drop every marker line and re-append them at the end of their page (the mutation). */
function markersAtPageEnd(text: string): string {
  const lines = text.split("\n");
  const markers = lines.filter((line) => line.startsWith("[image p."));
  return [...lines.filter((line) => !line.startsWith("[image p.")), ...markers].join("\n");
}

async function main(): Promise<void> {
  const [pdfPath, gtDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const mutate = process.argv.includes("--mutate-page-end");
  if (pdfPath === undefined || gtDir === undefined) {
    console.error("usage: bun scripts/pdf-images-score.ts <pdf> <gt-dir> [--mutate-page-end]");
    process.exit(2);
  }
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = await import(
    new URL("pdf.worker.mjs", PDFJS).href
  );
  const pdfjs = (await import(new URL("pdf.mjs", PDFJS).href)) as {
    getDocument: unknown;
    OPS: PdfImageOps;
  };
  const getDocument = pdfjs.getDocument as GetDocument;
  const bytes = new Uint8Array(readFileSync(pdfPath));

  // Ground truth pairs.
  const gt = new Map<string, string>(); // "N|key" → file
  for (const file of readdirSync(gtDir).filter((f) => f.endsWith(".png"))) {
    const n = file.replace(/\.png$/, "");
    gt.set(`${n}|${pixelKey(new Uint8Array(readFileSync(join(gtDir, file))))}`, file);
  }

  // The real extraction, 100 pages per read, as a model pages through it — and,
  // as the footer tells the model, a read that hit the per-read image cap is
  // read again in halves.
  const started = performance.now();
  let text = "";
  const pngsByMarker = new Map<string, Uint8Array[]>(); // per page: marker → PNGs in order
  const totals = {
    sent: 0,
    repeats: 0,
    tiny: 0,
    capped: 0,
    undecodable: 0,
    unexamined: 0,
    reReads: 0,
  };
  const read = async (pages: string) => {
    const r = await runExtraction(
      getDocument,
      { bytes: bytes.slice(), pages, images: DEFAULT_PDF_IMAGE_LIMITS },
      pdfjs.OPS,
    );
    if (!r.ok) throw new Error(`read ${pages}: ${r.message}`);
    return r;
  };
  const numPages = (await read("1")).numPages;
  const queue: [number, number][] = [];
  for (let from = 1; from <= numPages; from += MAX_PAGES_PER_READ) {
    queue.push([from, Math.min(from + MAX_PAGES_PER_READ - 1, numPages)]);
  }
  for (let range = queue.shift(); range !== undefined; range = queue.shift()) {
    const [from, to] = range;
    const r = await read(`${from}-${to}`);
    if ((r.images?.capped ?? 0) + (r.images?.unexamined ?? 0) > 0 && to > from) {
      const mid = Math.floor((from + to) / 2);
      queue.unshift([from, mid], [mid + 1, to]);
      totals.reReads += 1;
      continue;
    }
    for (const key of ["sent", "repeats", "tiny", "capped", "undecodable", "unexamined"] as const) {
      totals[key] += r.images?.[key] ?? 0;
    }
    for (const page of r.pages) {
      for (const image of page.images ?? []) {
        if (image.png === undefined) continue;
        const k = `${page.n}|${image.marker}`;
        pngsByMarker.set(k, [...(pngsByMarker.get(k) ?? []), image.png]);
      }
      text += `\n--- page ${page.n} ---\n${mutate ? markersAtPageEnd(page.text) : page.text}`;
    }
  }
  const ms = Math.round(performance.now() - started);

  // Pair each sent marker with the last question before it.
  const extracted: { q: string; key: string; page: number; marker: string }[] = [];
  let question = "";
  let page = 0;
  for (const line of text.split("\n")) {
    const pageMatch = /^--- page (\d+) ---$/.exec(line);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }
    if (line.startsWith("[image p.")) {
      const queue = pngsByMarker.get(`${page}|${line}`);
      const png = queue?.shift();
      if (png !== undefined)
        extracted.push({ q: question, key: pixelKey(png), page, marker: line });
      continue;
    }
    for (const m of line.matchAll(/Domanda (\d+)/g)) question = m[1] ?? question;
  }
  const found = new Set(extracted.map((e) => `${e.q}|${e.key}`));
  const hits = [...gt.keys()].filter((k) => found.has(k));
  const misses = [...gt.entries()].filter(([k]) => !found.has(k));
  const extras = extracted.filter((e) => !gt.has(`${e.q}|${e.key}`));

  console.log(
    `pages ${numPages} · ${ms} ms · images`,
    totals,
    mutate ? "· MUTATED (page end)" : "",
  );
  console.log(`score ${hits.length}/${gt.size}`);
  for (const [k, file] of misses) {
    const [q, key] = k.split("|");
    const near = extracted.filter((e) => e.key === key).map((e) => `q=${e.q || "-"} p.${e.page}`);
    console.log(
      `MISS ${file} (question ${q}, ${key?.split(":")[0]}) — same pixels found at: ${near.join(", ") || "nowhere"}`,
    );
  }
  for (const e of extras) {
    console.log(`EXTRA p.${e.page} ${e.marker} → question ${e.q || "-"} (${e.key.split(":")[0]})`);
  }
}

await main();
