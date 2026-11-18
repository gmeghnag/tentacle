/**
 * A `diagram` tool call as terminal rows (docs/feat/model-diagrams.md D8,
 * mockups 5A/6A/6B and frame 4): `(args, width, expanded, mode) → string[]` of
 * chalk-styled lines, none wider than `width`. Pure: no I/O, no React, no
 * terminal writes — `render-lines` places the rows (AGENTS §7).
 *
 * Tiers, a pure function of the width (a resize re-lays it out):
 * - flowchart → the ASCII drawing when it fits (and can be drawn faithfully),
 *   sequence → lifelines at ≥ 50 cols, the one-line-per-message list below;
 * - anything else (other types, a flowchart too wide or not drawable) → the
 *   highlighted source, cut to {@link DIAGRAM_SOURCE_PREVIEW} lines with the
 *   generic `… +N more lines · ctrl+o to expand`.
 * Expanded: the drawing AND the whole source under it.
 *
 * The client re-lints the call's own arguments on every draw (a pod can forge
 * them, AGENTS §7): anything the shared lint refuses → `undefined`, and the
 * caller shows the generic tool row.
 */
import { type DiagramSource, diagramModel, lintDiagram } from "@tentacle/core";
import chalk from "chalk";
import { cellWidth, truncateCells } from "./cells.ts";
import { type FlowReason, drawFlowResult } from "./diagram-ascii-flow.ts";
import { drawSequence } from "./diagram-ascii-seq.ts";
import type { DiagramRow, DiagramSeg, DiagramStyle } from "./diagram-canvas.ts";
import { highlightMermaidLine } from "./diagram-highlight.ts";
import { type ThemeMode, colorStyler, diagramColor, themeMode, tokens } from "./theme.ts";
import { EXPAND_HINT } from "./tool-expand.ts";

/** Source lines shown before the cut when there is no drawing (mockup frame 4). */
export const DIAGRAM_SOURCE_PREVIEW = 5;
/** The title cap the tool enforces (`tools` `DIAGRAM_TITLE_MAX`; tools is not a TUI runtime dep). */
const TITLE_MAX = 120;

/**
 * Why a flowchart is shown as its source, in the few words a caption can hold:
 * the reader's next move differs (`^X^O` opens it, a wider window helps).
 */
const FLOW_REASON: Readonly<Record<FlowReason, (width: number) => string>> = {
  "too-wide": (width) => `too wide for ${width} cols — widen the window or ^X^O`,
  "too-big": () => "too many boxes to draw — ^X^O for the source",
  "not-drawable": () => "cannot draw faithfully in a terminal — ^X^O for the source",
};

export interface DiagramLineOptions {
  /** The cells available; every returned line fits in it. */
  readonly width: number;
  /** Ctrl+O / a click on the caption: drawing + the whole source. */
  readonly expanded?: boolean;
  /** The palette's mode; defaults to the TUI's own. */
  readonly mode?: ThemeMode;
  /** Colour on? Defaults to `chalk.level > 0`. NO_COLOR keeps every glyph (`◇`, `╌`). */
  readonly color?: boolean;
  /** Show `^X^O open` in the caption (only once the artifacts chord exists, D7). */
  readonly openHint?: boolean;
}

/** C0/C1 controls (a tab too → a space), the rule `subagent-notify.ts` applies to a row. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal must never receive one
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/** A validated call: its caption and lint result. */
export interface DiagramCall {
  readonly title: string;
  readonly source: DiagramSource;
}

/** The call's own arguments, re-linted — or `undefined` (not JSON, forged, refused). */
export function parseDiagramArgs(args: string): DiagramCall | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const { title, mermaid } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof mermaid !== "string") return undefined;
  const t = title.trim();
  if (t === "" || t.length > TITLE_MAX) return undefined;
  const source = lintDiagram(mermaid);
  return source.ok ? { title: t, source } : undefined;
}

/** The rows a `diagram` call draws, or `undefined` → the generic tool row. */
export function diagramToolBody(
  args: string,
  options: DiagramLineOptions,
): readonly string[] | undefined {
  const call = parseDiagramArgs(args);
  return call === undefined ? undefined : diagramLines(call, options);
}

