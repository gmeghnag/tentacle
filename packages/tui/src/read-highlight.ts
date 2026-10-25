/**
 * Syntax colours for a `fs_read` result, by the language of the file read.
 *
 * Pure and React-free. The language comes from the file EXTENSION only — never
 * content auto-detection (slow, and wrong on short previews); an unknown
 * extension yields `undefined` and the caller keeps today's plain rendering.
 * Only the text is coloured: the `[path lines A-B of N]` header of a ranged
 * read stays plain grey, and wrapping stays exact because the row wrapper
 * measures visible width (SGR excluded).
 */
import chalk from "chalk";
import { highlight } from "cli-highlight";
import { syntaxRgb, theme } from "./theme.ts";

export type SyntaxMode = keyof typeof syntaxRgb;

/**
 * Above this a read is not highlighted and renders plain, as before: an
 * expanded 20k-line read cost ~160 ms synchronously on the render thread.
 * `bytes` counts UTF-16 code units of the text. The owner may change it.
 */
export const READ_HIGHLIGHT_CAP = { lines: 2000, bytes: 200_000 } as const;

// No html/xml on purpose: highlight.js auto-detects the `<script>`/`<style>`
// sub-language there (an array `subLanguage`), and the spec forbids auto-detection.
const EXT_LANG: Readonly<Record<string, string>> = {
  go: "go",
  py: "python",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  md: "markdown",
  markdown: "markdown",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  rs: "rust",
  json: "json",
  toml: "ini",
  ini: "ini",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  css: "css",
  sql: "sql",
  rb: "ruby",
  php: "php",
  lua: "lua",
  diff: "diff",
  patch: "diff",
};

const BASENAME_LANG: Readonly<Record<string, string>> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** The `path` argument of a tool call's JSON args, if any. */
export function pathOfArgs(args: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(args);
    if (parsed && typeof parsed === "object" && "path" in parsed) {
      const p = (parsed as { path: unknown }).path;
      return typeof p === "string" ? p : undefined;
    }
  } catch {
    // unparseable args → no language
  }
  return undefined;
}

/** The highlight.js language for a path (a `:start:end` range suffix is ignored), or undefined. */
export function languageForPath(path: string): string | undefined {
  const base = (
    path
      .replace(/:\d+(?::\d+)?$/, "")
      .split("/")
      .pop() ?? ""
  ).toLowerCase();
  const byName = BASENAME_LANG[base];
  if (byName) {
    return byName;
  }
  const dot = base.lastIndexOf(".");
  return dot > 0 ? EXT_LANG[base.slice(dot + 1)] : undefined;
}

const RANGE_HEADER = /^\[.+ lines \d+-\d+ of \d+\]$/;

type Styler = (s: string) => string;

const rgb = ([r, g, b]: readonly [number, number, number]): Styler => chalk.rgb(r, g, b);

function highlightTheme(mode: SyntaxMode): Record<string, Styler> {
  const c = syntaxRgb[mode];
  const keyword = rgb(c.keyword);
  const string = rgb(c.string);
  const number = rgb(c.number);
  const comment = rgb(c.comment);
  const title = rgb(c.title);
  const type = rgb(c.type);
  const meta = rgb(c.meta);
  const tag = rgb(c.tag);
  const plain: Styler = (s) => s;
  return {
    keyword,
    built_in: type,
    type,
    class: type,
    literal: number,
    number,
    regexp: string,
    string,
    subst: plain,
    symbol: number,
    function: title,
    title,
    params: plain,
    comment,
    doc: comment,
    meta,
    "meta-keyword": keyword,
    "meta-string": string,
    section: title,
    tag,
    name: tag,
    attr: type,
    attribute: type,
    variable: plain,
    bullet: number,
    code: string,
    quote: comment,
    link: meta,
    addition: string,
    deletion: tag,
    default: plain,
  };
}

const themes = new Map<SyntaxMode, Record<string, Styler>>();

function themeFor(mode: SyntaxMode): Record<string, Styler> {
  let t = themes.get(mode);
  if (!t) {
    t = highlightTheme(mode);
    themes.set(mode, t);
  }
  return t;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const SGR = /\x1b\[[0-9;]*m/g;

/**
 * A read result as displayed, coloured or not: CRLF → LF, then lone CR and NUL
 * dropped (cli-highlight drops them, so both paths normalise at this one point
 * and show the same text and the same row count).
 */
export function cleanReadText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/[\r\0]/g, "");
}

/**
 * Style a read result's lines: the first `limit` code lines (all when
 * omitted) coloured by the file's language, any lines beyond it plain grey —
 * a collapsed preview never pays for the hidden tail. A ranged read's header
 * line is grey. `undefined` = unknown language (or a highlighter failure):
 * the caller renders plain as before.
 */
export function highlightRead(
  text: string,
  path: string,
  mode: SyntaxMode = "dark",
  limit?: number,
): string[] | undefined {
  const language = languageForPath(path);
  if (!language || text.length > READ_HIGHLIGHT_CAP.bytes) {
    return undefined;
  }
  const lines = text.replace(/\n+$/, "").split("\n");
  if (lines.length > READ_HIGHLIGHT_CAP.lines) {
    return undefined;
  }
  const header = lines[0] !== undefined && RANGE_HEADER.test(lines[0]) ? 1 : 0;
  const end = limit === undefined ? lines.length : Math.min(lines.length, header + limit);
  const code = lines.slice(header, end).join("\n");
  let coloured: string[];
  try {
    const out = highlight(code, { language, ignoreIllegals: true, theme: themeFor(mode) });
    // Safety net: the colours must be the only difference from the plain text.
    if (out.replace(SGR, "") !== code) {
      return undefined;
    }
    coloured = out.split("\n");
  } catch {
    return undefined;
  }
  return [
    ...lines.slice(0, header).map((l) => theme.subtle(l)),
    ...coloured,
    ...lines.slice(end).map((l) => theme.subtle(l)),
  ];
}
