/**
 * The model's `diagram` tool (docs/feat/model-diagrams.md D2): a Mermaid diagram,
 * drawn in the conversation where the model writes it.
 *
 * Like `chart`, this module does NOT draw. The source IS the tool call's
 * arguments, so each client draws inline from the row it already has (D1) and
 * re-lints it first (a pod can forge `rawInput`). The tool's job is the model's
 * feedback: lint (`lintDiagram`, pure, in core), then mermaid's own parse
 * (`parseMermaid`) so a diagram accepted here is one the clients can draw, each
 * failure rewritten as `line N[, col M]: <what> — <fix>` (`explainMermaidError`)
 * so a small model repairs it in one retry, and a success answered with the ONE
 * summary line (`summarizeDiagram`) that an old client also shows.
 *
 * `permission: "none"`: showing, never acting. Not offered to a child agent
 * (`subagent.ts`): a child's steps are not rows of the user's transcript.
 */
import type { Tool, ToolContext, ToolResult } from "@tentacle/core";
import {
  DIAGRAM_CAPS,
  diagramModel,
  explainMermaidError,
  lintDiagram,
  summarizeDiagram,
} from "@tentacle/core";
import { z } from "zod";
import { type MermaidParseOutcome, parseMermaid } from "./diagram-parse.ts";

export const DIAGRAM_TOOL_NAME = "diagram";

/** The caption's cap: it is a title, a gallery name and VoiceOver's opener. */
export const DIAGRAM_TITLE_MAX = 120;

/**
 * Appended to the registry's JSON error when the `mermaid` string itself broke
 * the JSON — a raw line break or a backtick-quoted source, the two ways a model
 * writes multi-line text into a JSON string.
 */
export const DIAGRAM_ARGUMENTS_HINT =
  '"mermaid" is ONE JSON string: write each line break as \\n and each " inside it as \\"';

/**
 * The registry's parse-failure hint, only when the text wears the mistake (a
 * wrong hint costs a retry): a literal line break before the `mermaid` value's
 * closing quote, or a backtick where its opening quote should be. Line breaks
 * BETWEEN keys (pretty-printed JSON) are valid and get nothing.
 */
export function diagramArgumentsHint(rawArguments: string): string | undefined {
  return /"mermaid"\s*:\s*(?:`|"[^"]*\n)/.test(rawArguments) ? DIAGRAM_ARGUMENTS_HINT : undefined;
}

export const DIAGRAM_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    title: {
      type: "string",
      minLength: 1,
      maxLength: DIAGRAM_TITLE_MAX,
      description: "A short caption, shown above the diagram.",
    },
    mermaid: {
      type: "string",
      maxLength: DIAGRAM_CAPS.bytes,
      description:
        'The Mermaid source, starting with its type line (e.g. "flowchart TD"). No Markdown fence, no %%{init}%%, no styling.',
    },
  },
  required: ["title", "mermaid"],
  additionalProperties: false,
};

const DESCRIPTION = `Draw a Mermaid diagram in the conversation: the user sees it inline, in the transcript.

When to use it: STRUCTURE — a flow or a decision, a sequence of messages, states, entity relations, a timeline or a plan. When not to: numbers (use the chart tool) or two boxes and an arrow (say it in a sentence). Keep it under ~40 nodes so it reads on a phone; split a bigger one.

Types: flowchart (or graph), sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, journey, gitGraph. No Markdown fences, no %%{init}%%, no style/classDef/colours — the app chooses theme and fonts. Quote a label that has ( ) [ ] { } or punctuation: A["Carica (sessione)"].

Example: {"title":"Login","mermaid":"flowchart TD\\n  A[Richiesta] --> B{Token valido?}\\n  B -->|si| C[Ok]\\n  B -->|no| D[Errore]"}

The source is checked with Mermaid's parser; an error names the line and the fix. Returns one line saying what the user now sees.`;

const inputSchema = z.record(z.unknown());

/** Every field error at once, each with its fix (a small model repairs them in one retry). */
function fieldErrors(input: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const title = input.title;
  if (typeof title !== "string" || title.trim() === "") {
    errors.push('"title" is required — a short caption, e.g. "Flusso di login"');
  } else if (title.trim().length > DIAGRAM_TITLE_MAX) {
    errors.push(`"title" is too long (${title.trim().length} > ${DIAGRAM_TITLE_MAX}) — shorten it`);
  }
  if (typeof input.mermaid !== "string") {
    errors.push(
      '"mermaid" must be the Mermaid source as one string, starting with its type line — e.g. "flowchart TD\\n  A --> B"',
    );
  }
  return errors;
}

/** A parse that did not succeed, as the sentences the model reads. */
function parseFailure(
  outcome: Exclude<MermaidParseOutcome, { ok: true }>,
  canonical: string,
  lineMap: readonly number[],
): string {
  switch (outcome.reason) {
    case "invalid":
      return explainMermaidError(outcome.error, canonical, lineMap).join("\n");
    case "unavailable":
      return "diagrams are not available in this build (the Mermaid parser could not be loaded) — describe the structure in text instead";
    default:
      return "the diagram is too complex to check — split it into two diagrams or group nodes into subgraphs";
  }
}

export interface DiagramToolOptions {
  /** Test seam: the daemon-side parse. Default: {@link parseMermaid}. */
  readonly parse?: (source: string) => Promise<MermaidParseOutcome>;
}

export function createDiagramTool(options: DiagramToolOptions = {}): Tool<Record<string, unknown>> {
  const parse = options.parse ?? ((source: string) => parseMermaid(source));
  return {
    name: DIAGRAM_TOOL_NAME,
    description: DESCRIPTION,
    // Permissive on purpose: the schema the model reads is the hand-written one,
    // and the plain-sentence checks own every error (plan P2, chart's pattern).
    inputSchema,
    jsonSchema: DIAGRAM_JSON_SCHEMA,
    argumentsHint: diagramArgumentsHint,
    permission: "none",
    // Touches no resource: two diagrams never conflict.
    concurrency: () => [],
    async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      const errors = fieldErrors(input);
      if (errors.length > 0) return { content: errors.join("\n"), isError: true };
      const title = String(input.title).trim();
      const lint = lintDiagram(String(input.mermaid));
      if (!lint.ok) return { content: lint.errors.join("\n"), isError: true };
      const outcome = await parse(lint.canonical);
      if (!outcome.ok) {
        return { content: parseFailure(outcome, lint.canonical, lint.lineMap), isError: true };
      }
      const model = diagramModel(lint.canonical, lint.type);
      return { content: summarizeDiagram(model, lint.type, { title, notes: lint.notes }).line };
    },
  };
}

export const diagramTool = createDiagramTool();
