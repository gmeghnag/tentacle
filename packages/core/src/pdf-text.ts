/**
 * PDF text: the pure half of reading a PDF (docs/feat/pdf-read.md, D1).
 *
 * Everything here is decided without pdf.js: how a page's text items become
 * lines (the owner's horizontal-gap heuristic), what `pages: "1-5"` means, how
 * a read is presented to the model (`--- page N / M ---` markers, a header and
 * a "call fs_read with pages" footer), whether a document has no text layer at
 * all, and the `<file …>` block an attached PDF reaches the model as.
 *
 * Why it is a module of its own: the daemon (fs_read, prompt extraction), the
 * TUI and the phone all need these decisions, and none of them may import a
 * parser or React. Pure, no I/O, no pdf.js — the extractor
 * (`packages/tools/src/pdf/`) produces `PdfTextItem`s, this file turns them into
 * the text the model reads.
 */

import { MAX_DOCUMENT_TEXT_CHARS } from "@tentacle/protocol";
import type { MessageMedia } from "./model.ts";

/** A file over this is refused before any byte is parsed (`fs_read`). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Pages one `fs_read` call returns at most (the footer names the next call). */
export const MAX_PAGES_PER_READ = 100;

/** Characters of extracted text one `fs_read` call returns before cutting. */
export const MAX_PDF_TEXT_CHARS = 400_000;

/**
 * Characters of text an ATTACHED PDF may add to a message (the A/V transcript
 * cap) — the wire's own bound on `document{text}`, so a client's extraction
 * never exceeds what the daemon accepts.
 */
export const MAX_ATTACHED_PDF_CHARS = MAX_DOCUMENT_TEXT_CHARS;

/** One parse's budget; past it the worker is killed (a hostile file costs 20 s). */
export const PDF_PARSE_TIMEOUT_MS = 20_000;

/**
 * How far into a file `%PDF-` may sit: the magic is spec'd at offset 0, but a
 * leading BOM/junk is common in the wild, and nothing reads past this window.
 */
export const PDF_HEAD_BYTES = 1024;

/**
 * Below this many non-space characters per page a document is treated as
 * having no text layer: real body text is far denser, while a scan that carries
 * only a page-number stamp is not (docs/feat/pdf-read.md D1).
 */
export const NO_TEXT_CHARS_PER_PAGE = 16;

/** Below this many pages the density test says nothing (a short document is short). */
export const MIN_DENSITY_PAGES = 3;

/** One pdf.js text item, as far as this file cares (`getTextContent().items[n]`). */
export interface PdfTextItem {
  readonly str: string;
  /** `[a, b, c, d, e, f]` — `e` is x, `f` the baseline y. */
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
}

