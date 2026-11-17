/**
 * Number and date formatting for chart labels (docs/feat/model-charts.md D4,
 * `format.ts`). Pure except for `Intl`, which puts the separators and the
 * currency placement in the reader's locale.
 *
 * The COMPACT suffixes are ours, not CLDR's: in Italian, `Intl`'s compact
 * notation prints `12500` as `13K` (precision lost) and `2.4e6` as `2,4 Mln`
 * (suffixes that change shape) — unusable on an axis (Context, `probe.ts`). So
 * `k`/`M`/`G`/`T` are ours and only the separators come from `Intl`.
 */

/** How a number should be written (the spec's `y`/`x` axis settings). */
export interface NumberFormat {
  /** `€`, `%`, `ms`, `GB` — placed per locale. */
  readonly unit?: string;
  /** `compact` (12,5k) or `full` (12.500); absent = auto by magnitude. */
  readonly format?: "compact" | "full";
  /** 0..6 — how many decimals the DATA has, which a client cannot guess. */
  readonly decimals?: number;
  /** BCP-47 tag; defaults to the host locale. */
  readonly locale?: string;
}

/** Currencies whose symbol the reader's locale may put before the number. */
const CURRENCY_SYMBOLS: ReadonlySet<string> = new Set(["€", "$", "£", "¥", "CHF"]);
/** Above this magnitude a compact suffix is worth the lost digits. */
const COMPACT_ABOVE = 10_000;

/** `1000 → ["k", 1e3]`, `-2.4e6 → ["M", 1e6]`. */
const COMPACT_STEPS: readonly (readonly [string, number])[] = [
  ["T", 1e12],
  ["G", 1e9],
  ["M", 1e6],
  ["k", 1e3],
];

/** Localized digits with `digits` decimals (or the fewest that are honest). */
function localize(value: number, locale: string, digits: number | undefined): string {
  // Grouping is SPELLED OUT: `it`'s default for a 4-digit integer is `9999`, and
  // an axis reading `9999` next to `12.500` looks like two different formats.
  const options: Intl.NumberFormatOptions = {
    useGrouping: true,
    ...(digits === undefined
      ? { maximumFractionDigits: 6 }
      : { minimumFractionDigits: digits, maximumFractionDigits: digits }),
  };
  return new Intl.NumberFormat(locale, options).format(value);
}

/** The compact form: one decimal under 100 (`12,5k`), none above (`123k`). */
function compact(
  value: number,
  locale: string,
  digits: number | undefined,
): { text: string; suffix: string } {
  const magnitude = Math.abs(value);
  const step = COMPACT_STEPS.find(([, size]) => magnitude >= size);
  if (!step) return { text: localize(value, locale, digits), suffix: "" };
  const [suffix, size] = step;
  const scaled = value / size;
  if (digits !== undefined) return { text: localize(scaled, locale, digits), suffix };
  // No fixed decimals: keep a decimal only where it says something (`12,5k`, not
  // `14,0k`) — a compact label is already an approximation, and a trailing zero
  // makes it read as an exact one.
  const text = new Intl.NumberFormat(locale, {
    useGrouping: true,
    maximumFractionDigits: Math.abs(scaled) < 100 ? 1 : 0,
  }).format(scaled);
  return { text, suffix };
}

/** Whether to write the compact form when the spec left `format` out. */
export function autoFormat(maxAbs: number): "compact" | "full" {
  return maxAbs >= COMPACT_ABOVE ? "compact" : "full";
}
/**
 * Whether this locale writes the currency BEFORE the number (`€12.5k` in `en`,
 * `12,5k €` in `it`). Asked of `Intl` rather than hard-coded, so a locale we did
 * not think of is still right.
 */
