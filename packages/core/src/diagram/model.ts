/**
 * A small, own structural model of a Mermaid source (docs/feat/model-diagrams.md
 * D5): the flowchart and sequence subset, and nothing else.
 *
 * It feeds three things — the tool's result line (what the model reads back),
 * the phone's VoiceOver summary and the TUI's ASCII renderer — so all three see
 * ONE reading of the source instead of three guesses.
 *
 * It **never decides validity**: mermaid does (D4). When it meets a construct it
 * does not model (`A & B --> C`, an unknown arrow, a stray `end`) it returns
 * `other`, and every consumer honestly falls back to the source rather than
 * drawing something wrong.
 *
 * Pure: no I/O, no React, no mermaid.
 */

/** The box a node is drawn in. The model keeps it; the client chooses glyphs. */
export type NodeShape =
  | "rect"
  | "round"
  | "stadium"
  | "decision"
  | "cylinder"
  | "circle"
  | "subroutine";

/** One node of a flowchart, or one participant of a sequence diagram. */
export interface DiagramNode {
  readonly id: string;
  /** The text shown in the box (the id when the source gave no `[…]`). */
  readonly label: string;
  readonly shape: NodeShape;
}

/** How an edge is drawn: the line's weight is meaning, so the model keeps it. */
export type EdgeStyle = "solid" | "dotted" | "thick";

/** One edge of a flowchart. */
export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  /** The text on the edge (`-->|si|`, `-- si -->`), when there is one. */
  readonly label?: string;
  readonly style: EdgeStyle;
  /** `false` for `---` / `-.-`: a plain link, no arrowhead. */
  readonly arrow: boolean;
}

/** A `subgraph … end` frame: a dim titled box around its nodes. */
export interface DiagramSubgraph {
  readonly title: string;
  /** The node ids that belong to it (directly; a nested frame adds its own). */
  readonly nodes: readonly string[];
}

/** Which way a flowchart flows (`flowchart TD`). */
export type FlowDirection = "TD" | "BT" | "LR" | "RL";

/** A flowchart (`flowchart`/`graph`). */
export interface FlowModel {
  readonly kind: "flowchart";
  readonly direction: FlowDirection;
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly subgraphs: readonly DiagramSubgraph[];
}

/** What one arrow of a sequence diagram means. */
export type MessageStyle = "call" | "reply" | "cross";

/** `alt`/`opt`/`loop`/`par`/`critical`/`break`/`rect`/`box`: its keyword and title. */
export interface SequenceBlock {
  readonly kind: string;
  readonly title: string;
}

/** A sequence message, or a note over one or two lifelines. */
export interface SequenceMessage {
  readonly from: string;
  readonly to: string;
  readonly text: string;
  readonly style: MessageStyle;
  /** A `Note over A,B` is drawn as a box, not as an arrow. */
  readonly note: boolean;
}

/** A `sequenceDiagram`. */
export interface SequenceModel {
  readonly kind: "sequence";
  readonly participants: readonly DiagramNode[];
  readonly messages: readonly SequenceMessage[];
  readonly blocks: readonly SequenceBlock[];
}

/** A type this model does not read: the client shows the source instead. */
export interface OtherModel {
  readonly kind: "other";
  readonly type: string;
  readonly lines: readonly string[];
}

/** What a canonical source says, as far as this app reads it. */
export type DiagramModel = FlowModel | SequenceModel | OtherModel;

// ---------------------------------------------------------------------------
// Flowchart
// ---------------------------------------------------------------------------

/** Shape openers, longest first, so `([` never reads as `(`. */
const SHAPES: readonly { opener: string; closer: string; shape: NodeShape }[] = [
  { opener: "[[", closer: "]]", shape: "subroutine" },
  { opener: "([", closer: "])", shape: "stadium" },
  { opener: "[(", closer: ")]", shape: "cylinder" },
  { opener: "((", closer: "))", shape: "circle" },
  { opener: "[", closer: "]", shape: "rect" },
  { opener: "(", closer: ")", shape: "round" },
  { opener: "{", closer: "}", shape: "decision" },
];

/** Ids Mermaid reserves: a node may not be called one of them. */
const RESERVED_IDS: ReadonlySet<string> = new Set(["end", "subgraph", "graph", "flowchart"]);

/** Strip the quotes Mermaid allows around a label. */
function unquote(label: string): string {
  const trimmed = label.trim();
  const quoted = /^"(.*)"$/s.exec(trimmed);
  return quoted?.[1] === undefined ? trimmed : quoted[1];
}

/**
 * A `subgraph`'s title: `Title`, `id [Title]` or `id ["Title"]` (Mermaid's own
 * three spellings; the id is not part of the title). An empty title is kept —
 * `drawFrames` then draws an untitled frame.
 */
