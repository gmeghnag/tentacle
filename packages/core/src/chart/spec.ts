/**
 * The chart spec: our own minimal, strict schema WITH the shape of Chart.js
 * (docs/feat/model-charts.md D2, owner decision 2026-11-16).
 *
 * It is NOT a wire schema — it rides a tool call's `rawInput: unknown`, so it
 * lives in `core` (imported by the tool, the TUI and the app) rather than in
 * `@tentacle/protocol`. Styling is deliberately absent: the clients decide it.
 *
 * `validateChartSpec` is the ONE reader of that unknown. It runs daemon-side (the
 * tool's error) and client-side (a pod can forge `rawInput`; an old row may
 * predate a cap change), and it speaks plain sentences with the fix, every error
 * at once, because a small model repairs a sentence and not a zod issue dump.
 *
 * Pure: no I/O, no React.
 */
import { type ParsedDate, datePositions, mixedDateKinds, parseIsoDates } from "./dates.ts";

export type ChartType = "line" | "bar" | "area" | "pie" | "doughnut" | "scatter";
export type XAxisType = "category" | "number" | "date";
export type AxisFormat = "compact" | "full";

/** The types in the order the error messages list them. */
export const CHART_TYPES: readonly ChartType[] = [
  "line",
  "bar",
  "area",
  "pie",
  "doughnut",
  "scatter",
];

/** `{x, y}` point form (scatter, and a number/date x): Chart.js' own. */
export interface ChartPoint {
  readonly x: number | string;
  readonly y: number | null;
}

export interface ChartDataset {
  readonly label: string;
  /** Plain values (one per label) or points — never both, one form per chart. */
  readonly data: readonly (number | null)[] | readonly ChartPoint[];
}

export interface ChartAxis {
  readonly title?: string;
  readonly unit?: string;
  readonly format?: AxisFormat;
  readonly decimals?: number;
}

export interface ChartXAxis extends ChartAxis {
  readonly type?: XAxisType;
}

export interface ChartSpec {
  readonly type: ChartType;
  readonly title: string;
  readonly subtitle?: string;
  readonly labels?: readonly (string | number)[];
  readonly datasets: readonly ChartDataset[];
  readonly stacked?: boolean;
  readonly x?: ChartXAxis;
  readonly y?: ChartAxis;
}

/** What the model may write: {@link validateChartSpec}'s two outcomes. */
export type ChartValidation =
  | {
      readonly ok: true;
      readonly spec: ChartSpec;
      /**
       * Remarks for the model about what was dropped — `ignored backgroundColor,
       * tension — the app chooses colours and styling`. Never an error: a
       * styling key costs a whole retry and draws nothing differently (Owner Q2).
       */
      readonly notes: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * The caps (Owner Q7). Every one of them names its advice in the error, so the
 * model folds/aggregates rather than resend the same too-big chart.
 */
export const CHART_CAPS = {
  /** Datasets per chart. */
  datasets: 8,
  /** Values (or points) per dataset, and labels. */
  points: 1000,
  /** Categories a bar chart draws (more is a line chart). */
  categories: 60,
  /** Bytes of canonical spec JSON. */
  bytes: 64 * 1024,
  /** Characters. */
  title: 120,
  subtitle: 160,
  seriesLabel: 60,
  axisTitle: 40,
  /** Errors reported at once (each with its fix). */
  errors: 8,
} as const;

/** The largest value a chart may hold exactly (beyond it, floating point lies). */
export const CHART_MAX_ABS_VALUE = 1e15;

/** The canonical spec's MIME type (the artifact version, D1). */
export const CHART_MIME_TYPE = "application/vnd.tentacle.chart+json";

/** Habitual Chart.js styling keys: dropped with a note, never an error (Owner Q2). */
const STYLE_KEYS: ReadonlySet<string> = new Set([
  "backgroundColor",
  "borderColor",
  "hoverBackgroundColor",
  "hoverBorderColor",
  "pointBackgroundColor",
  "pointBorderColor",
  "borderWidth",
  "borderRadius",
  "barThickness",
  "categoryPercentage",
  "barPercentage",
  "pointRadius",
  "pointHoverRadius",
  "pointStyle",
  "tension",
  "fill",
  "fillColor",
  "gradient",
  "cubicInterpolationMode",
  "stepped",
  "spanGaps",
  "showLine",
  "lineWidth",
  "color",
  "colors",
  "font",
  "labelColor",
  "opacity",
  "stroke",
  "strokeWidth",
  "theme",
  "legend",
  "animation",
]);

/** Chart.js habits that read as a chart and are not one (alias → the real type). */
const TYPE_ALIASES: Readonly<Record<string, ChartType>> = {
  column: "bar",
  columns: "bar",
  histogram: "bar",
  hist: "bar",
  bars: "bar",
  lines: "line",
  spline: "line",
  linechart: "line",
  donut: "doughnut",
  ring: "doughnut",
  piechart: "pie",
  points: "scatter",
};

const TOP_KEYS = ["type", "title", "subtitle", "labels", "datasets", "stacked", "x", "y"] as const;
const X_KEYS = ["type", "title", "unit", "format", "decimals"] as const;
const AXIS_KEYS = ["title", "unit", "format", "decimals"] as const;
const DATASET_KEYS = ["label", "data"] as const;

/** What a dashboard library would call a unit, glued or prefixed onto the number. */
const UNIT_AFFIX = /^([€$£¥])?\s*(-?[\d.,]+)\s*([a-zA-Z%]{1,3})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function levenshtein(a: string, b: string): number {
  const rows: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = rows[0] as number;
    rows[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = rows[j] as number;
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[j] = Math.min(current + 1, (rows[j - 1] as number) + 1, prev + cost);
      prev = current;
    }
  }
  return rows[b.length] as number;
}

