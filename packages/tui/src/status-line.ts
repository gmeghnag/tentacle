/**
 * The status bar's and the input border's text, decided here (pure, no React;
 * docs/feat/tui-target-badge.md). Components only map these to elements.
 */
import { formatTokens } from "./format.ts";
import type { TokenTotals } from "./state.ts";
import { type TargetBadge, targetText } from "./target-view.ts";

const RULE = "─";
/** The leading dashes kept before the model name on the border. */
const MIN_LEAD = 4;

/**
 * The input field's top border carrying the model name, right-aligned:
 * `──── rits/deepseek-ai/DeepSeek-V4.1-Flash-1017 ─`. Exactly `width` cells.
 * Too long → cut on the LEFT with `…` (the tail of a model id is the part that
 * tells versions apart); no room for even a short name → a plain rule.
 */
export function modelBorder(model: string, width: number): string {
  const w = Math.max(0, width);
  const chars = [...model];
  // " <model> ─": the model plus its two spaces and the closing dash.
  const room = w - 3 - MIN_LEAD;
  if (chars.length === 0 || room < 2) {
    return RULE.repeat(w);
  }
  const shown =
    chars.length <= room ? model : `…${chars.slice(chars.length - (room - 1)).join("")}`;
  const lead = w - [...shown].length - 3;
  return `${RULE.repeat(lead)} ${shown} ${RULE}`;
}

/** `cwd` with `$HOME` as `~`, at most `max` cells: over it, `…` + the tail. */
export function shortPath(cwd: string, home: string | undefined, max: number): string {
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  const chars = [...path];
  if (chars.length <= max) {
    return path;
  }
  if (max <= 1) {
    return "…".slice(0, Math.max(0, max));
  }
  return `…${chars.slice(chars.length - (max - 1)).join("")}`;
}

const MIN_PATH = 8;
const MAX_PATH = 40;
/** Below this many cells the link state is dropped (a stub says nothing). */
const MIN_LINK = 6;
const SEP = " · ";

const METER_WIDTH = 10;

export type ContextMeterView =
  | { readonly kind: "unknown"; readonly max: string }
  | {
      readonly kind: "known";
      /** 0..1, for the bar's colour. */
      readonly fraction: number;
      /** Filled cells of the bar (of 10). */
      readonly filled: number;
      readonly percent: string;
      readonly used: string;
      readonly max: string;
    };

/**
 * The ctx meter's figures. The max is ALWAYS there; `approx` (an estimate, no
 * turn measured yet) marks the percent and the used count with `~`.
 */
export function contextMeterView(
  used: number | null,
  approx: boolean,
  window: number,
): ContextMeterView {
  const max = formatTokens(window);
  if (used === null) {
    return { kind: "unknown", max };
  }
  const fraction = window > 0 ? Math.min(1, Math.max(0, used / window)) : 0;
  const tilde = approx ? "~" : "";
  return {
    kind: "known",
    fraction,
    filled: Math.round(fraction * METER_WIDTH),
    percent: `${tilde}${Math.round(fraction * 100)}%`,
    used: `${tilde}${formatTokens(used)}`,
    max,
  };
}

export { METER_WIDTH };

/** The meter's plain text: with its bar, or `compact` (no bar). The max is always in it. */
export function meterText(view: ContextMeterView, compact: boolean): string {
  if (view.kind === "unknown") {
    return `ctx –/${view.max}`;
  }
  const figures = `${view.percent} (${view.used}/${view.max})`;
  return compact
    ? `ctx ${figures}`
    : `ctx ${"█".repeat(view.filled)}${"░".repeat(METER_WIDTH - view.filled)} ${figures}`;
}

export interface StatusLayoutInput {
  readonly columns: number;
  /** The link state's text (`reconnecting…`), shown first while the link is not up. */
  readonly linkText: string | null;
  readonly target: TargetBadge | null;
  readonly cwd: string;
  readonly home: string | undefined;
  /** `null`: not measured by this TUI yet — `↑ ↓` hidden. */
  readonly tokens: TokenTotals | null;
  readonly meter: ContextMeterView;
  /** The auto-accept indicator's text (it differs on/off). */
  readonly hint: string;
  /** ` · ↑3 more (↓ to follow)` / ` · expanded` / `` — counted, never cut. */
  readonly suffix: string;
}