function subgraphTitle(rest: string): string {
  const text = rest.trim();
  // `id [Title]` / `id ["Title"]`: the id is a word before the bracket.
  const bracketed = /^[A-Za-z_][\w-]*\s*(\[[\s\S]*\])$/.exec(text);
  const inner = bracketed?.[1] === undefined ? text : (bracketed[1] as string);
  const shape = SHAPES.find((candidate) => inner.startsWith(candidate.opener));
  if (shape !== undefined) {
    const label = labelOf(inner, shape.opener, shape.closer);
    if (
      label !== null &&
      inner.slice(shape.opener.length + label.length + shape.closer.length).trim() === ""
    ) {
      return multiline(unquote(label));
    }
  }
  return multiline(unquote(text));
}

/**
 * A label's line breaks: Mermaid's `<br/>` (also `<br>`, `<br />`), all one
 * break. A label's own lines are drawn on separate rows (D8); a one-line place
 * (an edge label) turns the break into a space.
 */
const BR = /<br\s*\/?>/gi;

/** A multi-line label (a box's or a subgraph's title): `<br/>` → `\n`. */
function multiline(label: string): string {
  return label
    .replace(BR, "\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

/** A one-line label (an edge's): `<br/>` → one space. */
function oneline(label: string): string {
  return label.replace(BR, " ").replace(/\s+/g, " ").trim();
}

/**
 * A node's own shape closes at its own depth: `A[x]` ends at the first `]`,
 * `A[x (y)]` at the last one. `null` when no closer matches the opener.
 */
function labelOf(rest: string, opener: string, closer: string): string | null {
  const inner = rest.slice(opener.length);
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    if (inner.startsWith(opener, i)) {
      depth++;
      i += opener.length - 1;
      continue;
    }
    if (inner.startsWith(closer, i)) {
      if (depth === 0) return inner.slice(0, i);
      depth--;
      i += closer.length - 1;
    }
  }
  return null;
}

/**
 * One node: a bare id, or an id with a shape and its label. `null` when the
 * chunk is anything else (`A & B`, an id Mermaid reserves, `A[x] y`).
 */
function nodeOf(chunk: string): DiagramNode | null {
  const text = chunk.trim();
  if (text === "" || text.includes("&")) return null;
  const id = /^[A-Za-z_][\w-]*/.exec(text)?.[0];
  if (id === undefined || RESERVED_IDS.has(id)) return null;
  const rest = text.slice(id.length).trim();
  if (rest === "") return { id, label: id, shape: "rect" };
  const shape = SHAPES.find((candidate) => rest.startsWith(candidate.opener));
  if (!shape) return null;
  const inner = labelOf(rest, shape.opener, shape.closer);
  if (inner === null) return null;
  // Nothing may follow the shape: `A[x] y` is not a node we model.
  if (rest.slice(shape.opener.length + inner.length + shape.closer.length).trim() !== "") {
    return null;
  }
  return { id, label: multiline(unquote(inner)), shape: shape.shape };
}

/**
 * The link operators, longest and most specific first: a text-carrying form
 * before the bare one, so `-- si -->` never reads as `--` + `-->`, and `==>`
 * before `===`.
 */
/** The link operators, longest and most specific first: a text-carrying form
 * before the bare one, so `-- si -->` never reads as `--` + `-->`, while a
 * **flowchart** link is required (an unknown arrow such as `--x` stays
 * unmodelled, and the client shows the source).
 */
const LINKS: readonly RegExp[] = [
  /^-->\|[^|\n]*\|/,
  /^-\.->\|[^|\n]*\|/,
  /^==>\|[^|\n]*\|/,
  /^---\|[^|\n]*\|/,
  /^-\.-\|[^|\n]*\|/,
  /^===\|[^|\n]*\|/,
  // Every link form a flowchart knows, a text-carrying one before its bare twin.
  /^--\s*[^>|\n-][^-|\n]*?\s*-->/,
  /^-\.\s*[^>|\n-][^-|\n]*?\s*\.->/,
  /^==\s*[^>|\n=][^=|\n]*?\s*==>/,
  /^-->/,
  /^---/,
  /^-\.->/,
  /^-\.-/,
  /^==>/,
  /^===/,
];

/** An edge operator, as the drawing needs it. */
function linkOf(operator: string): { style: EdgeStyle; arrow: boolean; label?: string } {
  const style: EdgeStyle = operator.startsWith("-.")
    ? "dotted"
    : operator.startsWith("==")
      ? "thick"
      : "solid";
  const piped = /^[^|]*?\|([^|]*)\|/.exec(operator);
  const inline = /^--\s*([^-|\n][^-|\n]*?)\s*-->$/.exec(operator);
  const label = unquote(piped?.[1] ?? inline?.[1] ?? "");
  const arrow = operator.includes(">");
  return { style, arrow, ...(oneline(label) === "" ? {} : { label: oneline(label) }) };
}

/** A statement that says nothing about the drawing (a directive, a style). */
function isIgnoredFlowStatement(trimmed: string): boolean {
  return (
    trimmed === "" ||
    trimmed.startsWith("%%") ||
    /^(?:direction|classDef|style|linkStyle|click|accTitle|accDescr)\b/.test(trimmed)
  );
}

/**
 * A statement split into its node chunks and the links between them, or `null`
 * when a link is missing or the statement steps outside the subset.
 */
function chainOf(statement: string): { chunks: string[]; links: string[] } | null {
  const chunks: string[] = [];
  const links: string[] = [];
  let rest = statement;
  let chunk = "";
  while (rest !== "") {
    const atTop = bracketIsClosed(chunk);
    const link = atTop ? LINKS.find((pattern) => pattern.test(rest)) : undefined;
    if (link === undefined) {
      chunk += rest[0] ?? "";
      rest = rest.slice(1);
      continue;
    }
    const operator = link.exec(rest)?.[0];
    if (operator === undefined) return null;
    chunks.push(chunk);
    links.push(operator);
    chunk = "";
    rest = rest.slice(operator.length);
  }
  chunks.push(chunk);
  return chunks.length === links.length + 1 ? { chunks, links } : null;
}

/** Whether every bracket a chunk opened is also closed (a link inside `[…]` counts). */
function bracketIsClosed(chunk: string): boolean {
  let depth = 0;
  let quote = false;
  for (const char of chunk) {
    if (char === '"') quote = !quote;
    if (quote) continue;
    if (char === "[" || char === "(" || char === "{") depth++;
    if (char === "]" || char === ")" || char === "}") depth--;
  }
  return depth <= 0;
}

/** The flowchart body, or `null` when it steps outside the modelled subset. */
function flowOf(lines: readonly string[]): FlowModel | null {
  const direction = (/\b(TB|TD|BT|RL|LR)\b/.exec((lines[0] ?? "").split(";")[0] ?? "")?.[1] ??
    "TD") as FlowDirection;
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const subgraphs: { title: string; nodes: string[] }[] = [];
  const byId = new Map<string, DiagramNode>();
  const open: { title: string; nodes: string[] }[] = [];

  // The type line carries statements too: `graph TD;A-->B;B-->C` is a whole
  // diagram on one line, and a body read only from line 2 would lose it.
  const typeHead = (lines[0] ?? "").split(";");
  const body = [...typeHead.slice(1), ...lines.slice(1)];

  const addNode = (node: DiagramNode): void => {
    const existing = byId.get(node.id);
    if (existing) {
      // A later `A[label]` renames the box; a bare `A` keeps what it had.
      if (node.label !== node.id && node.label !== existing.label) {
        byId.set(node.id, node);
        const index = nodes.findIndex((item) => item.id === node.id);
        if (index >= 0) nodes[index] = node;
      }
      return;
    }
    byId.set(node.id, node);
    nodes.push(node);
    for (const frame of open) frame.nodes.push(node.id);
  };

  for (const rawLine of body) {
    const trimmed = rawLine.trim();
    if (isIgnoredFlowStatement(trimmed)) continue;
    for (const statement of trimmed.split(";")) {
      const text = statement.trim();
      if (text === "" || isIgnoredFlowStatement(text)) continue;
      if (/^subgraph\b/.test(text)) {
        const frame = {
          title: subgraphTitle(text.replace(/^subgraph\s*/, "")),
          nodes: [] as string[],
        };
        subgraphs.push(frame);
        open.push(frame);
        continue;
      }
      if (text === "end") {
        if (open.pop() === undefined) return null;
        continue;
      }
      const chain = chainOf(text);
      if (!chain) return null;
      const parsed = chain.chunks.map(nodeOf);
      if (parsed.some((node) => node === null)) return null;
      for (const node of parsed) if (node) addNode(node);
      for (let i = 0; i < chain.links.length; i++) {
        const from = parsed[i];
        const to = parsed[i + 1];
        if (!from || !to) return null;
        edges.push({ ...linkOf(chain.links[i] ?? ""), from: from.id, to: to.id });
      }
    }
  }
  if (open.length > 0 || nodes.length === 0) return null;
  return { kind: "flowchart", direction, nodes, edges, subgraphs };
}

// ---------------------------------------------------------------------------
// Sequence
// ---------------------------------------------------------------------------

/** The arrows a sequence source may use (longest first) and what each means. */
const ARROWS: readonly { token: string; style: MessageStyle }[] = [
  { token: "-->>", style: "reply" },
  { token: "->>", style: "call" },
  { token: "-->", style: "reply" },
  { token: "->", style: "call" },
  { token: "--x", style: "cross" },
  { token: "-x", style: "cross" },
  { token: "--)", style: "cross" },
  { token: "-)", style: "cross" },
];

/** The block keywords a sequence source may open. `box`/`rect` are not modelled
 * (they wrap participants or paint a background: a construct we would have to
 * draw wrongly), so a source that uses one falls back to its source. */
const BLOCK_KEYWORDS: ReadonlySet<string> = new Set([
  "alt",
  "opt",
  "loop",
  "par",
  "critical",
  "break",
]);

/** One sequence message or note, or `null` for a construct we do not read. */
function messageOf(trimmed: string): SequenceMessage | null {
  const note =
    /^Note\s+(?:over|left of|right of)\s+([A-Za-z_][\w-]*)(?:\s*,\s*([A-Za-z_][\w-]*))?\s*:\s*(.*)$/.exec(
      trimmed,
    );
  if (note) {
    const from = note[1] ?? "";
    return { from, to: note[2] ?? from, text: note[3] ?? "", style: "call", note: true };
  }
  const arrow = ARROWS.find((candidate) => trimmed.includes(candidate.token));
  if (!arrow) return null;
  const [left, right] = splitOnce(trimmed, arrow.token);
  const from = left.replace(/[+-]$/, "").trim();
  const body = right.trim();
  const colon = body.indexOf(":");
  if (colon < 0) return null;
  const to = body.slice(0, colon).replace(/^[+-]/, "").trim();
  if (!/^[A-Za-z_][\w-]*$/.test(from) || !/^[A-Za-z_][\w-]*$/.test(to)) return null;
  return { from, to, text: body.slice(colon + 1).trim(), style: arrow.style, note: false };
}

/** `a -->> b` split at its first `-->>`, trimming both sides. */
function splitOnce(text: string, token: string): [string, string] {
  const at = text.indexOf(token);
  return [text.slice(0, at), text.slice(at + token.length)];
}

/** The sequence body, or `null` when it steps outside the modelled subset. */
function sequenceOf(lines: readonly string[]): SequenceModel | null {
  const participants: DiagramNode[] = [];
  const messages: SequenceMessage[] = [];
  const blocks: SequenceBlock[] = [];
  const byId = new Map<string, DiagramNode>();

  const add = (id: string, label?: string): void => {
    if (id === "") return;
    const existing = byId.get(id);
    if (existing) {
      if (label !== undefined && label !== existing.label) {
        byId.set(id, { ...existing, label });
        const index = participants.findIndex((item) => item.id === id);
        if (index >= 0) participants[index] = byId.get(id) as DiagramNode;
      }
      return;
    }
    const node: DiagramNode = { id, label: label ?? id, shape: "rect" };
    byId.set(id, node);
    participants.push(node);
  };

  // The type line may carry the first statement: `sequenceDiagram;A->>B: x`.
  const typeHead = (lines[0] ?? "").split(";");
  for (const rawLine of [...typeHead.slice(1), ...lines.slice(1)]) {
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("%%") || trimmed === "autonumber") continue;
    const declared = /^(?:participant|actor)\s+([A-Za-z_][\w-]*)(?:\s+as\s+(.+))?$/.exec(trimmed);
    if (declared) {
      add(declared[1] ?? "", declared[2] === undefined ? undefined : unquote(declared[2]));
      continue;
    }
    const keyword = /^([A-Za-z]+)\b\s*(.*)$/.exec(trimmed);
    if (keyword && BLOCK_KEYWORDS.has(keyword[1] ?? "")) {
      blocks.push({ kind: keyword[1] ?? "", title: unquote(keyword[2] ?? "") });
      continue;
    }
    if (
      /^(?:end|else|and|option|activate|deactivate|destroy|title|link|links|accTitle|accDescr)\b/.test(
        trimmed,
      )
    ) {
      continue;
    }
    const message = messageOf(trimmed);
    if (!message) return null;
    add(message.from);
    add(message.to);
    messages.push(message);
  }
  if (participants.length === 0) return null;
  return { kind: "sequence", participants, messages, blocks };
}

/**
 * Read a canonical source as far as this app models it: a flowchart, a sequence
 * diagram, or `other` (the type's name and its lines, for a source view — never
 * a guess).
 */
export function diagramModel(canonical: string, type: string): DiagramModel {
  const lines = canonical.split("\n");
  if (type === "flowchart") {
    const flow = flowOf(lines);
    if (flow) return flow;
  }
  if (type === "sequenceDiagram") {
    const sequence = sequenceOf(lines);
    if (sequence) return sequence;
  }
  return { kind: "other", type, lines };
}
