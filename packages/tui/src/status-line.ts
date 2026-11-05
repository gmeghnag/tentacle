/**
 * The status bar's and the input border's text, decided here (pure, no React;
 * docs/feat/tui-target-badge.md). Components only map these to elements.
 *
 * Everything is measured in terminal CELLS (`cells.ts`, `string-width`), never
 * code points: a double-width character must not push the ctx max off the line.
 */
import { cellWidth, headCells, tailCells } from "./cells.ts";
import { formatTokens } from "./format.ts";
import type { TokenTotals } from "./state.ts";
import { type TargetBadge, minBadgeCells, targetText } from "./target-view.ts";

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
  // " <model> ─": the model plus its two spaces and the closing dash.
  const room = w - 3 - MIN_LEAD;
  if (model === "" || room < 2) {
    return RULE.repeat(w);
  }
  const shown = cellWidth(model) <= room ? model : `…${tailCells(model, room - 1)}`;
  const lead = w - cellWidth(shown) - 3;
  return `${RULE.repeat(lead)} ${shown} ${RULE}`;
}

/** `cwd` with `$HOME` as `~`, at most `max` CELLS: over it, `…` + the tail. */
export function shortPath(cwd: string, home: string | undefined, max: number): string {
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  if (cellWidth(path) <= max) {
    return path;
  }
  if (max <= 1) {
    return "…".slice(0, Math.max(0, max));
  }
  return `…${tailCells(path, max - 1)}`;
}

const MIN_PATH = 8;
const MAX_PATH = 40;
const SEP = " · ";
/** The link may take at most this share of what the badge and the meter leave, while both fit. */
const LINK_SHARE = 0.6;

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
  /** ` · ↑3 more (↓ to follow)` / ` · expanded` / `` — whole or dropped, never cut. */
  readonly suffix: string;
}

export interface StatusLayout {
  /** The link state exactly as painted (cut with `…`, with its ` · `); `""` without one. */
  readonly link: string;
  /** Cells of `link`. */
  readonly linkCells: number;
  readonly badge: string | null;
  readonly path: string | null;
  readonly tokens: string | null;
  readonly compact: boolean;
  /** The scroll/expand hint when it fits whole; `""` when dropped. */
  readonly suffix: string;
  readonly hint: string | null;
  /** The whole row as plain text — exactly what the components paint, uncoloured. */
  readonly plain: string;
}

/** The first word of a link message (`disconnected: …` → `disconnected`). */
function firstWord(text: string): string {
  return /^[^\s:]+/.exec(text)?.[0] ?? text;
}

/** `text` in `max` cells: whole, else cut with `…` — never below its first word. */
function cutLink(text: string, max: number): string {
  if (cellWidth(text) <= max) {
    return text;
  }
  const word = firstWord(text);
  if (max <= cellWidth(word)) {
    return headCells(word, max);
  }
  return `${headCells(text, max - 1)}…`;
}

/**
 * ONE row, decided here (pure; the component only paints it). When the line is
 * short things give way in this order: the PATH shrinks (to `MIN_PATH`), the
 * auto-accept hint goes, `↑ ↓` go, the meter loses its bar; the ctx figure WITH
 * its max always stays. The badge is whole unless it does not fit; the owner's
 * rule (`targetText`) cuts its name, then name/container, then `pod…`; under
 * the width where `pod…`, the separator and the meter fit, the WHOLE badge goes.
 * The link state beats the badge NAME (it keeps at least its first word) and is
 * dropped only when not even 4 cells are left (a line under ~22 columns).
 */
export function statusLayout(input: StatusLayoutInput): StatusLayout {
  const width = Math.max(10, input.columns);
  const meterCells = cellWidth(meterText(input.meter, true));
  const target = input.target;
  const linkFull = input.linkText ? cellWidth(input.linkText) + SEP.length : 0;
  const linkMin = input.linkText
    ? Math.min(linkFull, cellWidth(firstWord(input.linkText)) + SEP.length)
    : 0;
  const badgeMin = target ? minBadgeCells(target) + SEP.length : 0;
  // The hint (` · ↑3 more …`) is whole or dropped; it is counted before the badge.
  const suffixCells = cellWidth(input.suffix);
  const suffix =
    input.suffix !== "" && width - meterCells - suffixCells >= linkMin + badgeMin
      ? input.suffix
      : "";
  const avail = width - meterCells - cellWidth(suffix);

  let badge: string | null = null;
  let linkCells = 0;
  if (target !== null && avail >= badgeMin + linkMin) {
    if (!input.linkText) {
      badge = targetText(target, avail - SEP.length);
    } else if (linkFull + cellWidth(targetText(target)) + SEP.length <= avail) {
      linkCells = linkFull;
      badge = targetText(target);
    } else {
      // The link beats the badge NAME: it takes up to its share, never under its
      // first word, and leaves the badge at least `pod…`.
      linkCells = Math.min(
        linkFull,
        Math.max(linkMin, Math.floor(avail * LINK_SHARE)),
        avail - badgeMin,
      );
      badge = targetText(target, avail - linkCells - SEP.length);
    }
  } else if (input.linkText) {
    // No badge (it does not fit with the meter): the link gets what is left.
    linkCells = Math.min(linkFull, avail);
  }
  const link =
    input.linkText && linkCells - SEP.length >= 1
      ? `${cutLink(input.linkText, linkCells - SEP.length)}${SEP}`
      : "";
  const linkWidth = cellWidth(link);
  const badgePart = badge === null ? "" : `${badge}${SEP}`;

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
      linkWidth +
      cellWidth(badgePart) +
      cellWidth(meterText(input.meter, v.compact)) +
      cellWidth(suffix) +
      (v.hint ? cellWidth(input.hint) : 0) +
      (v.tokens && tokenText ? cellWidth(tokenText) + SEP.length : 0);
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
  const plain = `${link}${badgePart}${lead}${lead ? SEP : ""}${meterText(input.meter, v.compact)}${suffix}${hint ?? ""}`;
  return {
    link,
    linkCells: linkWidth,
    badge,
    path,
    tokens,
    compact: v.compact,
    suffix,
    hint,
    plain,
  };
}
