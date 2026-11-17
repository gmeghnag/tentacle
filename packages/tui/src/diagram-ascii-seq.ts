/**
 * A sequence diagram as an ASCII drawing (docs/feat/model-diagrams.md D8,
 * mockups 6A/6B).
 *
 * - **Lifelines** (6A): a box per participant, a lifeline under each, one
 *   message = a label row + an arrow row (`├───►│` call, `│◄╌╌╌┤` reply, `×`
 *   for a lost message), a self-message as a loop, a note as a dim box.
 * - **List** (6B): one line per message, arrows aligned — the automatic form
 *   under {@link SEQ_LIFELINE_MIN} columns, or when the lifelines do not fit.
 *
 * `alt`/`loop`/… blocks: the model keeps their kind and title, not which
 * messages they wrap, so they are not drawn as frames (that would be a guess);
 * a dim line under the drawing names them and points at the source.
 *
 * Pure: no I/O, no React, no colour (cells carry style names).
 */
import type { SequenceMessage, SequenceModel } from "@tentacle/core";
import { cellWidth } from "./cells.ts";
import { Canvas, type DiagramRow, type DiagramSeg } from "./diagram-canvas.ts";

/** Below this many columns the lifelines give way to the list (mockup 6B). */
export const SEQ_LIFELINE_MIN = 50;

export interface SeqDrawing {
  readonly rows: DiagramRow[];
  readonly width: number;
  readonly form: "lifelines" | "list";
}

/** The drawing: lifelines when they fit in `maxWidth` (≥ 50), else the list. */
export function drawSequence(model: SequenceModel, maxWidth: number): SeqDrawing {
  if (maxWidth >= SEQ_LIFELINE_MIN && model.participants.length > 0) {
    const lifelines = lifelineRows(model);
    if (lifelines.width <= maxWidth)
      return { ...withBlocks(lifelines.rows, model), form: "lifelines" };
  }
  return { ...withBlocks(listRows(model), model), form: "list" };
}

function withBlocks(
  rows: DiagramRow[],
  model: SequenceModel,
): { rows: DiagramRow[]; width: number } {
  const out = [...rows];
  if (model.blocks.length > 0) {
    const names = [
      ...new Set(model.blocks.map((b) => (b.title === "" ? b.kind : `${b.kind} ${b.title}`))),
    ];
    out.push([], [["subtle", `${names.join(" · ")} — blocks shown in the source (ctrl+o)`]]);
  }
  const width = out.reduce(
    (max, row) =>
      Math.max(
        max,
        row.reduce((s, [, t]) => s + cellWidth(t), 0),
      ),
    0,
  );
  return { rows: out, width };
}

// ── lifelines (6A) ───────────────────────────────────────────────────────────

const HEADER = 3;