/** What a string that should have been a number probably meant. */
interface NumericReading {
  readonly value: number;
  /** A unit the model glued on (`€`, `%`, `ms`): it belongs on the axis. */
  readonly unit?: string;
  /** A scale suffix (`k`, `M`, `G`) the model multiplied by — not a unit. */
  readonly multiplier?: number;
  /** Whether the decimal/thousands separators had to be reinterpreted. */
  readonly fixedSeparators: boolean;
}

const SCALE_SUFFIXES: Readonly<Record<string, number>> = {
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

/** `12.5`, `14,1`, `1.234,5`, `12k`, `€12` → the number the model meant, or null. */
function numericReading(raw: string): NumericReading | null {
  const m = UNIT_AFFIX.exec(raw.trim());
  if (!m) return null;
  const [, currency, core, suffix] = m;
  if (core === undefined) return null;
  let text = core;
  let fixedSeparators = false;
  if (text.includes(".") && text.includes(",")) {
    text = text.replace(/\./g, "").replace(",", ".");
    fixedSeparators = true;
  } else if (text.includes(",")) {
    // `14,1` is a decimal comma; `1,234` is a thousands group.
    const commaAt = text.lastIndexOf(",");
    const after = text.length - commaAt - 1;
    text = after === 3 ? text.replace(/,/g, "") : text.replace(",", ".");
    fixedSeparators = true;
  } else if ((text.match(/\./g) ?? []).length > 1) {
    text = text.replace(/\./g, "");
    fixedSeparators = true;
  }
  const value = Number.parseFloat(text);
  if (!Number.isFinite(value)) return null;
  if (suffix !== undefined && Object.hasOwn(SCALE_SUFFIXES, suffix)) {
    return { value, multiplier: SCALE_SUFFIXES[suffix], fixedSeparators };
  }
  const unit = suffix ?? currency;
  return { value, ...(unit === undefined ? {} : { unit }), fixedSeparators };
}

/**
 * The sentence for one value that is a string. It carries the corrected literal:
 * a model that reads `write the number 14.1` fixes it in one retry.
 */
function stringValueError(path: string, raw: string): string {
  if (parseIsoDates([raw])) {
    // A date in the VALUE slot: a date belongs in `labels`, and a value is a number.
    return `${path} is the date ${JSON.stringify(raw)} — labels hold dates; a value is a number (or null for a gap)`;
  }
  const reading = numericReading(raw);
  if (!reading)
    return `${path} is the string ${JSON.stringify(raw)} — write a number (or null for a gap)`;
  if (reading.multiplier !== undefined) {
    // "12k" is a scaled number, not a unit: the axis `format` is what prints it short.
    return `${path} is the string ${JSON.stringify(raw)} — write the plain number ${reading.value * reading.multiplier}, the axis format prints it short`;
  }
  if (reading.unit) {
    return `${path} is the string ${JSON.stringify(raw)} — write the plain number ${reading.value} and put ${JSON.stringify(reading.unit)} in y.unit`;
  }
  if (reading.fixedSeparators) {
    return `${path} is the string ${JSON.stringify(raw)} — write ${reading.value} (dot as decimal separator, no thousands separator)`;
  }
  return `${path} is the string ${JSON.stringify(raw)} — write the number ${reading.value} (no quotes)`;
}

/** The sentence for a `type` that is not one (with "did you mean" when close). */
function typeError(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const allowed = CHART_TYPES.join(", ");
  const alias = Object.hasOwn(TYPE_ALIASES, lower) ? TYPE_ALIASES[lower] : undefined;
  if (alias)
    return `unknown type ${JSON.stringify(raw)} — did you mean "${alias}"? Allowed: ${allowed}`;
  let best: { type: ChartType; distance: number } | null = null;
  for (const type of CHART_TYPES) {
    const distance = levenshtein(lower, type);
    if (!best || distance < best.distance) best = { type, distance };
  }
  if (best && best.distance <= 2) {
    return `unknown type ${JSON.stringify(raw)} — did you mean "${best.type}"? Allowed: ${allowed}`;
  }
  return `unknown type ${JSON.stringify(raw)} — allowed: ${allowed}`;
}

function tooLong(what: string, text: string, max: number): string | null {
  return [...text].length > max
    ? `${what} is ${[...text].length} characters (max ${max}) — shorten it`
    : null;
}

/** Bytes of the canonical spec JSON (the artifact version and the cap agree on it). */
export function chartSpecBytes(spec: ChartSpec): number {
  return new TextEncoder().encode(canonicalChartJson(spec)).length;
}

/**
 * The canonical serialization of a validated spec: field order fixed by this
 * file, absent optionals absent — so the same chart always has the same bytes
 * (the artifact's version identity, D1) and the cap is measured on what we store.
 */
export function canonicalChartJson(spec: ChartSpec): string {
  return JSON.stringify({
    type: spec.type,
    title: spec.title,
    ...(spec.subtitle === undefined ? {} : { subtitle: spec.subtitle }),
    ...(spec.labels === undefined ? {} : { labels: spec.labels }),
    datasets: spec.datasets.map((dataset) => ({ label: dataset.label, data: dataset.data })),
    ...(spec.stacked === undefined ? {} : { stacked: spec.stacked }),
    ...(spec.x === undefined ? {} : { x: spec.x }),
    ...(spec.y === undefined ? {} : { y: spec.y }),
  });
}

/**
 * The x axis type a chart actually plots on: the model's, else `number` for a
 * scatter, else `category`. No inference from label shape — predictable beats clever.
 */
export function effectiveXType(spec: ChartSpec): XAxisType {
  return spec.x?.type ?? (spec.type === "scatter" ? "number" : "category");
}

/** Whether a validated spec's data are `{x, y}` points rather than plain values. */
export function usesPoints(spec: ChartSpec): boolean {
  return spec.datasets.every((dataset) =>
    dataset.data.every((value) => typeof value === "object" && value !== null),
  );
}

/** The parsed date labels of a validated date-axis spec (validation already passed). */
export function specDates(spec: ChartSpec): ParsedDate[] {
  if (effectiveXType(spec) !== "date") return [];
  const points: (number | string)[] = [];
  for (const dataset of spec.datasets) {
    for (const value of dataset.data) {
      if (typeof value === "object" && value !== null) points.push(value.x);
    }
  }
  // A plain-value chart carries its dates on `labels`; a point-form one on `x`.
  const raws = points.length > 0 ? points : (spec.labels ?? []);
  return parseIsoDates(raws) ?? [];
}

/** Plot positions `0..1` for a validated spec's x (dates: elapsed time; else index). */
export function specXPositions(spec: ChartSpec): number[] {
  const effective = effectiveXType(spec);
  if (effective === "date") return datePositions(specDates(spec));
  const labels = spec.labels ?? [];
  if (effective === "number") {
    const xs = labels.length > 0 ? labels.map(Number) : pointFormValues(spec, "x").map(Number);
    return indexOrValuePositions(xs);
  }
  return labels.map((_, i) => (labels.length === 1 ? 0.5 : i / (labels.length - 1)));
}

function pointFormValues(spec: ChartSpec, field: "x" | "y"): (number | string)[] {
  const out: (number | string)[] = [];
  for (const dataset of spec.datasets) {
    for (const value of dataset.data) {
      if (typeof value === "object" && value !== null) out.push(value[field] ?? 0);
    }
  }
  return out;
}

function indexOrValuePositions(values: readonly number[]): number[] {
  if (values.length === 0) return [];
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return values.map(() => 0.5);
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  if (hi === lo) return values.map(() => 0.5);
  return values.map((v) => (v - lo) / (hi - lo));
}

/** One validation run's scratch state: the errors so far, the notes, the fixes. */
class SpecReader {
  readonly errors: string[] = [];
  readonly notes: string[] = [];
  private readonly ignored: string[] = [];

  fail(message: string): void {
    this.errors.push(message);
  }

  /** A styling key: dropped from the spec, remembered for the one note. */
  ignore(key: string): void {
    if (!this.ignored.includes(key)) this.ignored.push(key);
  }

  /** The single note that tells the model what it wrote that was dropped. */
  finishNotes(): void {
    if (this.ignored.length === 0) return;
    this.notes.push(`ignored ${this.ignored.join(", ")} — the app chooses colours and styling`);
  }

  /** Every key of `value` that is neither known nor a droppable styling key. */
  unknownFields(value: Record<string, unknown>, known: readonly string[], where?: string): void {
    const at = where ? ` at ${where}` : "";
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      if (STYLE_KEYS.has(key)) {
        this.ignore(key);
        continue;
      }
      // Chart.js' whole options bag: say where those settings went, because the
      // model that wrote it has a chart in mind and just needs the new shape.
      if (where === undefined && key === "options") {
        this.fail(
          '"options" is not used — put stacked at the top level and axis settings in "x"/"y" (unit, format, decimals, title)',
        );
        continue;
      }
      this.fail(`unknown field ${JSON.stringify(key)}${at} — allowed: ${known.join(", ")}`);
    }
  }
}