function currencyFirst(locale: string): boolean {
  const format = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
  // Hermes on iOS (Apple's Intl) has no `formatToParts`: calling it threw a
  // TypeError and crashed the chart's row (docs/fix/mobile-qa-sweep.md). Read
  // the side off the plain string instead — the symbol is the first character
  // that is neither a digit, a separator nor a sign.
  if (typeof format.formatToParts !== "function") {
    const text = format.format(1);
    const symbolAt = text.search(/[^\d\s.,'  +\-−]/u);
    return symbolAt >= 0 && symbolAt < text.search(/\d/);
  }
  const parts = format.formatToParts(1);
  const currencyAt = parts.findIndex((part) => part.type === "currency");
  const numberAt = parts.findIndex((part) => part.type === "integer" || part.type === "decimal");
  return currencyAt >= 0 && currencyAt < numberAt;
}

/**
 * A number as a chart label: `12,5k €` (it) / `€12.5k` (en), `999`, `−1,3M`.
 *
 * The minus sign is U+2212 (a typographic minus reads as a sign; a hyphen reads
 * as a dash in a column of numbers). Below 1 000 the compact form falls back to
 * the full one, so a tiny value never prints as `0k`.
 */
export function formatNumber(value: number, format: NumberFormat = {}): string {
  const locale = format.locale ?? "en";
  const negative = value < 0 && value !== 0;
  const magnitude = Math.abs(value);
  const mode = format.format ?? autoFormat(magnitude);
  const { text, suffix } =
    mode === "compact" && magnitude >= 1000
      ? compact(magnitude, locale, format.decimals)
      : { text: localize(magnitude, locale, format.decimals), suffix: "" };
  const body = `${text}${suffix}`;
  const unit = format.unit;
  const signed = negative ? `−${body}` : body;
  if (!unit) return signed;
  if (unit === "%") return `${signed}%`;
  if (CURRENCY_SYMBOLS.has(unit)) {
    return currencyFirst(locale) ? `${negative ? "−" : ""}${unit}${body}` : `${signed} ${unit}`;
  }
  return `${signed} ${unit}`;
}

/** A formatted number split from its unit, so a hero can style the unit smaller. */
export interface NumberParts {
  /** `20.800`, `−1,3M` — the signed number, no unit. */
  readonly number: string;
  /** `€`, `%`, `ms`, or `""`. */
  readonly unit: string;
  /** The locale writes the unit first (`€20,800` in `en`). */
  readonly unitBefore: boolean;
}

/**
 * {@link formatNumber}, in parts: the same digits and the same unit side, so
 * `number` + `unit` joined reads exactly as `formatNumber` would write it.
 */
export function formatParts(value: number, format: NumberFormat = {}): NumberParts {
  const { unit: _unit, ...bare } = format;
  const number = formatNumber(value, bare);
  const unit = format.unit ?? "";
  const unitBefore =
    unit !== "" && CURRENCY_SYMBOLS.has(unit) && currencyFirst(format.locale ?? "en");
  return { number, unit, unitBefore };
}

/**
 * A date label at the granularity it was written with — `2026`, `mar 2026`,
 * `1 mar`, `14:00`, `14:00:05` — in the reader's locale and zone.
 */
export function formatDate(
  ms: number,
  granularity: "year" | "month" | "day" | "minute" | "second",
  options: { readonly locale?: string; readonly zone?: string } = {},
): string {
  const locale = options.locale ?? "en";
  const timeZone = options.zone;
  const date = new Date(ms);
  const formats: Record<typeof granularity, Intl.DateTimeFormatOptions> = {
    year: { year: "numeric", timeZone },
    month: { month: "short", year: "numeric", timeZone },
    day: { day: "numeric", month: "short", timeZone },
    minute: { hour: "2-digit", minute: "2-digit", timeZone },
    second: { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone },
  };
  return new Intl.DateTimeFormat(locale, formats[granularity]).format(date);
}

/** The zone a chart caption names when it differs from the reader's own. */
export function zoneLabel(zone: string): string {
  return zone === "UTC" ? "UTC" : zone;
}

/** A percentage for a slice/legend: `37,5%` — one decimal only when it has one. */
export function formatPercent(ratio: number, locale = "en"): string {
  const percent = ratio * 100;
  const digits = Math.abs(percent - Math.round(percent)) < 0.05 ? 0 : 1;
  return `${localize(percent, locale, digits)}%`;
}
