/**
 * The pure lint of a Mermaid source: what the model wrote, made drawable
 * (docs/feat/model-diagrams.md D3).
 *
 * Two jobs, both React-free and I/O-free:
 *  1. **Normalise** — strip a Markdown fence, a config front-matter and
 *     `%%{init}%%` directives, drop `style`/`classDef`/`linkStyle`/`class`/
 *     `:::cls`/`click` (hard-coded colours break dark mode; a click has no
 *     effect in a sandbox), so the model self-corrects by being forgiven, not
 *     by a retry. Every drop is a `note` the model reads back.
 *  2. **Refuse** what this app will never draw: no type line, an unknown or
 *     misspelt type, a numbers chart (that is `chart`), a source over its caps.
 *
 * It does NOT decide whether the diagram parses — mermaid does (D4), and
 * `explain.ts` rewrites its error for the model. One behaviour, one place:
 * the tool lints daemon-side and every client lints again before drawing, so a
 * pod's forged `rawInput` never reaches a renderer.
 *
 * `lineMap` keeps every later error pointing at the MODEL's lines: canonical
 * line `i + 1` came from raw line `lineMap[i]`.
 */
import {
  type DiagramType,
  aliasType,
  allowedList,
  describeUnknownType,
  isRefusedNumbersType,
  isUnsupportedType,
} from "./types.ts";

/** The types a diagram may be (v1, Owner Q4): re-exported for the tool and the clients. */
export type { DiagramType };

/**
 * The caps, each naming its advice in its error so the model splits rather than
 * resending the same too-big diagram.
 */
export const DIAGRAM_CAPS = {
  /** Bytes of the source. */
  bytes: 20 * 1024,
  /** Lines. */
  lines: 400,
  /** Errors reported at once (each with its fix). */
  errors: 8,
} as const;

/** A source that can be drawn. */
export interface DiagramSource {
  readonly ok: true;
  /** The source after normalisation: what every client draws. */
  readonly canonical: string;
  readonly type: DiagramType;
  /** What was dropped, one short sentence each — the model reads these back. */
  readonly notes: readonly string[];
  /** Canonical line `i + 1` came from raw line `lineMap[i]` (1-based). */
  readonly lineMap: readonly number[];
}

/** What the model wrote: {@link lintDiagram}'s two outcomes. */
export type DiagramLint =
  | DiagramSource
  | { readonly ok: false; readonly errors: readonly string[] };

/** Where a source came from, recovered when a `lintDiagram` result is refused. */

/** Raw line numbers of a source, so an error can name the model's own line. */ export interface LineMap {
  readonly lines: readonly string[];
  readonly map: readonly number[];
}

/** Tabs, CRLF, a BOM and NBSP confuse the lexer, never the meaning. */
function normalise(raw: string): string {
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\t/g, "  ")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n");
}

/** `%%`, `%%{init}%%` and a `;`-only line say nothing about the diagram. */
function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed === ";" || trimmed.startsWith("%%");
}

/** The dropped-construct notes, kept in one bag so they read in a stable order. */
interface Notes {
  fence: boolean;
  frontMatter: boolean;
  directives: string[];
  style: number;
  click: number;
}

function noteList(notes: Notes): string[] {
  const out: string[] = [];
  if (notes.fence) out.push("the ```mermaid fence");
  if (notes.frontMatter) out.push("the config front-matter (the app chooses theme and fonts)");
  for (const directive of notes.directives) {
    out.push(`%%{${directive}}%% (the app chooses theme and fonts)`);
  }
  if (notes.style > 0) {
    const count = notes.style === 1 ? "1 style line" : `${notes.style} style lines`;
    out.push(`${count} (the app chooses colours and fonts)`);
  }
  if (notes.click > 0) {
    const count = notes.click === 1 ? "1 click line" : `${notes.click} click lines`;
    out.push(`${count} (a diagram is not interactive)`);
  }
  return out;
}