/** Read the `type`: the required one, with "did you mean" on a misspelling. */
function readType(reader: SpecReader, raw: Record<string, unknown>): ChartType | null {
  const value = raw.type;
  if (value === undefined) {
    reader.fail(`type is missing — allowed: ${CHART_TYPES.join(", ")}`);
    return null;
  }
  if (typeof value !== "string") {
    reader.fail(`type must be text — allowed: ${CHART_TYPES.join(", ")}`);
    return null;
  }
  if ((CHART_TYPES as readonly string[]).includes(value)) return value as ChartType;
  reader.fail(typeError(value));
  return null;
}

function readText(
  reader: SpecReader,
  raw: Record<string, unknown>,
  key: string,
  missing: string,
  max: number,
  path = key,
): string | undefined {
  const value = raw[key];
  if (value === undefined) {
    if (missing) reader.fail(missing);
    return undefined;
  }
  if (typeof value !== "string") {
    reader.fail(`${path} must be text — write it as a plain string`);
    return undefined;
  }
  const tooLongError = tooLong(path, value, max);
  if (tooLongError) {
    reader.fail(tooLongError);
    return undefined;
  }
  return value;
}

function readAxis(
  reader: SpecReader,
  raw: Record<string, unknown>,
  key: "x" | "y",
): ChartXAxis | ChartAxis | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    reader.fail(`${key} must be an object — e.g. {"unit": "€", "format": "compact"}`);
    return undefined;
  }
  reader.unknownFields(value, key === "x" ? X_KEYS : AXIS_KEYS, key);
  const axis: Record<string, unknown> = {};
  if (key === "x" && value.type !== undefined) {
    const type = value.type;
    if (type === "category" || type === "number" || type === "date") axis.type = type;
    else
      reader.fail(
        `${key}.type ${JSON.stringify(type)} is not valid — allowed: category, number, date`,
      );
  }
  if (value.title !== undefined) {
    if (typeof value.title !== "string")
      reader.fail(`${key}.title must be text — name the quantity`);
    else {
      const tooLongError = tooLong(`${key}.title`, value.title, CHART_CAPS.axisTitle);
      if (tooLongError) reader.fail(tooLongError);
      else axis.title = value.title;
    }
  }
  if (value.unit !== undefined) {
    if (typeof value.unit !== "string")
      reader.fail(`${key}.unit must be text — e.g. "€", "%", "ms"`);
    else axis.unit = value.unit;
  }
  if (value.format !== undefined) {
    if (value.format === "compact" || value.format === "full") axis.format = value.format;
    else {
      reader.fail(
        `${key}.format ${JSON.stringify(value.format)} is not valid — allowed: compact, full (or leave it out and the client picks)`,
      );
    }
  }
  if (value.decimals !== undefined) {
    const decimals = value.decimals;
    if (
      typeof decimals === "number" &&
      Number.isInteger(decimals) &&
      decimals >= 0 &&
      decimals <= 6
    ) {
      axis.decimals = decimals;
    } else {
      reader.fail(`${key}.decimals ${JSON.stringify(decimals)} is not valid — an integer 0..6`);
    }
  }
  return axis as ChartXAxis | ChartAxis;
}