export interface StatusLayout {
  /** Cells of the link box (its text, ` · `), 0 without a link. */
  readonly linkCells: number;
  readonly badge: string | null;
  readonly path: string | null;
  readonly tokens: string | null;
  readonly compact: boolean;
  readonly hint: string | null;
  /** The whole row as plain text (what the components render, uncoloured). */
  readonly plain: string;
}

const cells = (s: string): number => [...s].length;

/**
 * ONE row, decided here (pure; the component only paints it). The order in
 * which things give way when the line is short: the PATH shrinks first (down
 * to `MIN_PATH`), then the auto-accept hint is dropped, then `↑ ↓`, then the
 * meter loses its bar — the ctx figure WITH its max is always kept. The badge
 * is never cut unless it alone (with the compact meter) does not fit: then its
 * NAME is cut in the middle (`targetText`). The path may disappear last.
 */
export function statusLayout(input: StatusLayoutInput): StatusLayout {
  const width = Math.max(10, input.columns);
  const compactMeter = cells(meterText(input.meter, true));
  // The badge's room: the line minus its separator and the compact meter (the
  // ctx max is never traded for the badge, nor is the badge for the link).
  const badge = input.target
    ? targetText(input.target, Math.max(1, width - SEP.length - compactMeter))
    : null;
  const badgePart = badge === null ? "" : `${badge}${SEP}`;
  // The link state is transient and gives way FIRST: only what the badge and
  // the compact meter leave (cut with `…`); too little room → it is dropped.
  const linkRoom = width - cells(badgePart) - compactMeter;
  const linkCells =
    input.linkText && linkRoom >= MIN_LINK
      ? Math.min(cells(input.linkText) + SEP.length, Math.floor(width * 0.7), linkRoom)
      : 0;
  const linkBody = input.linkText ? [...input.linkText] : [];
  const link =
    linkCells === 0
      ? ""
      : `${
          linkBody.length + SEP.length <= linkCells
            ? linkBody.join("")
            : `${linkBody.slice(0, Math.max(0, linkCells - SEP.length - 1)).join("")}…`
        }${SEP}`;
  const tokenText = input.tokens
    ? `↑${formatTokens(input.tokens.prompt)} ↓${formatTokens(input.tokens.completion)}`
    : null;
  const variants = [
    { tokens: true, compact: false, hint: true },
    { tokens: true, compact: false, hint: false },
    { tokens: false, compact: false, hint: false },
    { tokens: false, compact: true, hint: false },
  ] as const;
  let chosen: { tokens: boolean; compact: boolean; hint: boolean; room: number } | null = null;
  for (const v of variants) {
    const others =
      linkCells +
      cells(badgePart) +
      cells(meterText(input.meter, v.compact)) +
      cells(input.suffix) +
      (v.hint ? cells(input.hint) : 0) +
      (v.tokens && tokenText ? cells(tokenText) + SEP.length : 0);
    // The path also needs its separator before the next part.
    const room = width - others - SEP.length;
    if (room >= MIN_PATH) {
      chosen = { ...v, room };
      break;
    }
  }
  // None leaves the path its minimum: the last variant, no path.
  const v = chosen ?? { tokens: false, compact: true, hint: false, room: 0 };
  const path = chosen ? shortPath(input.cwd, input.home, Math.min(MAX_PATH, chosen.room)) : null;
  const tokens = v.tokens ? tokenText : null;
  const hint = v.hint ? input.hint : null;
  const lead = [path, tokens].filter((p): p is string => p !== null && p !== "").join(SEP);
  const plain = `${link}${badgePart}${lead}${lead ? SEP : ""}${meterText(input.meter, v.compact)}${input.suffix}${hint ?? ""}`;
  return { linkCells, badge, path, tokens, compact: v.compact, hint, plain };
}
