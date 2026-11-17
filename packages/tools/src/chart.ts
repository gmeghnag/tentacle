/**
 * The model's `chart` tool (docs/feat/model-charts.md D3): the numbers it talks
 * about, drawn in the conversation instead of quoted.
 *
 * What this module does NOT do is draw. The spec IS the tool call's arguments,
 * so each client renders inline from the row it already has (D1) — live and
 * after a reload, on every runtime — and nothing here needs the wire, an
 * artifact read or a protocol bump. The tool's own job is the model's feedback:
 * validate, say what was dropped, and answer with the ONE summary line
 * (`summarizeChart`) that the model reads and that an old client shows as the
 * call's result.
 *
 * `permission: "none"`: a chart is showing, never acting (AGENTS §7 — a pod can
 * forge the arguments, and a client re-validates before drawing, so the worst a
 * forgery does is draw nothing).
 */
import type { Tool, ToolContext, ToolResult } from "@tentacle/core";
import { CHART_JSON_SCHEMA, summarizeChart, validateChartSpec } from "@tentacle/core";
import { z } from "zod";

export const CHART_TOOL_NAME = "chart";

/**
 * Appended to the registry's JSON error when the raw arguments carry a literal
 * JSON cannot express — `NaN`, `Infinity`, `undefined` are what a model writes
 * for a gap, and the registry's own sentence does not say what to write instead.
 */
export const CHART_ARGUMENTS_HINT = "NaN/Infinity are not JSON — use null for a missing value";

/**
 * The registry's parse-failure hint, only when the text wears the mistake —
 * matched on the RAW text (D3), so a plain typo (a missing brace) gets no
 * diagnosis it does not deserve: a wrong hint costs a retry and teaches the
 * wrong lesson.
 */
export function chartArgumentsHint(rawArguments: string): string | undefined {
  return /\b(NaN|Infinity|undefined)\b/.test(rawArguments) ? CHART_ARGUMENTS_HINT : undefined;
}

const DESCRIPTION = `Draw a chart in the conversation: the user sees it inline, in the transcript.

When to use it: numbers the user will COMPARE — a trend over time, shares of a whole, a ranking, a distribution. When not to: one or two numbers (say them in a sentence) or a list of exact values to look up (write a Markdown table). One unit per chart: mixed units are two charts, never two axes. Aggregate to at most ~200 points when you can; the client downsamples anything longer but says less.

The shape (Chart.js' shape — styling is NEVER part of it, the app chooses colours, widths and fonts):
{"type":"line","title":"Ricavi 2026","subtitle":"€ · fino a ottobre","labels":["gen","feb","mar"],"datasets":[{"label":"Ricavi","data":[12.5,14.1,13.8]}],"y":{"unit":"€","format":"compact"},"x":{"type":"category"}}

type: line (a trend), bar (compare magnitudes, negatives allowed), area (a trend whose total matters, or a stacked composition), pie/doughnut (shares of ONE series), scatter ({x,y} points). Values are plain NUMBERS — write 12.5, never "12.5" or "14,1" — and null for a gap. Axis settings go in "x"/"y": unit ("€", "ms", "%"), format ("compact" for 12,5k or "full" for 12.500), decimals, title. Date axes take ISO labels (2026-03, 2026-03-01, 2026-03-01T14:00:00Z).

Returns one line saying what the user now sees; the chart itself is drawn by the client from these arguments.`;

const inputSchema = z.record(z.unknown());

export const chartTool: Tool<Record<string, unknown>> = {
  name: CHART_TOOL_NAME,
  description: DESCRIPTION,
  // Permissive on purpose: the real schema is the hand-written one the model
  // reads (`jsonSchema`), and the plain-sentence validator owns every error
  // (AGENTS §7, plan P2).
  inputSchema,
  jsonSchema: CHART_JSON_SCHEMA,
  argumentsHint: chartArgumentsHint,
  permission: "none",
  // A chart touches no resource: it writes nothing, reads nothing, and two of
  // them never conflict (the round executor may run them together).
  concurrency: () => [],
  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const validation = validateChartSpec(input);
    if (!validation.ok) {
      // Every error at once, each with its fix: a small model repairs it in one
      // retry instead of rediscovering the same mistake.
      return { content: validation.errors.join("\n"), isError: true };
    }
    return { content: summarizeChart(validation.spec, { notes: validation.notes }).line };
  },
};