function lifelineRows(model: SequenceModel): { rows: DiagramRow[]; width: number } {
  const parts = model.participants;
  const index = new Map(parts.map((p, i) => [p.id, i] as const));
  const boxW = parts.map((p) => cellWidth(p.label) + 4);
  const textW = (m: SequenceMessage): number => cellWidth(m.text);

  // centres, left to right, each as close as its constraints allow
  const x: number[] = [];
  parts.forEach((_, j) => {
    let at = j === 0 ? Math.floor(((boxW[0] as number) - 1) / 2) : 0;
    if (j > 0) {
      const i = j - 1;
      at = Math.max(
        at,
        (x[i] as number) +
          Math.ceil((boxW[i] as number) / 2) +
          Math.ceil((boxW[j] as number) / 2) +
          2,
      );
    }
    for (const m of model.messages) {
      const a = index.get(m.from) ?? -1;
      const b = index.get(m.to) ?? -1;
      if (m.note) continue;
      if (a === b && a === j - 1) at = Math.max(at, (x[a] as number) + textW(m) + 7);
      else if (Math.max(a, b) === j && Math.min(a, b) >= 0 && a !== b) {
        at = Math.max(at, (x[Math.min(a, b)] as number) + textW(m) + 4);
      }
    }
    x[j] = at;
  });

  // notes: dim boxes over their lifelines (left edge may need a shift)
  const noteSpan = (m: SequenceMessage): [number, number] => {
    const a = x[index.get(m.from) ?? 0] as number;
    const b = x[index.get(m.to) ?? 0] as number;
    const mid = Math.floor((a + b) / 2);
    const w = Math.max(textW(m) + 4, Math.abs(a - b) + 5);
    const c0 = mid - Math.floor((w - 1) / 2);
    return [c0, c0 + w - 1];
  };
  const shift = Math.max(
    0,
    -Math.min(0, ...model.messages.filter((m) => m.note).map((m) => noteSpan(m)[0])),
  );
  for (let i = 0; i < x.length; i++) x[i] = (x[i] as number) + shift;

  const canvas = new Canvas();
  parts.forEach((p, i) => {
    const c0 = (x[i] as number) - Math.floor(((boxW[i] as number) - 1) / 2);
    const c1 = c0 + (boxW[i] as number) - 1;
    canvas.line(0, c0, 0, c1, "border");
    canvas.line(2, c0, 2, c1, "border");
    canvas.line(0, c0, 2, c0, "border");
    canvas.line(0, c1, 2, c1, "border");
    canvas.text(1, c0 + 2, p.label, "text");
  });

  let row = HEADER + 1;
  const covered: { r0: number; r1: number; c0: number; c1: number }[] = [];
  for (const m of model.messages) {
    const a = index.get(m.from);
    const b = index.get(m.to);
    if (a === undefined || b === undefined) continue;
    const xa = x[a] as number;
    const xb = x[b] as number;
    if (m.note) {
      const [n0, n1] = noteSpan(m);
      const c0 = n0 + shift;
      const c1 = n1 + shift;
      canvas.line(row, c0, row, c1, "frame");
      canvas.line(row + 2, c0, row + 2, c1, "frame");
      canvas.line(row, c0, row + 2, c0, "frame");
      canvas.line(row, c1, row + 2, c1, "frame");
      canvas.text(row + 1, c0 + 2, m.text, "frame");
      covered.push({ r0: row, r1: row + 2, c0, c1 });
      row += 3;
      continue;
    }
    const weight = m.style === "reply" ? "dotted" : "solid";
    const head = m.style === "cross" ? "×" : xb >= xa ? "►" : "◄";
    if (a === b) {
      canvas.line(row, xa, row, xa + 3, "border", weight);
      canvas.line(row, xa + 3, row + 1, xa + 3, "border", weight);
      canvas.line(row + 1, xa + 1, row + 1, xa + 3, "border", weight);
      canvas.put(row + 1, xa + 1, m.style === "cross" ? "×" : "◄", "border");
      canvas.text(row, xa + 5, m.text, "label");
      row += 2;
      continue;
    }
    canvas.text(row, Math.min(xa, xb) + 2, m.text, "label");
    const tip = xb > xa ? xb - 1 : xb + 1;
    canvas.line(row + 1, xa, row + 1, tip, "border", weight);
    canvas.put(row + 1, tip, head, "border");
    row += 2;
  }
  const last = row;

  // lifelines last: they merge with the arrows (├ ┤) and stop under a note
  for (const xi of x) {
    let from = HEADER - 1;
    for (let r = HEADER; r <= last; r++) {
      const hidden = covered.some((n) => r >= n.r0 && r <= n.r1 && xi >= n.c0 && xi <= n.c1);
      if (hidden) {
        if (r - 1 > from) canvas.line(from, xi, r - 1, xi, "border");
        from = r + 1;
      }
    }
    if (last > from) canvas.line(from, xi, last, xi, "border");
  }
  return { rows: canvas.rows(), width: canvas.width };
}

// ── list (6B) ────────────────────────────────────────────────────────────────

function listRows(model: SequenceModel): DiagramRow[] {
  const label = new Map(model.participants.map((p) => [p.id, p.label] as const));
  const name = (id: string): string => label.get(id) ?? id;
  const nameW = Math.max(0, ...model.participants.map((p) => cellWidth(p.label)));
  const arrows = model.messages.filter((m) => !m.note);
  const textW = Math.max(0, ...arrows.map((m) => cellWidth(m.text)));
  return model.messages.map((m): DiagramRow => {
    const from = name(m.from);
    if (m.note) {
      const over = m.from === m.to ? from : `${from},${name(m.to)}`;
      return [["frame", `note ${over}: ${m.text}`]];
    }
    const dash = m.style === "reply" ? "╌" : "─";
    const fill = dash.repeat(textW - cellWidth(m.text) + 2);
    const head = m.style === "cross" ? "×" : "►";
    const segs: DiagramSeg[] = [
      ["text", from + " ".repeat(nameW - cellWidth(from))],
      ["border", ` ${dash}${dash} `],
      ["label", m.text],
      ["border", ` ${fill}${head} `],
      ["text", name(m.to)],
    ];
    return segs;
  });
}
