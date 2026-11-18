/**
 * The Mermaid diagram types this app draws, and how a small model's spelling of
 * one becomes the real keyword (docs/feat/model-diagrams.md D3).
 *
 * Three sets, in one place because the lint, the tool's description and the
 * error sentences must agree:
 *  - {@link DIAGRAM_KEYWORDS}: what we draw.
 *  - the aliases a model reaches for (`sequence`, `state`, `er`, …).
 *  - what we deliberately refuse — numbers belong to `chart` (owner), and the
 *    rest is experimental or fetches icons from the network.
 */

/** The diagram types this app draws (v1, Owner Q4). */
export type DiagramType =
  | "flowchart"
  | "sequenceDiagram"
  | "classDiagram"
  | "stateDiagram"
  | "erDiagram"
  | "gantt"
  | "mindmap"
  | "timeline"
  | "journey"
  | "gitGraph";

/** The keyword each type is canonically written with, in the order errors list them. */
export const DIAGRAM_KEYWORDS: readonly string[] = [
  "flowchart",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "mindmap",
  "timeline",
  "journey",
  "gitGraph",
];

/** A misspelling a model habitually writes → the keyword we draw. */
const ALIASES: Readonly<Record<string, { type: DiagramType; keyword: string }>> = {
  flowchart: { type: "flowchart", keyword: "flowchart" },
  graph: { type: "flowchart", keyword: "flowchart" },
  "flowchart-v2": { type: "flowchart", keyword: "flowchart" },
  sequence: { type: "sequenceDiagram", keyword: "sequenceDiagram" },
  sequencediagram: { type: "sequenceDiagram", keyword: "sequenceDiagram" },
  class: { type: "classDiagram", keyword: "classDiagram" },
  classdiagram: { type: "classDiagram", keyword: "classDiagram" },
  state: { type: "stateDiagram", keyword: "stateDiagram-v2" },
  statediagram: { type: "stateDiagram", keyword: "stateDiagram-v2" },
  "statediagram-v2": { type: "stateDiagram", keyword: "stateDiagram-v2" },
  er: { type: "erDiagram", keyword: "erDiagram" },
  erdiagram: { type: "erDiagram", keyword: "erDiagram" },
  gantt: { type: "gantt", keyword: "gantt" },
  mindmap: { type: "mindmap", keyword: "mindmap" },
  timeline: { type: "timeline", keyword: "timeline" },
  journey: { type: "journey", keyword: "journey" },
  gitgraph: { type: "gitGraph", keyword: "gitGraph" },
};

/** Refused because the numbers belong to `chart` (owner: numbers stay there). */
const NUMBERS_TYPES: readonly string[] = [
  "pie",
  "xychart",
  "xychart-beta",
  "quadrantChart",
  "sankey",
  "sankey-beta",
  "radar",
  "radar-beta",
];

/** Refused as unsupported: experimental, or it fetches icons from the network. */
const UNSUPPORTED_TYPES: readonly string[] = [
  "architecture",
  "architecture-beta",
  "block",
  "block-beta",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "packet",
  "packet-beta",
  "kanban",
  "requirementDiagram",
  "zenuml",
  "info",
];

/** The keyword a source's first token names, and the type it stands for. */
export interface DiagramAlias {
  readonly type: DiagramType;
  readonly keyword: string;
}

/**
 * The type a first token names: the keyword itself, or an alias of it. `null`
 * for anything we do not draw (the caller refuses it with an explanation).
 */
export function aliasType(token: string): DiagramAlias | null {
  const lower = token.toLowerCase();
  const exact = ALIASES[lower];
  if (!exact) return null;
  return { type: exact.type, keyword: exact.keyword };
}

/** Whether the token is a numbers chart, which belongs to the `chart` tool. */
export function isRefusedNumbersType(token: string): boolean {
  const lower = token.toLowerCase();
  return NUMBERS_TYPES.some((type) => type.toLowerCase() === lower);
}

/** Whether the token is a Mermaid type we deliberately do not draw. */
export function isUnsupportedType(token: string): boolean {
  const lower = token.toLowerCase();
  return UNSUPPORTED_TYPES.some((type) => type.toLowerCase() === lower);
}

/** The closest allowed keyword, when the token is one edit away (`grpah`). */
export function nearestKeyword(token: string): string | null {
  const lower = token.toLowerCase();
  let best: string | null = null;
  let bestDistance = 3;
  for (const [alias, target] of Object.entries(ALIASES)) {
    const distance = levenshtein(lower, alias);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = target.keyword;
    }
  }
  return bestDistance <= 2 && best !== null ? best : null;
}

/** The sentence after `unknown diagram type "grpah" — `, for the model. */
export function describeUnknownType(token: string): string {
  const nearest = nearestKeyword(token);
  const hint = nearest === null ? "" : `did you mean "${nearest}"? `;
  return `${hint}Allowed: ${allowedList()}`;
}
/** The allowed types, as an error lists them. */
export function allowedList(): string {
  return "flowchart (graph), sequenceDiagram, classDiagram, stateDiagram, erDiagram, gantt, mindmap, timeline, journey, gitGraph";
}

/** Levenshtein distance, for "did you mean" only (never to accept a typo). */
function levenshtein(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const grid: number[] = new Array<number>(rows * cols).fill(0);
  for (let i = 0; i < rows; i++) grid[i * cols] = i;
  for (let j = 0; j < cols; j++) grid[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const above = grid[(i - 1) * cols + j] as number;
      const left = grid[i * cols + (j - 1)] as number;
      const diagonal = grid[(i - 1) * cols + (j - 1)] as number;
      grid[i * cols + j] = Math.min(above + 1, left + 1, diagonal + cost);
    }
  }
  return grid[(rows - 1) * cols + (cols - 1)] as number;
}
