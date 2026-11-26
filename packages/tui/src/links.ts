/**
 * Clickable links (docs/feat/tui-clickable-links.md): which text of a
 * transcript row is an http(s) URL, where it sits on screen, how it is
 * underlined, and what a click on it does.
 *
 * Two rules decide the safety of a click:
 * - only `normalizeUrl`'s output (WHATWG `href`, http/https, bounded) is ever
 *   handed to the opener;
 * - a URL on screen is a link only if the same text is a URL in the item's own
 *   data (`sourceUrls`). A fragment of a wrapped or cut URL is therefore a
 *   missing link, never a wrong one.
 *
 * Pure and framework-free (AGENTS §7).
 */
import { cellWidth, middleCells, truncateCells } from "./cells.ts";
import { expandTabs } from "./input-view.ts";
import type { DisplayItem } from "./state.ts";

export interface UrlMatch {
  /** UTF-16 offsets into the scanned text: `[start, end)`. */
  readonly start: number;
  readonly end: number;
  /** The normalised URL (`normalizeUrl`), not the text covered. */
  readonly url: string;
}

/** The cells of one row that open `url`. */
export interface LinkSpan {
  /** Item-relative row. */
  readonly row: number;
  /** 0-based first cell, and the number of cells. */
  readonly col: number;
  readonly width: number;
  /** The same cells as UTF-16 offsets into the row's plain (SGR-free) text. */
  readonly from: number;
  readonly to: number;
  readonly url: string;
}

const MAX_URL = 2048;
// A URL runs until whitespace, a control char, one of <>"'`{}|\^, a `…`, or the
// `](` between a markdown link's text and its target.
const CANDIDATE_RE = /(?<!\w)https?:\/\/(?:[^\s\p{Cc}<>"'`{}|\\^…\]]|\](?!\())+/giu;
const TRAILING = new Set([".", ",", ":", ";", "!", "?", "*", "_", "~", "'", '"']);

/**
 * How much of `s` is the URL: trailing punctuation goes, and a closing bracket
 * goes while it has no opening partner inside (GFM's rule).
 */
function trimmedLength(s: string): number {
  // `closing − opening` per bracket kind, counted once so the loop stays linear.
  const excess: Record<string, number> = { ")": 0, "]": 0 };
  const opening: Record<string, string> = { "(": ")", "[": "]" };
  for (const c of s) {
    const close = opening[c];
    if (close !== undefined) {
      excess[close] = (excess[close] ?? 0) - 1;
    } else if (c in excess) {
      excess[c] = (excess[c] ?? 0) + 1;
    }
  }
  let end = s.length;
  while (end > 0) {
    const last = s.charAt(end - 1);
    if (TRAILING.has(last)) {
      end -= 1;
    } else if ((excess[last] ?? 0) > 0) {
      excess[last] = (excess[last] ?? 0) - 1;
      end -= 1;
    } else {
      break;
    }
  }
  return end;
}

/** Every http(s) URL written in `plain` (no escape codes). */
export function findUrls(plain: string): UrlMatch[] {
  const out: UrlMatch[] = [];
  for (const m of plain.matchAll(CANDIDATE_RE)) {
    const text = m[0];
    const start = m.index ?? 0;
    // Cut by a subtitle / table / cell truncation: its prefix is another page.
    if (plain.charAt(start + text.length) === "…") {
      continue;
    }
    const end = start + trimmedLength(text);
    const url = normalizeUrl(plain.slice(start, end));
    if (url !== null) {
      out.push({ start, end, url });
    }
  }
  return out;
}

/**
 * The ONE form a URL may be opened in, or null: it parses, it is http or https
 * with a host, it is bounded and holds no space or control byte.
 */
export function normalizeUrl(s: string): string | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control bytes
  if (s.length > MAX_URL || /[\x00-\x20\x7f]/.test(s)) {
    return null;
  }
  if (!URL.canParse(s)) {
    return null;
  }
  const url = new URL(s);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.hostname === "") {
    return null;
  }
  // Percent-encoding can lengthen it past the bound the opener re-checks.
  return url.href.length > MAX_URL ? null : url.href;
}

const SCAN_DEPTH = 4;
const SCAN_BUDGET = 1 << 20;