/** Read one dataset's `data`, returning the sanitized form (or null on an error). */
function readData(
  reader: SpecReader,
  at: string,
  values: unknown[],
  xType: XAxisType,
  type: ChartType | null,
): (number | null)[] | ChartPoint[] | null {
  if (values.length === 0) {
    reader.fail(`${at} is empty — give at least one value per label`);
    return null;
  }
  if (values.length > CHART_CAPS.points) {
    reader.fail(
      `${at} has ${values.length} points (max ${CHART_CAPS.points} per series) — aggregate (e.g. per hour) or sample`,
    );
    return null;
  }
  const points = values.filter((value) => isRecord(value)).length;
  if (points > 0 && points < values.length) {
    reader.fail(`${at} mixes numbers and {x, y} points — use one form`);
    return null;
  }
  if (points > 0) {
    // The point form carries its own x, so it is only meaningful where x is a
    // number: a category axis (and a pie's slices) needs the `labels` form.
    if (type === "pie" || type === "doughnut") {
      reader.fail(
        `${at} uses {x, y} points — a ${type} takes one number per label (put the slice names in labels)`,
      );
      return null;
    }
    // Only for a KNOWN type: an unknown/missing `type` already fails, and a
    // second sentence about the axis is noise on a chart that cannot be drawn.
    if (type !== null && type !== "scatter" && xType === "category") {
      reader.fail(
        `${at} uses {x, y} points — the x axis must be numeric: add x: {"type": "number"} (or "date")`,
      );
      return null;
    }
    return readPoints(reader, at, values, xType);
  }
  return readNumbers(reader, at, values);
}

