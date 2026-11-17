/**
 * A `diagram` tool row on the phone (docs/feat/model-diagrams.md D5): the
 * decisions `ui/diagram/*` and the transcript branch need, pure and React-free
 * (AGENTS §7 "logic lives in pure modules").
 *
 * Owner rule, chart's (2026-11-16): a `diagram` call does NOT render as a tool
 * row — the diagram itself takes the row's place, with its title as a caption. A
 * call that is still running, one that FAILED (the daemon's mermaid refusal, or a
 * denial: our own gate is a lint, not mermaid's parser), and a source that does
 * not re-validate (a pod can forge `rawInput`) keep the generic tool row.
 *
 * The caption and the VoiceOver label come from core's ONE summary — the same
 * strings the tool's result line and the TUI caption use, so they cannot drift.
 */
import {
  type DiagramSource,
  type DiagramType,
  describeDiagram,
  diagramModel,
  lintDiagram,
} from "@tentacle/core";
import { type ChartScheme, chartScheme } from "./chart-row.ts";
import { diagramCacheKey } from "./diagram-cache.ts";
import { type ChartTokens, type Palette, chartTokensFor } from "./theme.ts";

/** The tool's name (`packages/tools/src/diagram.ts`). The app never imports `tools`. */
export const DIAGRAM_TOOL = "diagram";

/** The caption's own cap: the tool's `DIAGRAM_TITLE_MAX`, mirrored (the app has no `tools` dep). */
const TITLE_MAX = 120;

/** C0/C1 controls: a caption is drawn, so it never carries one. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;

/** The fields of a transcript tool row the decision reads. */
export interface DiagramToolRow {
  readonly name: string;
  readonly args: string;
  readonly status: string;
}

/** A validated call: its caption, its canonical source, and the type it is. */
export interface DiagramSpec {
  /** The caption, cleaned of control bytes. */
  readonly title: string;
  /** The canonical source (what every client draws: the lint's own form). */
  readonly source: DiagramSource;
  /** `flowchart`, `sequenceDiagram`, … (core's union). */
  readonly type: DiagramType;
}

/** The validated call when this tool row draws as a diagram; `null` → the generic row. */
export function diagramRowSpec(tool: DiagramToolRow): DiagramSpec | null {
  if (!drawsAsDiagram(tool)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(tool.args);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const { title, mermaid } = raw as Record<string, unknown>;
  if (typeof title !== "string" || typeof mermaid !== "string") return null;
  const caption = title.replace(CONTROLS, " ").trim();
  if (caption === "" || caption.length > TITLE_MAX) return null;
  // The client re-lints on every draw (a pod can forge `rawInput`, AGENTS §7): a
  // source this build refuses is not drawn, and the generic row says why.
  const source = lintDiagram(mermaid);
  return source.ok ? { title: caption, source, type: source.type } : null;
}

/** The name/status half of the decision (the source's validity is the other half). */
function drawsAsDiagram(tool: DiagramToolRow): boolean {
  return tool.name === DIAGRAM_TOOL && tool.status !== "error" && tool.status !== "denied";
}

/** The VoiceOver label (and the full screen's single accessibility element). */
export function diagramSummary(spec: DiagramSpec): string {
  const model = diagramModel(spec.source.canonical, spec.type);
  // The canonical source is NOT cleaned: the Sorgente tab must show what the model
  // wrote. The label is spoken, so core's sentence goes through the byte filter —
  // a label with a control byte in it is what a forged source would buy.
  return describeDiagram(model, spec.type, { title: spec.title }).replace(CONTROLS, " ");
}

export interface DiagramRowOptions {
  readonly palette: Palette;
  /** The iOS type scale: mermaid bakes text metrics into the SVG, so it is part of the render's key. */
  readonly fontScale: number;
}

export interface DiagramRowView {
  readonly title: string;
  /** The canonical source (the renderer draws it; the Sorgente tab shows it as-is). */
  readonly source: DiagramSource;
  readonly type: DiagramType;
  readonly scheme: ChartScheme;
  readonly tokens: ChartTokens;
  /**
   * The render's cache key (`diagramCacheKey`, D5's cache): the renderer is asked
   * for THIS key's render, and a scheme flip or a type-scale change is a new one
   * — which is why the two inputs are here and not read by the component.
   */
  readonly renderKey: string;
  /** VoiceOver: what the diagram is and what it says, one element (`describeDiagram`). */
  readonly accessibilityLabel: string;
}

/**
 * Render keys already computed, by arguments + scheme + type scale: a row
 * re-renders on every transcript update, and the key is a sha-256 over the whole
 * canonical source (up to 20 KiB). Bounded; the oldest entry goes first.
 */
const keyCache = new Map<string, string>();
const KEY_CACHE_MAX = 32;

function renderKeyFor(spec: DiagramSpec, scheme: ChartScheme, fontScale: number): string {
  const key = `${scheme}|${fontScale}|${spec.source.canonical}`;
  const hit = keyCache.get(key);
  if (hit !== undefined) return hit;
  const computed = diagramCacheKey(spec.source.canonical, scheme, fontScale);
  keyCache.set(key, computed);
  if (keyCache.size > KEY_CACHE_MAX) {
    const oldest = keyCache.keys().next().value;
    if (oldest !== undefined) keyCache.delete(oldest);
  }
  return computed;
}

/** Everything the diagram row draws, or `null` (not a diagram, invalid, failed). */
export function diagramRowView(
  tool: DiagramToolRow,
  options: DiagramRowOptions,
): DiagramRowView | null {
  const spec = diagramRowSpec(tool);
  if (spec === null) return null;
  const scheme = chartScheme(options.palette);
  return {
    title: spec.title,
    source: spec.source,
    type: spec.type,
    scheme,
    tokens: chartTokensFor(options.palette),
    renderKey: renderKeyFor(spec, scheme, options.fontScale),
    accessibilityLabel: diagramSummary(spec),
  };
}
