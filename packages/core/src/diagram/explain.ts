/**
 * Mermaid's parse error, rewritten as a sentence a small model can act on
 * (docs/feat/model-diagrams.md D3, `explain.ts`).
 *
 * Mermaid throws two entirely different shapes — a jison error with
 * `hash.loc`/`hash.token`/`hash.expected` (flowchart, sequence, class, state,
 * ER, gantt, mindmap, timeline, journey) and a chevrotain/langium one with
 * `result.parserErrors[]` carrying `token.startLine` (gitGraph, pie, …) — plus
 * a plain "No diagram type detected" for a source whose first line is unknown.
 * The shapes were recorded by the D2 probe and are pinned by fixtures here, so
 * `core` never imports mermaid.
 *
 * Every sentence names the MODEL's line (via `lineMap`) and the fix. Anything
 * this module does not recognise still gets a sentence, the offending line and
 * a caret under the column — never a raw object dump.
 */

/** One failure, as this module reads it out of whichever shape arrived. */
interface Fault {
  /** The canonical (1-based) line. */
  readonly line: number;
  /** The column Mermaid reported; `undefined` when it did not. */
  readonly column?: number;
  /** The token Mermaid objected to (`PS`, `MINUS`, `end`, …). */
  readonly token?: string;
  /** What it would have accepted (the jison shape only). */
  readonly expected: readonly string[];
  /** Its own message, already a string. */
  readonly message: string;
  /** The parser family: chevrotain reports a different sentence than jison. */
  readonly family: "jison" | "chevrotain";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item));
}

/** Read whichever error shape arrived; `null` when there is nothing to read. */
function faultOf(error: unknown): Fault | null {
  const err = asRecord(error);
  if (!err) return null;
  const message = typeof err.message === "string" ? err.message : String(err.message ?? error);

  // A lexical error names its line in the message and nothing else; its `hash`
  // line is 0-based, so it is read last (and never mixed with the two above).
  const lexical = /Lexical error on line (\d+)/.exec(message);

  // chevrotain / langium: the parser's own error list, with 1-based lines.
  const result = asRecord(err.result);
  const parserErrors = result?.parserErrors;
  if (Array.isArray(parserErrors) && parserErrors.length > 0) {
    const first = asRecord(parserErrors[0]);
    const token = asRecord(first?.token);
    const line = asNumber(token?.startLine);
    if (line !== undefined) {
      const image = typeof token?.image === "string" ? token.image : undefined;
      return {
        line,
        column: asNumber(token?.startColumn),
        expected: [],
        message: typeof first?.message === "string" ? first.message : message,
        family: "chevrotain",
        ...(image === undefined ? {} : { token: image }),
      };
    }
  }
  const lexerErrors = result?.lexerErrors;
  if (Array.isArray(lexerErrors) && lexerErrors.length > 0) {
    const first = asRecord(lexerErrors[0]);
    const line = asNumber(first?.line);
    if (line !== undefined) {
      const column = asNumber(asRecord(first?.column)?.start);
      return {
        line,
        expected: [],
        message: typeof first?.message === "string" ? first.message : message,
        family: "chevrotain",
        ...(column === undefined ? {} : { column }),
      };
    }
  }

  // jison: `hash` carries the location, the token and the expectation list.
  const hash = asRecord(err.hash);
  if (hash && asRecord(hash.loc) !== null) {
    const loc = asRecord(hash.loc) as Record<string, unknown>;
    const line = asNumber(loc.first_line) ?? asNumber(hash.line);
    if (line !== undefined) {
      return {
        line,
        column: asNumber(loc.first_column),
        token: typeof hash.token === "string" ? hash.token : undefined,
        expected: asStrings(hash.expected),
        message,
        family: "jison",
      };
    }
  }

  if (lexical?.[1] !== undefined) {
    return { line: Number(lexical[1]), message, expected: [], family: "jison" };
  }
  return null;
}

/** `line 3, col 12` — the position, naming only what is known. */
function at(line: number, column?: number): string {
  return column === undefined ? `line ${line}` : `line ${line}, col ${column + 1}`;
}

/** The model's own line number for a canonical one (1-based both ways). */
function modelLine(canonicalLine: number, lineMap: readonly number[]): number {
  return lineMap[canonicalLine - 1] ?? canonicalLine;
}