function readNumbers(reader: SpecReader, at: string, values: unknown[]): (number | null)[] | null {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    const path = `${at}[${i}]`;
    if (value === null) {
      out.push(null);
      continue;
    }
    if (typeof value === "string") {
      reader.fail(stringValueError(path, value));
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      reader.fail(`${path} is not a finite number — use null for a missing value`);
      continue;
    }
    if (Math.abs(value) > CHART_MAX_ABS_VALUE) {
      reader.fail(
        `${path} is too large to chart exactly — scale it (e.g. millions) and say so in y.unit`,
      );
      continue;
    }
    out.push(value);
  }
  if (out.length === values.length && out.every((value) => value === null)) {
    reader.fail(`${at} has no values (all null)`);
    return null;
  }
  return out.length === values.length ? out : null;
}

function readPoints(
  reader: SpecReader,
  at: string,
  values: unknown[],
  xType: XAxisType,
): ChartPoint[] | null {
  const out: ChartPoint[] = [];
  for (let i = 0; i < values.length; i++) {
    const path = `${at}[${i}]`;
    const value = values[i];
    if (!isRecord(value)) {
      reader.fail(`${path} is not a {x, y} point — write {"x": 1, "y": 2}`);
      continue;
    }
    reader.unknownFields(value, ["x", "y"], path);
    const { x, y } = value;
    if (typeof x !== "number" && typeof x !== "string") {
      reader.fail(`${path}.x is missing — write a number (or an ISO date when x.type is "date")`);
      continue;
    }
    if (typeof x === "number" && !Number.isFinite(x)) {
      reader.fail(`${path}.x is not a finite number — write a number`);
      continue;
    }
    if (xType === "number" && typeof x !== "number") {
      reader.fail(
        `${path}.x is the string ${JSON.stringify(x)} — x.type is "number", so give numbers`,
      );
      continue;
    }
    if (xType === "date" && !parseIsoDates([x])) {
      reader.fail(
        `${path}.x ${JSON.stringify(x)} is not an ISO date — write 2026-03-01 (or 2026-03, or 2026-03-01T14:00:00Z)`,
      );
      continue;
    }
    if (y === null) {
      out.push({ x, y: null });
      continue;
    }
    if (typeof y === "string") {
      reader.fail(stringValueError(`${path}.y`, y));
      continue;
    }
    if (typeof y !== "number" || !Number.isFinite(y)) {
      reader.fail(`${path}.y is not a finite number — use null for a missing value`);
      continue;
    }
    if (Math.abs(y) > CHART_MAX_ABS_VALUE) {
      reader.fail(
        `${path}.y is too large to chart exactly — scale it (e.g. millions) and say so in y.unit`,
      );
      continue;
    }
    out.push({ x, y });
  }
  if (out.length === values.length && out.every((point) => point.y === null)) {
    reader.fail(`${at} has no values (all null)`);
    return null;
  }
  return out.length === values.length ? out : null;
}