/** A text item guard for `getTextContent()`'s union (marked-content items have no `str`). */
export function isTextItem(item: unknown): item is PdfTextItem {
  if (typeof item !== "object" || item === null) {
    return false;
  }
  const candidate = item as Partial<PdfTextItem>;
  return (
    typeof candidate.str === "string" &&
    Array.isArray(candidate.transform) &&
    typeof candidate.width === "number" &&
    typeof candidate.height === "number" &&
    typeof candidate.hasEOL === "boolean"
  );
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * The owner's rule: pdf.js splits many PDFs' words into items that carry no
 * space, so a space is inserted where the GEOMETRY shows one — same baseline,
 * and a gap wider than a quarter of the font size. A narrower gap is kerning;
 * an explicit space on either side is not doubled.
 */
function needsSpace(prev: PdfTextItem, curr: PdfTextItem): boolean {
  if (prev.str === "" || curr.str === "") {
    return false;
  }
  const prevLast = prev.str.at(-1) ?? "";
  const currFirst = curr.str.at(0) ?? "";
  if (isSpace(prevLast) || isSpace(currFirst)) {
    return false;
  }
  const fontSize = Math.max(prev.height, curr.height) || 1;
  const prevY = prev.transform[5] ?? 0;
  const currY = curr.transform[5] ?? 0;
  if (Math.abs(prevY - currY) > fontSize * 0.5) {
    return false;
  }
  const prevX = prev.transform[4] ?? 0;
  const currX = curr.transform[4] ?? 0;
  const gap = currX - (prevX + prev.width);
  return gap > fontSize * 0.25;
}

/**
 * One page's text items as text: newline on `hasEOL`, the geometric space where
 * one is missing, then the clean-up that keeps the model and the terminal sane —
 * C0 controls dropped (a NUL in a PDF's text is not text), lines `trimEnd`ed, and
 * a run of blank lines collapsed to one blank line — the FIRST one of the run,
 * because a blank line is where a paragraph break lives.
 */
export function buildPageText(items: readonly unknown[]): string {
  let raw = "";
  let prev: PdfTextItem | null = null;
  for (const item of items) {
    if (!isTextItem(item)) {
      continue;
    }
    // An item with no text neither contributes a space nor BREAKS one: pdf.js
    // emits empty items between words on some producers, and treating one as
    // "the previous text" glued the two real items together. Its EOL still
    // counts (an empty line is a blank line), and it ends the line for spacing.
    if (item.str === "") {
      if (item.hasEOL) {
        raw += "\n";
        prev = null;
      }
      continue;
    }
    if (prev !== null && !prev.hasEOL && needsSpace(prev, item)) {
      raw += " ";
    }
    raw += item.str;
    if (item.hasEOL) {
      raw += "\n";
    }
    prev = item;
  }
  return cleanText(raw);
}

/** Drop C0 controls (tab and newline excepted), `trimEnd` lines, collapse blank runs. */
function cleanText(raw: string): string {
  // A code-point test rather than a regex: the rule is a byte range, and a
  // character class full of literal controls is both unreadable and a lint trip.
  let stripped = "";
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    const isControl = code < 0x20 && code !== 0x09 && code !== 0x0a;
    if (!isControl && code !== 0x7f) {
      stripped += char;
    }
  }
  const lines = stripped.split("\n").map((line) => line.trimEnd());
  const kept: string[] = [];
  let blanks = 0;
  for (const line of lines) {
    if (line === "") {
      blanks += 1;
      // A run of blank lines is ONE blank line — and it is the first of the run
      // that survives, because that blank line IS the paragraph break (keeping
      // only the third one deleted a one- or two-blank gap, gluing paragraphs
      // together). The rest of the run is noise: pdf.js emits an EOL per empty
      // item, so a gap measured in inches arrives as many blank lines, and a
      // page of them is not a page of paragraphs.
      if (blanks === 1) {
        kept.push("");
      }
      continue;
    }
    blanks = 0;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/** Why a `pages` spec was refused — the model needs the rule it broke. */
export type PageRangeErrorReason = "malformed" | "out-of-range" | "reversed" | "too-many";

/** What `parsePageRange` answers: the pages, or the reason and the sentence why. */
export type PageRangeResult =
  | { readonly ok: true; readonly pages: readonly number[] }
  | { readonly ok: false; readonly reason: PageRangeErrorReason; readonly message: string };

function refused(reason: PageRangeErrorReason, message: string): PageRangeResult {
  return { ok: false, reason, message };
}

/**
 * `"1-5"`, `"3"`, `"7-"`, `"2,4,9-11"` → the pages to read, sorted and unique.
 * Every refusal names the rule: a range the model got wrong is a fixable call,
 * not a silent empty read.
 */
export function parsePageRange(spec: string, numPages: number): PageRangeResult {
  const parts = spec.split(",").map((part) => part.trim());
  if (parts.some((part) => part === "")) {
    return refused("malformed", `"${spec}" is not a page range: use e.g. "1-5", "3" or "2,7-9"`);
  }
  const pages = new Set<number>();
  for (const part of parts) {
    const match = /^(\d+)(?:-(\d*))?$/.exec(part);
    if (match === null) {
      return refused(
        "malformed",
        `"${part}" is not a page range: use e.g. "1-5", "3", "7-" or "2,7-9"`,
      );
    }
    const start = Number(match[1]);
    const openEnd = match[2] === "" && part.endsWith("-");
    const end = openEnd ? numPages : Number(match[2] ?? match[1]);
    if (start < 1 || end < 1) {
      return refused("out-of-range", `pages start at 1, so "${part}" cannot be read`);
    }
    if (start > numPages) {
      return refused(
        "out-of-range",
        `this PDF has ${numPages} pages, so "${part}" is out of range`,
      );
    }
    if (start > end) {
      return refused("reversed", `"${part}" runs backwards: write "${end}-${start}" instead`);
    }
    if (start > numPages || end > numPages) {
      return refused(
        "out-of-range",
        `this PDF has ${numPages} pages, so "${part}" is out of range`,
      );
    }
    // The span is computed, never walked, and refused BEFORE the fill: `numPages`
    // is the PDF's own `/Count` (hostile input), so `"1-"` on a file claiming
    // 30 million pages would otherwise build a 30-million-entry Set — minutes of
    // blocked daemon for a call that is over the limit anyway (§7 "don't
    // serialize"). A span over the cap cannot be within it, whatever else the
    // spec names.
    const span = end - start + 1;
    if (span > MAX_PAGES_PER_READ) {
      return refused(
        "too-many",
        `${span} pages is over the ${MAX_PAGES_PER_READ}-page limit per read: ask for fewer`,
      );
    }
    for (let page = start; page <= end; page += 1) {
      pages.add(page);
    }
    if (pages.size > MAX_PAGES_PER_READ) {
      return refused(
        "too-many",
        `${pages.size} pages is over the ${MAX_PAGES_PER_READ}-page limit per read: ask for fewer`,
      );
    }
  }
  const sorted = [...pages].sort((a, b) => a - b);
  return { ok: true, pages: sorted };
}

/** `[1,2,3,5,9,10]` → `"1-3, 5, 9-10"` — how a page selection is shown back. */
function compressRanges(pages: readonly number[]): string {
  const sorted = [...pages].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index] ?? 0;
    let end = start;
    while (sorted[index + 1] === end + 1) {
      index += 1;
      end += 1;
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`);
    index += 1;
  }
  return parts.join(", ");
}

/** One page of extracted text, numbered as the document numbers it. */
export interface PdfPageText {
  readonly n: number;
  readonly text: string;
}

export interface FormatPdfTextInput {
  /** The pages that were actually read, in document order. */
  readonly pages: readonly PdfPageText[];
  /** The document's page count (`doc.numPages`). */
  readonly numPages: number;
  readonly name: string;
  /** Cut the returned text at a page boundary past this many characters. */
  readonly maxChars?: number;
  /**
   * Footers name the next `fs_read` call (default). `false` for an attached
   * document: the model has no path to call with, so a footer only says what
   * was left out.
   */
  readonly readHint?: boolean;
}

function pluralPages(count: number): string {
  return count === 1 ? "1 page" : `${count} pages`;
}

/**
 * A read as the model sees it: what was read (header), each page with a
 * `--- page N / M ---` marker, and — when pages were left out — a footer that
 * names the exact next call, so paging through a long PDF is one step, not a
 * guess.
 */
export function formatPdfText(input: FormatPdfTextInput): string {
  const maxChars = input.maxChars ?? MAX_PDF_TEXT_CHARS;
  const kept: PdfPageText[] = [];
  let used = 0;
  for (const page of input.pages) {
    if (kept.length > 0 && used >= maxChars) {
      break;
    }
    kept.push(page);
    used += pageMarker(page.n, input.numPages).length + page.text.length + 1;
  }
  const readNumbers = new Set(kept.map((page) => page.n));
  const read = kept.map((page) => page.n);
  const header =
    read.length === 0
      ? `[pdf ${input.name}: ${pluralPages(input.numPages)}, no pages read]`
      : `[pdf ${input.name}: ${pluralPages(input.numPages)}, pages ${compressRanges(read)} shown]`;
  const body = kept.map((page) => `${pageMarker(page.n, input.numPages)}\n${page.text}`);
  const footer = missingFooters(readNumbers, input.numPages, input.readHint ?? true);
  return [header, ...body, ...footer].join("\n");
}

function pageMarker(page: number, numPages: number): string {
  return `--- page ${page} / ${numPages} ---`;
}

/** One footer line per gap, each naming the next `pages` value to ask for. */
function missingFooters(read: ReadonlySet<number>, numPages: number, readHint: boolean): string[] {
  // Arithmetic, never a walk over the document. The old shape stepped a counter
  // from 1 to `numPages` — the PDF's own `/Count`, i.e. hostile input — so one
  // hostile count turned a header/footer into seconds of blocked daemon (§7
  // "don't serialize"), and there are at most `read.size + 1` gaps, whatever
  // the document claims.
  const lines: string[] = [];
  const readPages = [...read].filter((page) => page >= 1 && page <= numPages).sort((a, b) => a - b);
  let cursor = 1;
  for (const page of readPages) {
    if (page > cursor) {
      lines.push(gapFooter(cursor, page - 1, readHint));
    }
    cursor = Math.max(cursor, page + 1);
  }
  if (cursor <= numPages) {
    lines.push(gapFooter(cursor, numPages, readHint));
  }
  return lines;
}

/** The footer for one unread run `start..end`, suggesting at most one read's worth. */
function gapFooter(start: number, end: number, readHint: boolean): string {
  const span = start === end ? `${start}` : `${start}-${end}`;
  if (!readHint) {
    return `[pages ${span} not included]`;
  }
  const suggestEnd = Math.min(end, start + MAX_PAGES_PER_READ - 1);
  const suggest = start === suggestEnd ? `${start}` : `${start}-${suggestEnd}`;
  return `[pages ${span} not read — call fs_read with pages: "${suggest}"]`;
}

/** What a document's text amounts to — the difference between "read it" and "it is a scan". */
export type PdfVerdict =
  | { readonly kind: "text"; readonly message: "" }
  | {
      readonly kind: "no-text";
      readonly message: string;
      readonly emptyPages: readonly number[];
    }
  | {
      readonly kind: "partial";
      readonly message: string;
      readonly emptyPages: readonly number[];
    };

export interface PdfVerdictInput {
  readonly name: string;
  readonly numPages: number;
  readonly pages: readonly PdfPageText[];
}

function nonSpaceChars(text: string): number {
  return text.replace(/\s/g, "").length;
}

/**
 * Scanned PDFs are the common failure, and silence would look like an empty
 * document: a document with no text layer says so (OCR is not supported), and a
 * partial one names the pages that came back empty.
 */
export function pdfVerdict(input: PdfVerdictInput): PdfVerdict {
  const emptyPages = input.pages.filter((page) => nonSpaceChars(page.text) === 0).map((p) => p.n);
  const readable = input.pages.length;
  const scanned = `${input.name}: ${pluralPages(input.numPages)}, no extractable text — it looks scanned (pages are images); OCR is not supported`;
  if (readable > 0 && emptyPages.length === readable) {
    return { kind: "no-text", message: scanned, emptyPages };
  }
  const chars = input.pages.reduce((sum, page) => sum + nonSpaceChars(page.text), 0);
  // A scan with a page-number stamp still yields "text", but not a text layer.
  // The density test needs a few pages to mean anything: over one or two pages a
  // legitimately short document (a slide with a title, a two-page memo) is
  // indistinguishable from a stamp, and calling a readable PDF "scanned" would
  // hide the content it DOES have — the worse of the two mistakes.
  if (readable >= MIN_DENSITY_PAGES && chars / readable < NO_TEXT_CHARS_PER_PAGE) {
    return { kind: "no-text", message: scanned, emptyPages };
  }
  if (emptyPages.length > 0) {
    return {
      kind: "partial",
      message: `${input.name}: pages ${compressRanges(emptyPages)} have no text (images)`,
      emptyPages,
    };
  }
  return { kind: "text", message: "" };
}

/** A file block's kind — `pdf` today; `audio`/`video` are the same shape later. */
export type FileBlockKind = "pdf";

export interface FileBlockInput {
  readonly name: string;
  readonly kind: FileBlockKind;
  readonly pages: number;
  readonly text: string;
}

/** The attribute escaper: a name is data, and never ends the tag it sits in. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function unescapeAttribute(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * A PDF's text as the block the model reads (docs/eval/attachments-audio-video.md
 * §Review, Q2): delimited, so it is visibly DATA. `</file` inside the text is
 * neutralised, because a PDF's own text can otherwise close the block early and
 * everything after it reads as an instruction.
 */
export function fileBlock(input: FileBlockInput): string {
  const body = input.text.replace(/<\/file/gi, "<\\/file");
  return `<file name="${escapeAttribute(input.name)}" kind="${input.kind}" pages="${input.pages}">\n${body}\n</file>`;
}

/** A block found in a message's text, as a renderer needs it. */
export interface ParsedFileBlock {
  readonly name: string;
  readonly kind: string;
  readonly pages: number;
  readonly text: string;
}

export interface SplitFileBlocksResult {
  /** The prose, with every block removed. */
  readonly text: string;
  readonly blocks: readonly ParsedFileBlock[];
}

const FILE_BLOCK_RE = /<file\s+([^>]*)>([\s\S]*?)<\/file>/g;
const ATTR_RE = /([a-z]+)="([^"]*)"/g;

/**
 * Prose and file blocks apart, for the renderers (D5): the transcript shows the
 * text the user typed plus a chip, never the block itself. The inverse of
 * `fileBlock` — `<\/file` comes back as `</file`.
 */
export function splitFileBlocks(content: string): SplitFileBlocksResult {
  const blocks: ParsedFileBlock[] = [];
  let rest = content;
  for (const match of content.matchAll(FILE_BLOCK_RE)) {
    const attrs: Record<string, string> = {};
    for (const attr of (match[1] ?? "").matchAll(ATTR_RE)) {
      attrs[attr[1] ?? ""] = unescapeAttribute(attr[2] ?? "");
    }
    const pages = Number(attrs.pages ?? "0");
    blocks.push({
      name: attrs.name ?? "",
      kind: attrs.kind ?? "",
      pages: Number.isFinite(pages) ? pages : 0,
      text: (match[2] ?? "")
        .replace(/^\n/, "")
        .replace(/\n$/, "")
        .replace(/<\\\/file/g, "</file"),
    });
    rest = rest.replace(match[0], "");
  }
  return { text: rest.trim(), blocks };
}

/** Cut `text` to `max` characters, the cut said in a last line that fits too. */
function capText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const note = `\n[text cut at ${max} characters]`;
  return text.slice(0, Math.max(0, max - note.length)) + note;
}

/**
 * The text an attached document may carry: C0 (tab and newline excepted), DEL
 * and C1 removed. A client's `document{text}` is untrusted and ends up in
 * terminals (TUI, transcript) and in the model's input.
 */
export function sanitizeAttachedText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control =
      (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
    if (!control) {
      out += char;
    }
  }
  return out;
}

export interface AttachedPdfTextInput {
  readonly name: string;
  readonly numPages: number;
  readonly pages: readonly PdfPageText[];
}

export type AttachedPdfTextResult =
  | { readonly ok: true; readonly text: string; readonly pages: number }
  | { readonly ok: false; readonly message: string };

/**
 * An attached PDF's extracted pages as the text of its `<file>` block
 * (docs/feat/pdf-read.md D4): page markers, footers that name what was left out
 * (never an `fs_read` call — the model has no path), a partial verdict last,
 * and never over `MAX_ATTACHED_PDF_CHARS`. A scan is refused with its verdict.
 */
export function attachedPdfText(input: AttachedPdfTextInput): AttachedPdfTextResult {
  const verdict = pdfVerdict(input);
  if (verdict.kind === "no-text") {
    return { ok: false, message: verdict.message };
  }
  const suffix = verdict.kind === "partial" ? `\n${verdict.message}` : "";
  const budget = MAX_ATTACHED_PDF_CHARS - suffix.length;
  const body = formatPdfText({ ...input, maxChars: budget, readHint: false });
  return { ok: true, text: capText(body, budget) + suffix, pages: input.numPages };
}

export interface AttachedDocumentInput {
  readonly name: string;
  readonly pages: number;
  readonly text: string;
}

/**
 * The `<file>` block and the chip entry for one attached document, ALWAYS
 * rebuilt where the message is made (the daemon): the text is re-sanitised and
 * re-capped, and `fileBlock` neutralises `</file` — a client's own block is
 * never trusted.
 */
export function attachedDocument(input: AttachedDocumentInput): {
  readonly block: string;
  readonly media: MessageMedia;
} {
  const text = capText(sanitizeAttachedText(input.text), MAX_ATTACHED_PDF_CHARS);
  return {
    block: fileBlock({ name: input.name, kind: "pdf", pages: input.pages, text }),
    media: { kind: "pdf", name: input.name, pages: input.pages, chars: text.length },
  };
}

/** Printable ASCII: a byte a text line is made of (a PDF's body is mostly not). */
function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 && byte < 0x7f;
}

/**
 * Is this head a PDF? The bytes decide, never the extension — but `%PDF-`
 * merely APPEARING in the head is not enough (fix round 1: prose *about* PDFs,
 * source and docs were sniffed as PDFs and then failed as `corrupt`).
 *
 * The discriminator is what FOLLOWS the version, because that is what separates
 * the false positives from every real header: a real header is `%PDF-<n>.<n>`
 * and then the end of the line, or padding and a comment marker `%` followed by
 * a non-text byte (the binary comment producers append, `%âãÏÓ`). Prose
 * continues the sentence — `` `%PDF-1.7`. ``, `%PDF-1.7 is the magic number` —
 * and `%PDF-x.y` is not a version at all.
 *
 * A printable PREFIX is allowed (fix round 2): an HTTP response body
 * (`HTTP/1.1 200 OK\r\n\r\n%PDF-1.4…`), a stray banner line and an
 * incremental save's junk all open in pdf.js, and refusing them handed the
 * model the PDF's raw objects as "text" — the silent wrong state this feature
 * exists to prevent. The cost is asymmetric and is paid downstream: prose that
 * a loose prefix lets through parses as `corrupt`, and `fs_read` then falls back
 * to the text path on bytes that decode as text (D3).
 */
export function isPdf(head: Uint8Array): boolean {
  const window = head.subarray(0, PDF_HEAD_BYTES);
  let ascii = "";
  for (const byte of window) {
    ascii += String.fromCharCode(byte);
  }
  const at = ascii.indexOf("%PDF-");
  if (at < 0) {
    return false;
  }
  const rest = ascii.slice(at + "%PDF-".length);
  const version = /^\d+\.\d+/.exec(rest);
  if (version === null) {
    return false;
  }
  // Padding (spaces, tabs) is not text: skip it, then the line must end, hold a
  // comment (`%` starts one, per the PDF spec, and the binary comment producers
  // append is exactly that), or a non-text byte must follow.
  let i = at + "%PDF-".length + version[0].length;
  while (i < window.length && ((window[i] as number) === 0x20 || (window[i] as number) === 0x09)) {
    i += 1;
  }
  if (i >= window.length) {
    return true; // a header shorter than the head window
  }
  const next = window[i] as number;
  if (next === 0x0a || next === 0x0d) {
    return true; // a clean header line
  }
  if (next === 0x25) {
    return true; // `%PDF-1.4 %<comment>`: `%` runs to the end of the line
  }
  return !isPrintableAscii(next);
}

/**
 * Could a failed extraction be a text file that merely looked like a PDF? True
 * for valid UTF-8 with no control bytes beyond tab/newline/CR/form feed — the
 * cheap discriminator `fs_read` uses to fall back to the text path instead of
 * reporting `corrupt PDF` for prose (fix round 1).
 */
export function looksLikeTextBytes(bytes: Uint8Array): boolean {
  let text: string;
  try {
    // `stream: true` holds back an incomplete trailing sequence instead of
    // failing: the caller may pass a 1 KiB head that cuts a character in half.
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: true });
  } catch {
    return false;
  }
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    // Control bytes other than tab, LF, CR and form feed: a PDF's binary parts
    // and a text file's own bytes are told apart by this alone in practice.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0c && code !== 0x0d) {
      return false;
    }
  }
  return true;
}