/** The canonical line's text, or `""` past the end. */
function textAt(source: string, canonicalLine: number): string {
  return source.split("\n")[canonicalLine - 1] ?? "";
}

/**
 * A label Mermaid choked on because it holds `(`, `)` or another bracket that
 * belongs to the label's text, not to the shape: `A[Carica (sessione)]`. Returns
 * the fix, or `null`. The bracket that closes the shape is the one at the
 * label's own depth, so `A[x]` and `A[x (y)]` both read correctly.
 */
function parenthesisedLabel(line: string): { col: number; label: string; quoted: string } | null {
  const shapes: readonly [string, string][] = [
    ["([", "])"],
    ["[(", ")]"],
    ["((", "))"],
    ["[", "]"],
    ["(", ")"],
    ["{", "}"],
  ];
  for (const [opener, closer] of shapes) {
    let from = 0;
    while (from < line.length) {
      const open = line.indexOf(opener, from);
      if (open < 0) break;
      const id = /[A-Za-z_][\w-]*$/.exec(line.slice(0, open))?.[0];
      const inner = open + opener.length;
      let depth = 0;
      let close = -1;
      for (let i = inner; i < line.length; i++) {
        if (line.startsWith(opener, i)) {
          depth++;
          i += opener.length - 1;
          continue;
        }
        if (line.startsWith(closer, i) && depth === 0) {
          close = i;
          break;
        }
        if (line.startsWith(closer, i)) {
          depth--;
          i += closer.length - 1;
        }
      }
      if (id === undefined || close < 0) {
        from = open + opener.length;
        continue;
      }
      const label = line.slice(inner, close);
      const paren = /[()[\]]/.exec(label);
      if (paren === null) {
        from = close + closer.length;
        continue;
      }
      const col = inner + (paren.index ?? 0);
      return { col, label, quoted: `${id}[${JSON.stringify(label)}]` };
    }
  }
  return null;
}

/** `->` where a flowchart wants an arrow. */
function shortArrow(line: string): { col: number } | null {
  // A `->` that is not already part of `-->`.
  const match = /(^|[^-])->(?!>)/.exec(line);
  if (!match) return null;
  return { col: (match.index ?? 0) + (match[1]?.length ?? 0) };
}

/** A sequence message with no text after a colon-less arrow. */
function messageWithoutText(line: string): { arrow: string } | null {
  const match = /([A-Za-z_][\w-]*)\s*(-->>|->>|-->|->|--x|-x)\s*([A-Za-z_][\w-]*)\s*$/.exec(
    line.trim(),
  );
  if (!match) return null;
  return { arrow: match[2] ?? "->>" };
}

/** The keywords that open a block a model forgets to close. */
const BLOCK_KEYWORDS: readonly string[] = [
  "subgraph",
  "alt",
  "opt",
  "loop",
  "par",
  "critical",
  "break",
  "rect",
  "box",
  "state",
  "section",
];

/** The innermost unclosed block: its opener line and keyword. */
function unclosedBlock(source: string): { keyword: string; title: string; line: number } | null {
  const stack: { keyword: string; title: string; line: number }[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();
    const opener = BLOCK_KEYWORDS.find(
      (keyword) => trimmed === keyword || trimmed.startsWith(`${keyword} `),
    );
    if (opener !== undefined && !(opener === "state" && trimmed.includes("-->"))) {
      stack.push({ keyword: opener, title: trimmed, line: i + 1 });
      continue;
    }
    if (trimmed === "end") stack.pop();
  }
  const last = stack[stack.length - 1];
  return last === null || last === undefined ? null : last;
}