/** Read `labels` and check them against the x axis type. */
function readLabels(
  reader: SpecReader,
  raw: Record<string, unknown>,
  xType: XAxisType,
  needed: boolean,
): (string | number)[] | undefined {
  const value = raw.labels;
  if (value === undefined) {
    if (needed) {
      reader.fail(
        'labels is missing — line charts need one label per value (or use {x, y} points with x.type "number" or "date")',
      );
    }
    return undefined;
  }
  if (!Array.isArray(value)) {
    reader.fail('labels must be an array — one label per value, e.g. ["gen", "feb", "mar"]');
    return undefined;
  }
  if (value.length > CHART_CAPS.points) {
    reader.fail(
      `labels has ${value.length} entries (max ${CHART_CAPS.points} per series) — aggregate (e.g. per hour) or sample`,
    );
    return undefined;
  }
  if (xType === "date") return readDateLabels(reader, value);
  if (xType === "number") {
    for (let i = 0; i < value.length; i++) {
      const label = value[i];
      if (typeof label === "string") {
        reader.fail(
          `labels[${i}] is the string ${JSON.stringify(label)} — x.type is "number", so give numbers`,
        );
      } else if (typeof label !== "number" || !Number.isFinite(label)) {
        reader.fail(`labels[${i}] is not a finite number — x.type is "number", so give numbers`);
      }
    }
  }
  const out = value.filter((label): label is string | number => {
    return typeof label === "string" || (typeof label === "number" && Number.isFinite(label));
  });
  return out.length === value.length ? out : undefined;
}

function readDateLabels(reader: SpecReader, value: unknown[]): (string | number)[] | undefined {
  const dates = parseIsoDates(value);
  if (!dates) {
    for (let i = 0; i < value.length; i++) {
      if (parseIsoDates([value[i]])) continue;
      reader.fail(
        `labels[${i}] ${JSON.stringify(value[i])} is not an ISO date — write 2026-03-01 (or 2026-03, or 2026-03-01T14:00:00Z)`,
      );
    }
    return undefined;
  }
  const mixed = mixedDateKinds(dates);
  if (mixed) {
    reader.fail("labels mix dates and times — use one form");
    return undefined;
  }
  return value.filter(
    (label): label is string | number => typeof label === "string" || typeof label === "number",
  );
}

/**
 * Validate a raw chart spec (a tool call's arguments, a stored row's `args`).
 *
 * Every error names the path and the fix, all at once (≤ {@link CHART_CAPS.errors}),
 * so one retry is enough. A styling key is dropped and noted, never refused.
 */
