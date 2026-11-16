/**
 * The model-facing JSON Schema of the chart spec (docs/feat/model-charts.md D2,
 * `json-schema.ts`). Hand-written and NOT derived from the validator, because
 * the model reads this one: its `description`s carry the rules that keep a small
 * model from the usual mistakes (one unit per chart, `null` for a gap, no
 * colours, the caps), and the runtime guard stays permissive so the plain-
 * sentence validator owns every error message (`Tool.jsonSchema`,
 * `packages/core/src/tool.ts`).
 *
 * The tool wires it as `jsonSchema`; `validateChartSpec` remains the truth.
 * Pure data: no I/O, no React.
 */
import { CHART_CAPS, CHART_TYPES } from "./spec.ts";

/** The chart tool's parameters, as the model sees them. */
export const CHART_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["type", "title", "datasets"],
  description:
    "A statistical chart drawn in the conversation. Values are plain numbers; styling is never part of the spec.",
  properties: {
    type: {
      type: "string",
      enum: [...CHART_TYPES],
      description:
        "line: a trend over ordered categories or time. bar: compare magnitudes, including negative ones. area: a trend whose total matters, or a stacked composition. pie/doughnut: shares of ONE series (exactly one dataset, no negatives). scatter: the relation between two numbers, given as {x, y} points.",
    },
    title: {
      type: "string",
      maxLength: CHART_CAPS.title,
      description: "The chart's heading, shown above it. Say what it shows, not how it looks.",
    },
    subtitle: {
      type: "string",
      maxLength: CHART_CAPS.subtitle,
      description:
        'Optional one line of context: period, source, cut-off — e.g. "€ · 2026 fino a ottobre".',
    },
    labels: {
      type: "array",
      maxItems: CHART_CAPS.points,
      description:
        'One label per value: categories ("gen"), ISO dates ("2026-03", "2026-03-01", "2026-03-01T14:00:00Z") when x.type is date, or numbers when x.type is number. Not needed when every dataset uses {x, y} points.',
      items: { type: ["string", "number"] },
    },
    datasets: {
      type: "array",
      minItems: 1,
      maxItems: CHART_CAPS.datasets,
      description: `1..${CHART_CAPS.datasets} series. Give each one a label: it is the legend, the callout and the table header.`,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "data"],
        properties: {
          label: {
            type: "string",
            maxLength: CHART_CAPS.seriesLabel,
            description: 'The series name, e.g. "2026".',
          },
          data: {
            type: "array",
            minItems: 1,
            maxItems: CHART_CAPS.points,
            description:
              'One value per label, in the same order, as NUMBERS (not strings: write 12.5, never "12.5" or "14,1"). Use null for a gap. For a scatter or a number/date axis you may use {x, y} points instead.',
            items: {
              anyOf: [
                { type: "number" },
                { type: "null" },
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["x", "y"],
                  properties: {
                    x: {
                      type: ["number", "string"],
                      description: "A number, or an ISO date when x.type is date.",
                    },
                    y: { type: ["number", "null"] },
                  },
                },
              ],
            },
          },
        },
      },
    },
    stacked: {
      type: "boolean",
      description: "bar and area only: stack the series (a total) instead of overlapping them.",
    },
    x: {
      type: "object",
      additionalProperties: false,
      description: "The horizontal axis. Its type decides how labels are read.",
      properties: {
        type: {
          type: "string",
          enum: ["category", "number", "date"],
          description:
            "category (default), number (a linear axis: labels or points are numbers), date (ISO dates).",
        },
        title: {
          type: "string",
          maxLength: CHART_CAPS.axisTitle,
          description: 'The quantity, e.g. "righe modificate".',
        },
        unit: {
          type: "string",
          description: 'e.g. "ms", "GB", "%". A unit belongs to an axis, never to a value.',
        },
        format: {
          type: "string",
          enum: ["compact", "full"],
          description:
            "compact: 12,5k. full: 12.500. Leave it out and the client picks by magnitude.",
        },
        decimals: {
          type: "integer",
          minimum: 0,
          maximum: 6,
          description: "How many decimals the data has.",
        },
      },
    },
    y: {
      type: "object",
      additionalProperties: false,
      description:
        "The vertical axis. ONE unit per chart: mixed units (€ and %) are two charts, never two axes.",
      properties: {
        title: {
          type: "string",
          maxLength: CHART_CAPS.axisTitle,
          description: 'The quantity, e.g. "latenza".',
        },
        unit: {
          type: "string",
          description: 'e.g. "€", "%", "ms". The unit goes here, not inside the values.',
        },
        format: {
          type: "string",
          enum: ["compact", "full"],
          description:
            "compact: 12,5k €. full: 12.500 €. Leave it out and the client picks by magnitude.",
        },
        decimals: {
          type: "integer",
          minimum: 0,
          maximum: 6,
          description: "How many decimals the data has.",
        },
      },
    },
  },
};