/** Mermaid's expectation list, shortened to what a model can act on. */
function expectation(fault: Fault): string {
  if (fault.family === "chevrotain") {
    // Its message already names the token sequence it wanted.
    const wanted = /Expecting token of type '([^']+)' but found `([^`]*)`/.exec(fault.message);
    if (wanted?.[1] !== undefined) {
      return `Mermaid expected ${wanted[1] === "EOF" ? "the end of the diagram" : `a ${wanted[1]}`}, not ${JSON.stringify(wanted[2] ?? "")}`;
    }
    const sequence =
      /Expecting: one of these possible Token sequences:\s*\n?\s*1\.\s*\[([^\]]+)\]/.exec(
        fault.message,
      );
    if (sequence?.[1] !== undefined) {
      return `Mermaid expected ${sequence[1].trim()}`;
    }
    return "Mermaid could not parse this";
  }
  const got = /got '([^']*)'/.exec(fault.message)?.[1];
  const what = fault.expected
    .filter((item) => item !== "'EOF'")
    .slice(0, 3)
    .join(", ");
  if (what !== "" && got !== undefined) return `Mermaid expected ${what}, found "${got}"`;
  // No expectation list (a MINUS where a link belongs): the token's own image.
  const image = fault.token === undefined ? undefined : fault.token;
  if (image !== undefined) return `Mermaid stopped at ${JSON.stringify(image)}`;
  if (got !== undefined) return `found "${got}"`;
  return "the grammar did not accept it";
}

/** The line with a caret under column `col` (0-based), as two rows. */
function caret(line: string, col: number | undefined): string[] {
  const shown = line.replace(/\t/g, " ").trimEnd();
  if (col === undefined) return [shown];
  const position = Math.max(0, Math.min(col, Math.max(0, shown.length - 1)));
  return [shown, `${" ".repeat(position)}^`];
}

/**
 * Mermaid's error, as the sentences the model reads: the specific mistake and
 * its fix when we recognise it, otherwise a generic one with the caret.
 */
export function explainMermaidError(
  error: unknown,
  source: string,
  lineMap: readonly number[] = [],
): string[] {
  const fault = faultOf(error);
  if (!fault) {
    const record = asRecord(error);
    const own = typeof record?.message === "string" ? record.message.split("\n")[0] : undefined;
    const raw = typeof error === "string" ? error : "";
    const hint = (own ?? raw).trim();
    const head = hint === "" ? "Mermaid could not parse this diagram" : hint;
    return [`line 1: ${head} — check the type line and the syntax around it`];
  }
  const lineText = textAt(source, fault.line);
  const rawLine = modelLine(fault.line, lineMap);

  // 1. A label with a bare parenthesis: the single most common small-model slip.
  const paren = parenthesisedLabel(lineText);
  if (paren) {
    return [
      `line ${rawLine}, col ${paren.col + 1}: the label ${JSON.stringify(paren.label)} has parentheses — quote it: ${paren.quoted}`,
    ];
  }

  // 2. A reserved word used as a node id.
  const reserved = ["end", "graph", "subgraph", "default", "style", "class", "click"].find(
    (word) => word === fault.token,
  );
  if (reserved !== undefined) {
    return [
      `line ${rawLine}: "${reserved}" cannot be a node id — rename it (e.g. "${reserved}Node")`,
    ];
  }

  // 3. `->` where a flowchart needs `-->`.
  if (fault.token === "MINUS" || fault.token === "LINK") {
    const arrow = shortArrow(lineText);
    if (arrow) {
      return [
        `line ${rawLine}, col ${arrow.col + 1}: "->" is not an arrow in a flowchart — use "-->" (or "-.->", "==>")`,
      ];
    }
  }

  // 4. A sequence message with no text.
  if (fault.token === "NEWLINE" && fault.expected.some((item) => item.includes("TXT"))) {
    const message = messageWithoutText(lineText);
    if (message) {
      return [
        `line ${rawLine}: a message needs text after a colon — write it as "A${message.arrow}B: richiesta"`,
      ];
    }
  }

  // 5. An unclosed block: the source has more openers than `end`s.
  const unclosed = unclosedBlock(source);
  if (unclosed) {
    const opened = `${unclosed.keyword} "${unclosed.title.slice(unclosed.keyword.length).trim()}"`;
    return [
      `line ${rawLine}: ${JSON.stringify(unclosed.title)} (line ${modelLine(unclosed.line, lineMap)}) is never closed — add "end"`,
    ];
  }

  // 6. Anything else: a sentence, the line and a caret — never a raw dump.
  const sentence = `line ${rawLine}${fault.column === undefined ? "" : `, col ${fault.column + 1}`}: Mermaid could not parse this — ${expectation(fault)}`;
  return [sentence, ...caret(lineText, fault.column)];
}