export function validateChartSpec(raw: unknown): ChartValidation {
  const reader = new SpecReader();
  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: ["the chart spec must be an object — give type, title and datasets"],
    };
  }
  reader.unknownFields(raw, TOP_KEYS);

  const type = readType(reader, raw);
  const title = readText(
    reader,
    raw,
    "title",
    "title is missing — give the chart a short title (it is the transcript header)",
    CHART_CAPS.title,
  );
  const subtitle = readText(reader, raw, "subtitle", "", CHART_CAPS.subtitle);

  if (raw.stacked !== undefined && typeof raw.stacked !== "boolean") {
    reader.fail("stacked must be true or false — leave it out for separate bars/areas");
  }
  if (raw.stacked === true && type !== undefined && type !== "bar" && type !== "area") {
    reader.fail('stacked works with bar and area only — use type "area" with stacked: true');
  }

  const x = readAxis(reader, raw, "x");
  const y = readAxis(reader, raw, "y");
  const xType = (x as ChartXAxis | undefined)?.type ?? (type === "scatter" ? "number" : "category");

  const datasets = readDatasets(reader, raw, xType, type);
  // The form is read from the RAW input: a dataset that failed to parse must
  // still not make a pie look like a chart that needs labels.
  const forms = rawForms(raw);
  if (forms.includes("points") && forms.includes("values")) {
    reader.fail("datasets mix numbers and {x, y} points — use one form");
  }
  const points = forms.includes("points");
  const labels = readLabels(reader, raw, xType, needsLabels(type, points));

  // A bar's category count is its labels', or — in the point form — the values'
  // own x positions, which never pass through `labels`.
  const categories =
    type === "bar" && datasets
      ? (labels?.length ?? (points ? (datasets[0]?.data.length ?? 0) : 0))
      : 0;
  if (categories > CHART_CAPS.categories) {
    reader.fail(
      labels
        ? `labels has ${categories} categories (max ${CHART_CAPS.categories} for a bar chart) — fold the smallest into "Other" or use a line chart`
        : `datasets[0].data has ${categories} points (max ${CHART_CAPS.categories} categories for a bar chart) — fold the smallest into "Other" or use a line chart`,
    );
  }
  checkLengths(reader, type, datasets, labels);
  if (raw.stacked === true) checkAligned(reader, datasets);
  checkPie(reader, type, datasets);
  reader.finishNotes();

  if (reader.errors.length > 0)
    return { ok: false, errors: reader.errors.slice(0, CHART_CAPS.errors) };
  if (!type || title === undefined || !datasets) {
    return { ok: false, errors: ["the chart spec is incomplete — give type, title and datasets"] };
  }

  const spec: ChartSpec = {
    type,
    title,
    ...(subtitle === undefined ? {} : { subtitle }),
    ...(labels === undefined ? {} : { labels }),
    datasets,
    ...(raw.stacked === true ? { stacked: true } : {}),
    ...(x === undefined ? {} : { x: x as ChartXAxis }),
    ...(y === undefined ? {} : { y: y as ChartAxis }),
  };
  const bytes = chartSpecBytes(spec);
  if (bytes > CHART_CAPS.bytes) {
    return {
      ok: false,
      errors: [
        `the chart is too large (${Math.ceil(bytes / 1024)} KiB > 64 KiB) — aggregate, sample or split it`,
      ],
    };
  }
  return { ok: true, spec, notes: reader.notes };
}

/** Whether this chart needs `labels` at all: a point form carries its own x. */
function needsLabels(type: ChartType | null, points: boolean): boolean {
  return !points && type !== "scatter";
}

/**
 * The data form each dataset uses, read from the RAW arguments — before any of
 * them fails to parse, so a broken dataset still tells us what shape was meant.
 */
function rawForms(raw: Record<string, unknown>): ("points" | "values")[] {
  const datasets = raw.datasets;
  if (!Array.isArray(datasets)) return [];
  return datasets.map((entry): "points" | "values" => {
    const data = isRecord(entry) ? entry.data : undefined;
    return Array.isArray(data) && data.length > 0 && isRecord(data[0]) ? "points" : "values";
  });
}