/** The raw text of every URL in the item's own strings (bounded). */
export function sourceUrls(item: DisplayItem): ReadonlySet<string> {
  const found = new Set<string>();
  let budget = SCAN_BUDGET;
  const visit = (value: unknown, depth: number): void => {
    if (budget <= 0) {
      return;
    }
    if (typeof value === "string") {
      const text = value.length > budget ? value.slice(0, budget) : value;
      const cut = text.length < value.length;
      budget -= text.length;
      for (const { start, end } of findUrls(text)) {
        // A URL touching the cut edge may be a prefix of a longer one.
        if (!cut || end < text.length) {
          found.add(text.slice(start, end));
        }
      }
      return;
    }
    if (typeof value === "object" && value !== null && depth < SCAN_DEPTH) {
      for (const child of Object.values(value)) {
        visit(child, depth + 1);
      }
    }
  };
  visit(item, 0);
  return found;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
const SGR_ALL = /\x1b\[[0-9;]*m/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
const SGR_SPLIT = /\x1b\[([0-9;]*)m/;
const NO_URLS: ReadonlySet<string> = new Set();

/**
 * Whether a line can draw anywhere but in sequence: it holds a control byte or
 * an escape other than SGR (`\r`, `\b`, a cursor move), so what the screen shows
 * on a cell may not be what the line says there. A CR ending the line (CRLF
 * output) redraws nothing.
 */
function redrawsCells(line: string): boolean {
  const rest = expandTabs(line)
    .replace(SGR_ALL, "")
    .replace(/\r+(?=\n|$)/g, "");
  return /(?!\n)\p{Cc}/u.test(rest);
}

/**
 * The URLs that may be linked on an item's rendered `lines`: its `sourceUrls`,
 * or none at all when any line can redraw cells (a cursor move reaches other
 * lines too).
 */
export function linkableUrls(item: DisplayItem, lines: readonly string[]): ReadonlySet<string> {
  return lines.some(redrawsCells) ? NO_URLS : sourceUrls(item);
}

// An escape byte, raw or still JSON-encoded (a call's `args` are decoded later).
// biome-ignore lint/suspicious/noControlCharactersInRegex: finding escape bytes
const OWN_CODE = /\x1b|\\u001b/i;

/**
 * Whether the item's own data holds escape codes, so that a code on its rendered
 * rows may not be one the TUI added.
 */
export function carriesCodes(value: unknown): boolean {
  if (typeof value === "string") {
    return OWN_CODE.test(value);
  }
  return typeof value === "object" && value !== null && Object.values(value).some(carriesCodes);
}

/**
 * Whether text printed after these SGR parameter lists cannot be seen: it is
 * concealed, or its foreground is its background.
 */
function isHidden(codes: readonly string[]): boolean {
  let conceal = false;
  let fg: string | null = null;
  let bg: string | null = null;
  for (const code of codes) {
    const parts = code.split(";").map(Number); // `""` is 0, a reset
    for (let i = 0; i < parts.length; i += 1) {
      const n = parts[i] ?? 0;
      if (n === 38 || n === 48 || n === 58) {
        // An extended colour (`5;n`, `2;r;g;b`); its numbers are not codes.
        const length = parts[i + 1] === 2 ? 4 : 2;
        const colour = parts.slice(i + 1, i + 1 + length).join(";");
        fg = n === 38 ? colour : fg;
        bg = n === 48 ? colour : bg;
        i += length;
      } else if (n === 0) {
        conceal = false;
        fg = null;
        bg = null;
      } else if (n === 8 || n === 28) {
        conceal = n === 8;
      } else if (n === 39) {
        fg = null;
      } else if (n === 49) {
        bg = null;
      } else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) {
        fg = `5;${n >= 90 ? n - 82 : n - 30}`;
      } else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) {
        bg = `5;${n >= 100 ? n - 92 : n - 40}`;
      }
    }
  }
  return conceal || (fg !== null && fg === bg);
}

/** A line's text without its SGR codes, and where in that text each one sat. */
function readStyled(line: string): { plain: string; codes: { at: number; params: string }[] } {
  const [head = "", ...rest] = expandTabs(line).split(SGR_SPLIT);
  let plain = head.normalize();
  const codes: { at: number; params: string }[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    codes.push({ at: plain.length, params: rest[i] ?? "" });
    plain += (rest[i + 1] ?? "").normalize();
  }
  return { plain, codes };
}

/**
 * One logical line's links, mapped onto the rows it wrapped into. `firstRow` is
 * the item-relative index of `rows[0]`; rows below `skipRows` are controls and
 * get no link. The mapping stands on the wrap only INSERTING row breaks: when
 * the rows do not concatenate back to the line, there is no link at all.
 *
 * With `ownCodes` (`carriesCodes`), a URL is a link only if it reads as
 * written: no style code INSIDE it (item text takes its own SGR to the screen,
 * which can conceal a tail and leave a shorter address showing), and not hidden
 * by the codes before it. Otherwise every code is the TUI's own highlighting.
 */
export function linkRows(
  logical: string,
  rows: readonly string[],
  allowed: ReadonlySet<string>,
  firstRow: number,
  skipRows: number,
  ownCodes = true,
): LinkSpan[] {
  if (allowed.size === 0) {
    return [];
  }
  const { plain, codes } = readStyled(logical);
  const asWritten = (m: UrlMatch): boolean =>
    !codes.some((c) => c.at > m.start && c.at < m.end) &&
    !isHidden(codes.filter((c) => c.at <= m.start).map((c) => c.params));
  const matches = findUrls(plain).filter(
    (m) => allowed.has(plain.slice(m.start, m.end)) && (!ownCodes || asWritten(m)),
  );
  if (matches.length === 0) {
    return [];
  }
  const texts = rows.map((row) => row.replace(SGR_ALL, ""));
  if (texts.join("") !== plain) {
    return [];
  }
  const out: LinkSpan[] = [];
  let offset = 0;
  texts.forEach((text, i) => {
    const row = firstRow + i;
    for (const m of matches) {
      const from = Math.max(m.start - offset, 0);
      const to = Math.min(m.end - offset, text.length);
      if (from < to && row >= skipRows) {
        const col = cellWidth(text.slice(0, from));
        const width = cellWidth(text.slice(from, to));
        out.push({ row, col, width, from, to, url: m.url });
      }
    }
    offset += text.length;
  });
  return out;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI SGR codes
const SGR_AT = /\x1b\[([0-9;]*)m/y;
const UNDERLINE = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

/** Whether an SGR parameter list turns the underline off (`""`, `0`, `24`). */
function dropsUnderline(params: string): boolean {
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p === "38" || p === "48" || p === "58") {
      // An extended colour's own numbers (`2;r;g;b`, `5;n`) are not codes.
      i += parts[i + 1] === "2" ? 4 : 2;
    } else if (p === "" || p === "0" || p === "24") {
      return true;
    }
  }
  return false;
}

/** `row` with each segment (plain-text UTF-16 offsets) underlined. */
export function underlineRow(row: string, segs: readonly { from: number; to: number }[]): string {
  if (segs.length === 0) {
    return row;
  }
  let out = "";
  let plain = 0;
  let inside = false;
  for (let i = 0; i < row.length; ) {
    SGR_AT.lastIndex = i;
    const sgr = SGR_AT.exec(row);
    if (sgr) {
      out += sgr[0];
      if (inside && dropsUnderline(sgr[1] ?? "")) {
        out += UNDERLINE;
      }
      i += sgr[0].length;
      continue;
    }
    if (segs.some((s) => s.from === plain)) {
      out += UNDERLINE;
      inside = true;
    }
    out += row.charAt(i);
    i += 1;
    plain += 1;
    if (segs.some((s) => s.to === plain)) {
      out += UNDERLINE_OFF;
      inside = false;
    }
  }
  return out;
}

export type LinkOpenStep =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "open"; readonly url: string };

/** What a click on a link does, given the session's opener. */
export function linkOpenStep(
  url: string,
  opener: { readonly ssh: boolean } | undefined,
): LinkOpenStep {
  if (opener === undefined) {
    return { kind: "notice", text: "No link opener in this session." };
  }
  if (opener.ssh) {
    return {
      kind: "notice",
      text: `Not opened: this TUI runs over SSH, so a browser would open on the remote host — ${url}`,
    };
  }
  return { kind: "open", url };
}

/** The one failure notice of an open. */
export function linkOpenError(url: string, error: unknown): string {
  const failure = (error ?? {}) as { code?: unknown; path?: unknown; message?: unknown };
  const reason =
    failure.code === "ENOENT"
      ? `no ${typeof failure.path === "string" ? failure.path : "opener"} on this machine`
      : typeof failure.message === "string"
        ? failure.message
        : String(error);
  return `Couldn't open ${middleCells(url, 120)}: ${truncateCells(reason, 200)}`;
}