const FENCE = /^\s*```[A-Za-z]*\s*$/;
/** `style`, `classDef`, `linkStyle` and a `class A foo` assignment: pure styling. */
const STYLE_LINE = /^(?:style|classDef|linkStyle)\s/;
/** `class A foo` is styling in a flowchart — but a declaration in a classDiagram. */
const CLASS_ASSIGNMENT = /^class\s+[\w-]+\s+[\w-]+\s*$/;
/** `:::` + a class id, inline on a node: the flowchart spelling of `class`. */
const INLINE_CLASS = /:::[\w-]+/g;
const CLICK_LINE = /^click\s/;
/**
 * A line's statements: `;` joins them, but one inside a quoted string (a `click`
 * href, a label) is text, not a separator.
 */
function splitStatements(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    if (char === ";" && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out;
}

/** Whether one statement (a `;`-separated piece) is pure styling. */
function isStyleStatement(text: string, type: DiagramType): boolean {
  return STYLE_LINE.test(text) || (type === "flowchart" && CLASS_ASSIGNMENT.test(text));
}

/** `flowchart TD`, `graph LR`, `sequenceDiagram`, … → the line's type. */
function typeOf(line: string): { type: DiagramType; keyword: string; direction?: string } | null {
  const token = (line.trim().split(/[\s;]/)[0] ?? "").trim();
  if (token === "") return null;
  const alias = aliasType(token);
  if (!alias) return null;
  // A flowchart always flows somewhere: `flowchart` alone is `TD`.
  const direction = alias.type === "flowchart" ? (directionOf(line) ?? "TD") : undefined;
  return { type: alias.type, keyword: alias.keyword, direction };
}

function directionOf(line: string): string | undefined {
  // Only the statement that carries the type: `graph;A --> TD` has no direction.
  const head = line.split(";")[0] ?? line;
  const match = /\b(TB|TD|BT|RL|LR)\b/.exec(head);
  return match?.[1];
}

/**
 * The type line, spelled canonically — the leading keyword ONLY, so a one-liner
 * (`graph TD;A-->B;B-->C`) keeps the statements that follow it. A flowchart also
 * gets its direction, defaulted to `TD` when the line does not say one.
 */
function canonicalTypeLine(line: string, typed: { keyword: string; direction?: string }): string {
  const token = /^\s*[\w-]+/.exec(line)?.[0] ?? "";
  const after = line.slice(token.length);
  if (typed.direction === undefined) return `${typed.keyword}${after}`;
  const stated = /^\s*(?:TB|TD|BT|RL|LR)\b/.exec(after);
  const tail = stated === null ? after : after.slice(stated[0].length);
  return `${typed.keyword} ${typed.direction}${tail}`;
}

/** The raw line's type, or why it is refused. */
function refuseType(line: string, rawLine: number): readonly string[] {
  const trimmed = line.trim();
  const token = (trimmed.split(/[\s;]/)[0] ?? "").trim();
  if (isRefusedNumbersType(token)) {
    return [
      `line ${rawLine}: "${token}" draws numbers — use the chart tool${numbersAdvice(token)}`,
    ];
  }
  if (isUnsupportedType(token)) {
    return [`line ${rawLine}: "${token}" is not supported — ${allowedSentence()}`];
  }
  return [`line ${rawLine}: unknown diagram type "${token}" — ${describeUnknownType(token)}`];
}

function numbersAdvice(token: string): string {
  switch (token) {
    case "pie":
      return ' (type "pie"/"doughnut")';
    case "xychart-beta":
    case "xychart":
      return ' (type "line"/"bar")';
    case "quadrantChart":
      return ' (type "scatter")';
    default:
      return "";
  }
}

function allowedSentence(): string {
  return `Allowed: ${allowedList()}`;
}

/**
 * Lint a Mermaid source and return its canonical form, or every refusal at once
 * (≤ {@link DIAGRAM_CAPS.errors}), each `line N[, col M]: <what> — <fix>`.
 */
export function lintDiagram(raw: string): DiagramLint {
  const text = normalise(raw);
  const lines = text.split("\n");
  const bytes = new TextEncoder().encode(text).byteLength;
  if (bytes > DIAGRAM_CAPS.bytes && lines.length > DIAGRAM_CAPS.lines) {
    return {
      ok: false,
      errors: [
        `the diagram is too large (${lines.length} lines > ${DIAGRAM_CAPS.lines}, ${Math.ceil(bytes / 1024)} KiB > 20 KiB) — split it into two diagrams or group nodes into subgraphs`,
      ],
    };
  }
  if (lines.length > DIAGRAM_CAPS.lines) {
    return {
      ok: false,
      errors: [
        `the diagram is too large (${lines.length} lines > ${DIAGRAM_CAPS.lines}) — split it into two diagrams or group nodes into subgraphs`,
      ],
    };
  }
  if (bytes > DIAGRAM_CAPS.bytes) {
    return {
      ok: false,
      errors: [
        `the diagram is too large (${Math.ceil(bytes / 1024)} KiB > 20 KiB) — split it into two diagrams or group nodes into subgraphs`,
      ],
    };
  }

  const notes: Notes = { fence: false, frontMatter: false, directives: [], style: 0, click: 0 };
  const kept: { text: string; raw: number }[] = [];
  const drop = new Set<number>();

  // 1. A Markdown fence: the model copied its own output. Forgiven, not retried.
  let start = 0;
  let end = lines.length - 1;
  while (start <= end && (lines[start] ?? "").trim() === "") start++;
  while (end >= start && (lines[end] ?? "").trim() === "") end--;
  if (start < lines.length && FENCE.test(lines[start] ?? "")) {
    notes.fence = true;
    drop.add(start);
    let close = end;
    while (close > start && (lines[close] ?? "").trim() === "") close--;
    if (close > start && FENCE.test(lines[close] ?? "")) drop.add(close);
  }

  // 2. A YAML config front-matter: the theme is ours (Owner Q5).
  let firstBody = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!drop.has(i) && (lines[i] ?? "").trim() !== "") {
      firstBody = i;
      break;
    }
  }
  if ((lines[firstBody] ?? "").trim() === "---") {
    for (let i = firstBody + 1; i < lines.length; i++) {
      if ((lines[i] ?? "").trim() === "---") {
        notes.frontMatter = true;
        for (let j = firstBody; j <= i; j++) drop.add(j);
        break;
      }
    }
  }

  // 3. Directives: dropped, counted, never an error. They run BEFORE the type
  // line is looked for, because the usual form spans lines (`%%{init: {` …
  // `}}%%`), whose inner lines would otherwise read as the diagram.
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    const trimmed = (lines[i] ?? "").trim();
    if (!trimmed.startsWith("%%{")) continue;
    const keyword = /^\{(?:[^:}]*:\s*)?("?)([\w-]+)/.exec(trimmed.slice(3))?.[2] ?? "init";
    notes.directives.push(keyword);
    // A directive may span lines until `}%%`.
    let j = i;
    while (j < lines.length && !(lines[j] ?? "").includes("}%%")) j++;
    for (let k = i; k <= Math.min(j, lines.length - 1); k++) drop.add(k);
    i = Math.min(j, lines.length - 1);
  }

  // 4. The type line: the first line that says something.
  let typeLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i) || isComment(lines[i] ?? "")) continue;
    typeLine = i;
    break;
  }
  if (typeLine === -1) {
    return {
      ok: false,
      errors: ['the diagram is empty — start with a type line, e.g. "flowchart TD"'],
    };
  }
  const typed = typeOf(lines[typeLine] ?? "");
  if (!typed) return { ok: false, errors: refuseType(lines[typeLine] ?? "", typeLine + 1) };

  // 5. Styling and clicks: dropped, counted, never an error. `;` joins
  // statements, so `A-->B; click A href "…"` loses the click, not the line.
  const sequential = typed.type === "flowchart" || typed.type === "stateDiagram";
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    const line = lines[i] ?? "";
    // A comment says nothing about the diagram: its `;` is prose, not a join.
    if (line.trim().startsWith("%%")) continue;
    const statements = splitStatements(line);
    const keptStatements: string[] = [];
    let lost = false;
    for (let s = 0; s < statements.length; s++) {
      const statement = statements[s] ?? "";
      const text = statement.trim();
      // The type line's own statement is never styling, whatever it spells.
      const isTypeStatement = i === typeLine && s === 0;
      if (text !== "" && !isTypeStatement && isStyleStatement(text, typed.type)) {
        notes.style++;
        lost = true;
        continue;
      }
      if (text !== "" && CLICK_LINE.test(text)) {
        notes.click++;
        lost = true;
        continue;
      }
      keptStatements.push(statement);
    }
    if (lost) {
      if (keptStatements.every((statement) => statement.trim() === "")) {
        drop.add(i);
        continue;
      }
      lines[i] = keptStatements.join(";").replace(/\s+$/, "");
    }
    if (i === typeLine) continue;
    if (sequential && INLINE_CLASS.test(lines[i] ?? "")) {
      notes.style++;
      lines[i] = (lines[i] ?? "").replace(INLINE_CLASS, "");
    }
    INLINE_CLASS.lastIndex = 0;
  }

  // 6. The canonical source, and where each of its lines came from.
  for (let i = 0; i < lines.length; i++) {
    if (drop.has(i)) continue;
    kept.push({ text: lines[i] ?? "", raw: i + 1 });
  }
  while (kept.length > 1 && (kept[kept.length - 1] as { text: string }).text.trim() === "")
    kept.pop();
  if (kept.length === 0) {
    return {
      ok: false,
      errors: ['the diagram is empty — start with a type line, e.g. "flowchart TD"'],
    };
  }

  // The type line, spelled canonically (an alias becomes its real name).
  const head = kept.findIndex((line) => line.raw === typeLine + 1);
  if (head >= 0) {
    kept[head] = { text: canonicalTypeLine(lines[typeLine] ?? "", typed), raw: typeLine + 1 };
  }

  return {
    ok: true,
    canonical: kept.map((line) => line.text).join("\n"),
    type: typed.type,
    notes: noteList(notes),
    lineMap: kept.map((line) => line.raw),
  };
}