function readDatasets(
  reader: SpecReader,
  raw: Record<string, unknown>,
  xType: XAxisType,
  type: ChartType | null,
): ChartDataset[] | null {
  const value = raw.datasets;
  if (value === undefined) {
    reader.fail("datasets is missing — give at least one series with at least one value");
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    reader.fail("datasets is empty — give at least one series with at least one value");
    return null;
  }
  if (value.length > CHART_CAPS.datasets) {
    reader.fail(
      `datasets has ${value.length} series (max ${CHART_CAPS.datasets}) — keep the 7 largest and fold the rest into "Other"`,
    );
    return null;
  }
  const out: ChartDataset[] = [];
  for (let i = 0; i < value.length; i++) {
    const at = `datasets[${i}]`;
    const entry = value[i];
    if (!isRecord(entry)) {
      reader.fail(`${at} is not an object — write {"label": "Ricavi", "data": [...]}`);
      continue;
    }
    reader.unknownFields(entry, DATASET_KEYS, at);
    const label = readText(
      reader,
      entry,
      "label",
      `${at}.label is missing — give each series a name`,
      CHART_CAPS.seriesLabel,
      `${at}.label`,
    );
    if (entry.data === undefined) {
      reader.fail(`${at}.data is missing — give one value per label (null for a gap)`);
      continue;
    }
    if (!Array.isArray(entry.data)) {
      reader.fail(`${at}.data must be an array — e.g. [12.5, 14.1, 13.8]`);
      continue;
    }
    const data = readData(reader, `${at}.data`, entry.data, xType, type);
    if (label === undefined || data === null) continue;
    out.push({ label, data });
  }
  return out.length === value.length ? out : null;
}

function checkLengths(
  reader: SpecReader,
  type: ChartType | null,
  datasets: ChartDataset[] | null,
  labels: (string | number)[] | undefined,
): void {
  if (!datasets || !labels) return;
  if (type === "scatter") return;
  for (let i = 0; i < datasets.length; i++) {
    const dataset = datasets[i];
    if (!dataset) continue;
    if (dataset.data.length > 0 && isRecord(dataset.data[0])) continue;
    if (dataset.data.length !== labels.length) {
      reader.fail(
        `datasets[${i}].data has ${dataset.data.length} values but labels has ${labels.length} — give one value per label (null for a gap)`,
      );
    }
  }
}

/** Whether a validated dataset's data are `{x, y}` points rather than plain values. */
function isPointForm(data: ChartDataset["data"]): data is readonly ChartPoint[] {
  return data.length > 0 && isRecord(data[0]);
}

/**
 * A stacked chart sums one column at a time, so its series must sit on the same
 * x. The plain values form is aligned by construction (one value per label); the
 * point form is not, and misaligned series stack into a lie.
 */
function checkAligned(reader: SpecReader, datasets: ChartDataset[] | null): void {
  if (!datasets || datasets.length < 2) return;
  const first = datasets[0];
  if (!first || !isPointForm(first.data)) return;
  const xs = first.data.map((point) => String(point.x));
  for (let i = 1; i < datasets.length; i++) {
    const dataset = datasets[i];
    if (!dataset || !isPointForm(dataset.data)) continue;
    const other = dataset.data.map((point) => String(point.x));
    if (other.length === xs.length && other.every((x, k) => x === xs[k])) continue;
    reader.fail(
      `datasets[${i}].data has different x values from datasets[0].data — a stacked chart sums one column at a time, so every series needs the same x (or use stacked: false)`,
    );
    return;
  }
}

function checkPie(
  reader: SpecReader,
  type: ChartType | null,
  datasets: ChartDataset[] | null,
): void {
  if (type !== "pie" && type !== "doughnut") return;
  if (!datasets) return;
  if (datasets.length !== 1) {
    reader.fail("pie/doughnut take exactly one dataset — make one chart per series");
    return;
  }
  const values = datasets[0]?.data ?? [];
  const numbers = values.map((value) =>
    typeof value === "object" && value !== null ? value.y : value,
  );
  const defined = numbers.filter((value): value is number => typeof value === "number");
  if (defined.some((value) => value < 0) || defined.every((value) => value === 0)) {
    reader.fail("pie values must be ≥ 0 and not all 0 — use a bar chart for signed values");
  }
}
