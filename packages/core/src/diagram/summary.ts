/**
 * The one summary of a diagram: what it shows, said in a sentence
 * (docs/feat/model-diagrams.md D5 — chart's `summary.ts` is the pattern).
 *
 * The same strings serve the tool's result line (what the model, and an old
 * client, reads), the phone's VoiceOver label and the TUI's caption — one place,
 * so they cannot drift.
 *
 * Pure: no I/O, no React.
 */
import type { DiagramModel, FlowModel, SequenceModel } from "./model.ts";
import type { DiagramType } from "./types.ts";

/** What a diagram says, one line each. */
export interface DiagramSummary {
  /** `flowchart "Flusso di login" · 6 nodes · 6 links` — the tool's result. */
  readonly line: string;
  /** The first few labels, for VoiceOver: `Richiesta → Token valido? → …`. */
  readonly shape: string;
}

/** The reading of a diagram, as a sentence: the tool's result line. */
export interface SummaryOptions {
  /** The diagram's caption (the tool's `title`). */
  readonly title: string;
  /** The validator's remarks (dropped styling, a stripped fence) — the model reads them. */
  readonly notes?: readonly string[];
}

/** `6 nodes`, `1 node`. */
function count(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

/** The drawing's direction, as a reader says it (`top to bottom`). */
function directionWord(direction: FlowModel["direction"]): string {
  switch (direction) {
    case "TD":
      return "top to bottom";
    case "BT":
      return "bottom to top";
    case "LR":
      return "left to right";
    default:
      return "right to left";
  }
}

/** The labels worth saying, in reading order: the box a reader starts from, then its targets. */
function flowShape(model: FlowModel): string {
  // A box's label may be several lines (`<br/>`, model.ts) and this is ONE
  // sentence (the tool's result, the phone's VoiceOver label): its lines join.
  const say = (id: string): string =>
    (model.nodes.find((node) => node.id === id)?.label ?? id).split("\n").join(" ");
  const targets = new Map<string, string | undefined>();
  for (const edge of model.edges) {
    if (!targets.has(edge.from)) targets.set(edge.from, edge.to);
  }
  const start =
    model.nodes.find((node) => !model.edges.some((edge) => edge.to === node.id))?.id ??
    model.nodes[0]?.id ??
    "";
  const walk: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = start;
  while (current !== undefined && !seen.has(current) && walk.length < 4) {
    seen.add(current);
    walk.push(say(current));
    current = targets.get(current);
  }
  return walk.join(" → ");
}

/** The messages worth saying: the first exchange, in order. */
function sequenceShape(model: SequenceModel): string {
  return model.messages
    .filter((message) => !message.note)
    .slice(0, 3)
    .map((message) => (message.text === "" ? `${message.from} → ${message.to}` : message.text))
    .join(" → ");
}

function describe(model: DiagramModel): { headline: string; shape: string } {
  switch (model.kind) {
    case "flowchart": {
      const frames =
        model.subgraphs.length === 0 ? "" : ` · ${count(model.subgraphs.length, "subgraph")}`;
      return {
        headline: `${count(model.nodes.length, "node")} · ${count(model.edges.length, "link")}${frames} · ${directionWord(model.direction)}`,
        shape: flowShape(model),
      };
    }
    case "sequence": {
      const blocks = model.blocks.length === 0 ? "" : ` · ${count(model.blocks.length, "block")}`;
      return {
        headline: `${count(model.participants.length, "participant")} · ${count(model.messages.length, "message")}${blocks}`,
        shape: sequenceShape(model),
      };
    }
    default: {
      // A type we do not model (class, gantt, ER…): its size is all we know,
      // plus the first line that says something beyond the type and its title.
      const lines = model.lines
        .slice(1)
        .map((line) => line.trim())
        .filter(
          (line) =>
            line !== "" && !line.startsWith("%%") && !/^(?:title|accTitle|accDescr)\b/.test(line),
        );
      return { headline: count(model.lines.length, "line"), shape: lines[0] ?? "" };
    }
  }
}

/**
 * The diagram as a sentence: `Diagram shown to the user: flowchart "Flusso di
 * login" · 6 nodes · 6 links` — the tool's result, and what an old client reads.
 */
export function summarizeDiagram(
  model: DiagramModel,
  type: DiagramType,
  options: SummaryOptions,
): DiagramSummary {
  const name = type === "flowchart" ? "flowchart" : type;
  const { headline, shape } = describe(model);
  const head = `${name} ${JSON.stringify(options.title)} · ${headline}`;
  const notes = options.notes ?? [];
  const line =
    notes.length > 0
      ? `Diagram shown to the user: ${head} · ${notes.join(" · ")}`
      : `Diagram shown to the user: ${head}`;
  return { line, shape };
}

/** The VoiceOver label: what it is, and what it says. */
export function describeDiagram(
  model: DiagramModel,
  type: DiagramType,
  options: SummaryOptions,
): string {
  const { shape } = summarizeDiagram(model, type, options);
  const what = type === "flowchart" ? "flowchart" : type;
  return shape === "" ? `${what} ${options.title}` : `${what} ${options.title}: ${shape}`;
}
