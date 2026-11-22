/**
 * A file tool's open body as DATA (docs/feat/mobile-file-view.md, part 1): the
 * content of a Read / Edit / MultiEdit / Write, coloured by the file's
 * EXTENSION, with ONE line-number column and its header said once.
 *
 * Pure and React-free (AGENTS §7): `ui/FileBody.tsx` only draws what this says,
 * and `tool-steps.ts` decides whether a row HAS a file body at all. Every rule
 * the owner fixed lives here, so it is tested without a renderer:
 *
 * 1. the language comes from the extension only (`languageOf`, never
 *    auto-detection), and a file over the TUI's cap stays plain;
 * 2. one number column (variant B): the NEW number, or the OLD one for a line
 *    that was removed;
 * 3. the header is one light line — `lines A–B of N · LANG` (a read),
 *    `lines A–B · LANG` (an edit, replacing the raw `@@ … @@`), `LANG · new
 *    file` (a write that created it) — and never the tool's raw result line
 *    (`[path lines 1-12 of 521]`, `edited … with 2 edits (+78 -30)`);
 * 4. the collapsed body is a PREVIEW: the first `FILE_BODY_PREVIEW` lines, then
 *    `… N more lines · tap to see all`; `full` (the screen's existing show-all
 *    seam) draws everything.
 */
import type { ToolDiffDetail, ToolResultSpill } from "@tentacle/core";
import { diffView } from "./diff-view.ts";
import { type Span, highlight, languageOf } from "./highlight.ts";

/** The tools whose body is file content. */
export const FILE_TOOLS: ReadonlySet<string> = new Set([
  "fs_read",
  "fs_write",
  "fs_edit",
  "fs_multi_edit",
]);

/**
 * Lines/bytes the body highlights before it stays plain — the TUI's cap
 * (`READ_HIGHLIGHT_CAP`, `packages/tui/src/read-highlight.ts:22`), so one huge
 * file costs the same on both ends.
 */
export const FILE_HIGHLIGHT_CAP = { lines: 2000, bytes: 200_000 } as const;

/** Lines the collapsed body shows before "tap to see all". */
export const FILE_BODY_PREVIEW = 12;

/** One drawn row: the number gutter, the sign, and the coloured content. */
export interface FileLine {
  /**
   * The ONE number column: the new file's line number, or the old one for a
   * removed line (variant B). `null` when the tool's text carries no number.
   */
  readonly no: number | null;
  /** The `+`/`−` sign column of a diff row; `null` on a read/write line. */
  readonly sign: "+" | "−" | null;
  /** `add`/`del` tint the row (the sign is ALWAYS drawn too: the owner is colour-blind). */
  readonly kind: "add" | "del" | "ctx" | "plain";
  /** Never an empty array: a blank line carries one space (an empty `Text` collapses). */
  readonly spans: readonly Span[];
}

export interface FileBodyView {
  /** The grammar actually used, or null (unknown extension, or over the cap). */
  readonly language: string | null;
  /** The one light line above the content: see the module comment, rule 3. */
  readonly header: string;
  /** The lines to draw — already cut to the preview unless `full`. */
  readonly lines: readonly FileLine[];
  /** Lines held back by the preview (`0` = everything is drawn). */
  readonly hidden: number;
}

function argsOf(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Non-JSON args: no path, no language — the body is plain.
  }
  return {};
}

/** Lower-cased extension of a path (a `:start:end` range suffix ignored), or "". */
export function pathExtension(path: string): string {
  const base = (
    path
      .replace(/:\d+(?::\d+)?$/, "")
      .split(/[\\/]/)
      .pop() ?? ""
  ).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : "";
}

/**
 * The header's human name for a path's language (`HTML`, `JSON`, `TypeScript`),
 * or "" for an extension this build does not know. Display only: it never
 * decides whether the body is coloured.
 */
const DISPLAY: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  json: "JSON",
  bash: "Shell",
  python: "Python",
  rust: "Rust",
  go: "Go",
  java: "Java",
  sql: "SQL",
  yaml: "YAML",
  markdown: "Markdown",
  diff: "Diff",
  css: "CSS",
  xml: "XML",
};

/** A `.html`/`.htm` reads as HTML; the `xml` grammar is only its implementation. */
export function languageLabel(path: string): string {
  const ext = pathExtension(path);
  if (ext === "html" || ext === "htm") {
    return "HTML";
  }
  const grammar = languageOf(ext);
  return grammar === null ? "" : (DISPLAY[grammar] ?? ext.toUpperCase());
}