/** A validated call as painted lines. */
export function diagramLines(call: DiagramCall, options: DiagramLineOptions): string[] {
  const color = options.color ?? chalk.level > 0;
  const mode = options.mode ?? themeMode();
  return diagramView(call, options).map((row) => paint(row, color, mode));
}

/** The uncoloured view (styled runs): what {@link diagramLines} paints. */
export function diagramView(call: DiagramCall, options: DiagramLineOptions): DiagramRow[] {
  const width = Math.max(1, Math.floor(options.width));
  const expanded = options.expanded === true;
  const { type } = call.source;
  // Every text that reaches a row (caption, labels, source) is cleaned first:
  // the args may come from a pod, and a terminal must never receive an escape.
  const canonical = call.source.canonical
    .split("\n")
    .map((line) => line.replace(CONTROL, " "))
    .join("\n");
  const title = call.title.replace(CONTROL, " ");
  const model = diagramModel(canonical, type);

  let drawing: { rows: DiagramRow[]; width: number; indent: boolean } | undefined;
  /** Why there is no drawing, when there is none (the caption says it). */
  let reason: string | undefined;
  if (model.kind === "flowchart") {
    const d = drawFlowResult(model, width);
    if ("drawing" in d) drawing = { rows: d.drawing.rows, width: d.drawing.width, indent: false };
    else reason = FLOW_REASON[d.reason](width);
  } else if (model.kind === "sequence") {
    const d = drawSequence(model, width);
    drawing = { rows: d.rows, width: d.width, indent: d.form === "list" };
  }

  const caption: DiagramSeg[] = [
    ["title", title],
    ["subtle", ` · ${type}`],
  ];
  if (drawing === undefined)
    caption.push(["subtle", ` · ${reason ?? "source only in the terminal"}`]);
  if (options.openHint === true) caption.push(["subtle", " · ^X^O open"]);

  const rows: DiagramRow[] = [centre(fit(caption, width), width), []];
  if (drawing !== undefined) {
    const pad = drawing.indent
      ? Math.min(2, Math.max(0, width - drawing.width))
      : Math.max(0, Math.floor((width - drawing.width) / 2));
    for (const row of drawing.rows)
      rows.push(fit(row.length === 0 ? row : [["text", " ".repeat(pad)], ...row], width));
    if (!expanded) return rows;
    rows.push([]);
  }
  const source = canonical
    .split("\n")
    .map((line): DiagramRow => fit([["border", "│ "], ...highlightMermaidLine(line)], width));
  if (expanded || source.length <= DIAGRAM_SOURCE_PREVIEW + 1) return [...rows, ...source];
  const hidden = source.length - DIAGRAM_SOURCE_PREVIEW;
  return [
    ...rows,
    ...source.slice(0, DIAGRAM_SOURCE_PREVIEW),
    fit([["subtle", `… +${hidden} more lines · ${EXPAND_HINT}`]], width),
  ];
}

function rowWidth(row: DiagramRow): number {
  return row.reduce((sum, [, text]) => sum + cellWidth(text), 0);
}

/** A row cut to `max` cells (the run that crosses the edge ends in `…`). */
function fit(row: DiagramRow, max: number): DiagramRow {
  if (rowWidth(row) <= max) return row;
  const out: DiagramSeg[] = [];
  let used = 0;
  for (const [style, text] of row) {
    const w = cellWidth(text);
    if (used + w <= max) {
      out.push([style, text]);
      used += w;
      continue;
    }
    const room = max - used;
    if (room > 0) out.push([style, truncateCells(text, room)]);
    break;
  }
  return out;
}

function centre(row: DiagramRow, width: number): DiagramRow {
  const pad = Math.floor((width - rowWidth(row)) / 2);
  return pad > 0 ? [["text", " ".repeat(pad)], ...row] : row;
}

function paint(row: DiagramRow, color: boolean, mode: ThemeMode): string {
  return row.map(([style, text]) => (color ? styler(style, mode)(text) : text)).join("");
}

function styler(style: DiagramStyle, mode: ThemeMode): (text: string) => string {
  if (style === "title") return chalk.bold;
  if (style === "text") return (text) => text;
  const c = diagramColor(style, tokens[mode]);
  return c === undefined ? (text) => text : colorStyler(c);
}