/** An empty line is one space: an empty `Text` measures 0 high and collapses. */
function blankLine(): Span[] {
  return [{ text: " ", scope: "plain" }];
}

/** `text` as one plain row, never empty (see `blankLine`). */
function plainSpans(text: string): readonly Span[] {
  return text === "" ? blankLine() : [{ text, scope: "plain" }];
}

/** Spans cut at newlines, each half keeping its scope (one entry per line). */
function splitSpans(spans: readonly Span[]): (readonly Span[])[] {
  const lines: Span[][] = [[]];
  for (const span of spans) {
    const parts = span.text.split("\n");
    parts.forEach((part, at) => {
      if (at > 0) {
        lines.push([]);
      }
      if (part !== "") {
        lines[lines.length - 1]?.push({ text: part, scope: span.scope });
      }
    });
  }
  return lines;
}

/**
 * `text` → coloured lines, or plain when the extension is unknown or the file
 * is over the cap. Spans are cut at newlines, each half keeping its scope.
 */
function colourLines(
  text: string,
  path: string,
): { readonly language: string | null; readonly lines: readonly (readonly Span[])[] } {
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  const rows = body === "" ? [] : body.split("\n");
  const grammar = languageOf(pathExtension(path));
  const overCap = rows.length > FILE_HIGHLIGHT_CAP.lines || body.length > FILE_HIGHLIGHT_CAP.bytes;
  const parsed =
    grammar === null || overCap ? null : highlight(body, grammar, FILE_HIGHLIGHT_CAP.bytes);
  const spans = parsed === null || parsed.language === null ? null : parsed.spans;
  if (spans === null) {
    return {
      language: null,
      lines: rows.map((row) => plainSpans(row)),
    };
  }
  return {
    language: grammar,
    lines: splitSpans(spans).map((line) => (line.length === 0 ? blankLine() : line)),
  };
}

/** Apply the preview cut (rule 4) to a body's rows, plus whatever a diff's own bound held back. */
function preview(
  rows: readonly FileLine[],
  full: boolean,
  bound = 0,
): { readonly lines: readonly FileLine[]; readonly hidden: number } {
  if (full || rows.length <= FILE_BODY_PREVIEW) {
    return { lines: rows, hidden: bound };
  }
  return {
    lines: rows.slice(0, FILE_BODY_PREVIEW),
    hidden: rows.length - FILE_BODY_PREVIEW + bound,
  };
}

/**
 * The sub-languages an `xml` file carves out of itself. A line INSIDE one of
 * these is not HTML, so the `xml` grammar cannot colour it on its own: fed the
 * bare fragment it emits plain text for every `<script>`/`<style>` line (the
 * HIGH of Review round 3).
 */
type SubLanguage = "script" | "style";

/** The tag whose body a `SubLanguage` names, plus how to re-enter it. */
const SUB_LANGUAGES: Readonly<Record<SubLanguage, { readonly opener: string }>> = {
  script: { opener: "<script>\n" },
  style: { opener: "<style>\n" },
};

/**
 * A fresh `<script>`/`<style>` scanner: `lastIndex` on a `/g` regex is state, and
 * these scans run in a per-line loop, so each gets its own.
 */
function subTagAt(): RegExp {
  return /<(\/?)(script|style)\b/gi;
}

/** One scan hit as `{ close, language }`, or null when the tag is not one of ours. */
function subTagOf(
  match: RegExpExecArray,
): { readonly close: boolean; readonly language: SubLanguage } | null {
  const tag = (match[2] ?? "").toLowerCase();
  if (tag !== "script" && tag !== "style") {
    return null;
  }
  return { close: match[1] === "/", language: tag };
}

/**
 * The sub-language a HUNK starts inside, or null when it starts at the file's
 * top level. Two facts from the hunk's own drawn lines decide it, and each is
 * the patch's own text — nothing is guessed from outside the hunk:
 *
 * - a line at the hunk's head that OPENS the block (`<script>`): the lines after
 *   it are walked forward by `nextState`, so the hunk's own text is enough;
 * - a closer (`</script>`) with no opener before it in the hunk: the hunk began
 *   inside that block.
 *
 * The honest BOUND: a hunk that starts inside a `<script>` and closes nothing
 * within it carries no evidence either way (a diff is fragments), so it stays
 * plain. A hunk cannot be re-coloured from the rest of the file: `fs_edit`'s
 * patch carries hunks only, never the untouched lines between them.
 */
function hunkStartState(texts: readonly string[]): SubLanguage | null {
  const tags = subTagAt();
  const body = texts.join("\n");
  let pending: SubLanguage | null = null;
  for (let match = tags.exec(body); match !== null; match = tags.exec(body)) {
    const tag = subTagOf(match);
    if (tag === null) {
      continue;
    }
    if (!tag.close) {
      pending = tag.language; // an opener: forward state, not a starting state
      continue;
    }
    // A closer with nothing opened before it: the hunk STARTED inside it.
    return pending === null ? tag.language : null;
  }
  return null;
}

/** The state after `text`, given the state it was drawn in (`<script>` on the line). */
function nextState(text: string, from: SubLanguage | null): SubLanguage | null {
  const tags = subTagAt();
  let state = from;
  for (let match = tags.exec(text); match !== null; match = tags.exec(text)) {
    const tag = subTagOf(match);
    if (tag !== null) {
      state = tag.close ? null : tag.language;
    }
  }
  return state;
}

/**
 * `text` coloured as the body of `state` — by feeding the `xml` grammar the
 * opener plus the line and dropping the opener's own row, so the subLanguage is
 * entered and the line's real tokens come out (`export` is a `keyword`,
 * `--bg` an `attr`). The grammar does not close the block at input's end, so the
 * wrapper needs no closer. `null` when the line cannot be drawn this way (over
 * the cap, or the parse did not stay on one row): the caller keeps it plain.
 */
function subLanguageSpans(text: string, state: SubLanguage): readonly Span[] | null {
  const { opener } = SUB_LANGUAGES[state];
  // The cap is on the LINE as the file wrote it; the wrapper is this module's,
  // so it is added to the allowance rather than counted against the file.
  const parsed = highlight(opener + text, "xml", opener.length + FILE_HIGHLIGHT_CAP.bytes);
  if (parsed.language === null) {
    return null;
  }
  const rows = splitSpans(parsed.spans);
  const own = rows.slice(1);
  if (own.length !== 1) {
    return null; // the fragment did not stay on one row: the caller keeps it plain
  }
  const row = own[0] ?? null;
  // An empty row is no colouring: `null` lets the caller draw a blank row.
  return row === null || row.length === 0 ? null : row;
}

/**
 * What a diff body (Edit / MultiEdit / a Write over an existing file) draws:
 * the hunks' lines flattened, the raw `@@ … @@` headings dropped (rule 3 puts
 * the range in the header), each row's ONE number and its sign.
 */
function diffLines(
  detail: ToolDiffDetail,
  path: string,
): {
  readonly language: string | null;
  readonly rows: readonly FileLine[];
  readonly range: string;
  readonly held: number;
} {
  const view = diffView(detail);
  const rows: FileLine[] = [];
  const language = languageOf(pathExtension(path));
  for (const hunk of view.hunks) {
    // Which `<script>`/`<style>` body the hunk's first line lives in (see
    // `hunkStartState`): carried forward line by line, so a tag that opens or
    // closes inside the hunk moves it exactly as the file does.
    let state = language === "xml" ? hunkStartState(hunk.lines.map((line) => line.text)) : null;
    for (const line of hunk.lines) {
      // A hunk's text is per LINE, so it is coloured per line (a grammar that
      // spans lines — an unclosed template string — cannot see its context;
      // a patch is fragments, and that is the honest bound).
      //
      // Inside a `<script>`/`<style>`, the fragment is not the language: the
      // line is drawn in the sub-language instead (`subLanguageSpans`), and the
      // `xml` parse it would otherwise get is never made.
      const spans =
        (state === null ? null : subLanguageSpans(line.text, state)) ??
        (language === null
          ? null
          : highlight(line.text, language, FILE_HIGHLIGHT_CAP.bytes).spans) ??
        plainSpans(line.text);
      if (language === "xml") {
        state = nextState(line.text, state);
      }
      rows.push({
        no: line.newNo ?? line.oldNo,
        sign: line.kind === "add" ? "+" : line.kind === "del" ? "−" : null,
        // `diffView` never emits a `hunk` line (a heading is not a body line),
        // so a hunk kind here can only be context.
        kind: line.kind === "add" || line.kind === "del" ? line.kind : "ctx",
        spans: spans.length === 0 ? plainSpans(line.text) : spans,
      });
    }
  }
  return { language, rows, range: hunkRange(view), held: view.hidden };
}

/** The `A–B` a diff's hunks cover: the first hunk's start to the last one's end. */
function hunkRange(view: ReturnType<typeof diffView>): string {
  const first = view.hunks[0]?.lines.find((line) => line.newNo !== null)?.newNo;
  const lastHunk = view.hunks.at(-1);
  const last = lastHunk?.lines.at(-1);
  const end = last === undefined ? undefined : (last.newNo ?? last.oldNo);
  if (first === undefined || end === undefined) {
    return "";
  }
  return first === end ? `${first}` : `${first}–${end}`;
}

/**
 * `@@ -0,0 +1,2 @@` — a patch that CREATED the file. The first hunk starts at
 * old line 0 (a unified diff's way of saying "no old side"), which is the only
 * thing that distinguishes a creation from an overwrite whose lines happened to
 * be additions only (both have `removed === 0`).
 */
const CREATED_HUNK = /^@@ -0,0 \+\d+(?:,\d+)? @@/m;

/** `lines A–B of N` — the header `fs_read` writes for a RANGED read (`builtins.ts:137`). */
const RANGE_HEADER = /^\[(?:.+?) lines (\d+)-(\d+) of (\d+)\]\r?\n?/;

/** `lines A–B · LANG` (an edit, or a read's range): the label trails, dropped when unknown. */
function withLanguage(parts: readonly string[], path: string): string {
  const label = languageLabel(path);
  const said = parts.filter((part) => part !== "");
  return label === "" ? said.join(" · ") : [...said, label].join(" · ");
}

/** `LANG · new file` — a label that leads (a created file has no range to name). */
function newFileHeader(path: string): string {
  const label = languageLabel(path);
  return label === "" ? "new file" : `${label} · new file`;
}

/**
 * A file tool's body, or `null` when this row is not one (a non-file tool, a
 * row that is not `ok`, or content that is not there yet). A failed or denied
 * file tool keeps TODAY's plain output: a coloured body must never be the thing
 * that hides a failure.
 */
export function fileBodyView(
  row: {
    readonly name: string;
    readonly args: string;
    readonly status: string;
    readonly output?: string;
    readonly diff?: ToolDiffDetail;
    readonly spill?: ToolResultSpill;
  },
  full: boolean,
): FileBodyView | null {
  if (!FILE_TOOLS.has(row.name) || row.status !== "ok") {
    return null;
  }
  const path = targetPath(argsOf(row.args));
  if (row.name === "fs_read") {
    return readBody(row, path, full);
  }
  if (row.diff === undefined) {
    return null; // no patch on the row: nothing to colour (the plain output stays)
  }
  const diff = diffLines(row.diff, path);
  if (diff.rows.length === 0) {
    return null;
  }
  // A Write that CREATED the file (`@@ -0,0`): there is no old range to name,
  // so `LANG · new file` says it instead. An overwrite is a real diff even when
  // every one of its lines is an addition, so it says its range.
  const created = row.name === "fs_write" && CREATED_HUNK.test(row.diff.patch);
  const header = created ? newFileHeader(path) : withLanguage([`lines ${diff.range}`], path);
  const cut = preview(diff.rows, full, diff.held);
  return { language: diff.language, header, lines: cut.lines, hidden: cut.hidden };
}

/**
 * A `fs_read` body: its `[path lines A-B of N]` header becomes the one light line.
 *
 * A SPILLED read has no body. `result-pipeline.ts:80-104` attaches `spill` only
 * when it REWROTE the content, and then `output` is the model's banner, a head,
 * the `…[N characters omitted]…` marker and a tail — never the file. Numbering
 * those as lines 1–4 would state a line count the file does not have, so it
 * keeps today's plain output (the row stays tappable, with the banner visible).
 */
function readBody(
  row: { readonly output?: string; readonly spill?: ToolResultSpill },
  path: string,
  full: boolean,
): FileBodyView | null {
  if (row.spill !== undefined) {
    return null;
  }
  const output = row.output ?? "";
  const match = RANGE_HEADER.exec(output);
  const body = match === null ? output : output.slice(match[0].length);
  const coloured = colourLines(body, path);
  if (coloured.lines.length === 0) {
    return null;
  }
  const rows: FileLine[] = coloured.lines.map((spans, at) => ({
    // A ranged read starts at its own first line, not at 1.
    no: (match === null ? 1 : Number(match[1])) + at,
    sign: null,
    kind: "plain",
    spans,
  }));
  const range =
    match === null
      ? `${rows.length} ${rows.length === 1 ? "line" : "lines"}`
      : `lines ${match[1]}–${match[2]} of ${match[3]}`;
  const cut = preview(rows, full);
  return {
    language: coloured.language,
    header: withLanguage([range], path),
    lines: cut.lines,
    hidden: cut.hidden,
  };
}

/** The file a call targets, with its `:start:end` range suffix removed. */
function targetPath(args: Record<string, unknown>): string {
  return (typeof args.path === "string" ? args.path : "").replace(/:\d+(?::\d+)?$/, "");
}
