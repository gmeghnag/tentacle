/**
 * The status bar's and the input border's text, decided here (pure, no React;
 * docs/feat/tui-target-badge.md). Components only map these to elements.
 *
 * Everything is measured in terminal CELLS (`cells.ts`, `string-width`), never
 * code points: a double-width character must not push the ctx max off the line.
 */
import { cellWidth, headCells, tailCells, truncateCells } from "./cells.ts";
import { oneLine } from "./commands.ts";
import { formatTokens } from "./format.ts";
import type { TokenTotals } from "./state.ts";
import { type TargetBadge, minBadgeCells, targetParts, targetText } from "./target-view.ts";

const RULE = "─";
/** The leading dashes kept before the model name on the border. */
const MIN_LEAD = 4;

/**
 * The input's top border, decided by the DOCK'S FOCUS (docs/feat/subagent-panel.md,
 * UI revision — "one rule, three meanings, never two labelled rules stacked"):
 *
 * - `input` (the dock closed): `──── <model> ─`, exactly as before this task.
 * - the dropdown open: a PLAIN line — it is only the dropdown's bottom edge, and
 *   the dropdown's own top rule already carries the title AND every key.
 * - a child open: `─ → sa-N · enter sends · esc back ─────` — who Enter reaches,
 *   then what the keys do. NO model name here (the owner's refinement).
 *
 * The owner's rule behind all three: while the dock shows anything, the input
 * rule says nothing about the model. Where the dropdown has its own keys, this
 * rule says nothing at all.
 */
export type InputRule =
  | { readonly kind: "model" }
  | { readonly kind: "plain" }
  | { readonly kind: "target"; readonly id: string; readonly ended: boolean };

/** Below this width the target rule says `esc` for `esc back` (the mockups). */
const TARGET_RULE_TIER = 90;

/**
 * The rule's text for a focus: the model border, a plain line, or the target's.
 * Pure, so the three meanings are tested in one place (AGENTS §7).
 *
 * The target's own grammar is the mockup's `b.html`
 * (`─ → sa-1 · enter sends · esc back ─────────`): the words go LEFT, the rest is
 * the rule's fill. It is not `targetBorder`'s right-aligned shape — that put the
 * hint 150 cells away from the name it belongs to, which is part of what the owner
 * rejected. Exactly `width` cells; too narrow for the words → the target alone.
 */
export function inputRuleText(rule: InputRule, model: string, width: number): string {
  const w = Math.max(0, width);
  switch (rule.kind) {
    case "model":
      return modelBorder(model, w);
    case "plain":
      return RULE.repeat(w);
    case "target": {
      const keys = rule.ended
        ? " · esc back"
        : w >= TARGET_RULE_TIER
          ? " · enter sends · esc back"
          : " · enter sends · esc";
      const label = `─ → ${rule.id}${keys} `;
      if (cellWidth(label) > w) {
        // Too narrow for the keys: the target alone, then the fill.
        const bare = `─ → ${rule.id} `;
        return cellWidth(bare) > w ? RULE.repeat(w) : `${bare}${RULE.repeat(w - cellWidth(bare))}`;
      }
      return `${label}${RULE.repeat(w - cellWidth(label))}`;
    }
  }
}

/**
 * The input's top border carrying the model name, right-aligned:
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

/**
 * The input's top border while a background child is OPEN (docs/feat/subagent-panel.md):
 * `─ → sa-1 · explore ──────────────── esc back ─`. The target sits on the
 * LEFT (where `modelBorder`'s name never goes), so nobody sends to the wrong
 * agent; `right` is the key hint (`" esc back"`, or empty once it ended).
 * Exactly `width` cells; too narrow for a title → a plain rule.
 */
export function targetBorder(
  title: { readonly target: string; readonly sub: string },
  right: string,
  width: number,
): string {
  const w = Math.max(0, width);
  const label = title.sub === "" ? `─ ${title.target} ` : `─ ${title.target} · ${title.sub} `;
  const tail = right === "" ? ` ${RULE}` : ` ${right} ${RULE}`;
  const used = cellWidth(label) + cellWidth(tail);
  if (used > w) {
    // Too narrow even for the whole label: cut it by CELLS, keeping the target.
    const room = w - cellWidth(tail) - 1;
    if (room < 4) {
      return RULE.repeat(w);
    }
    const cut = truncateCells(label, room);
    const fill = Math.max(1, w - cellWidth(cut) - cellWidth(tail));
    return `${cut}${RULE.repeat(fill)}${tail}`;
  }
  return `${label}${RULE.repeat(w - used)}${tail}`;
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
  /**
   * What sits LEFT of `hint` on the right-hand side: the pill's text, already
   * composed (`status-view.ts`'s `pillText`), or `""` for no pill. It is painted
   * inside the same right-hand box as the auto-accept hint, and its COLUMN RANGE
   * is reported back (the owner: a mouse click on the pill opens the dropdown).
   */
  readonly pill?: string;
  /**
   * A focused pill's key hint (`enter open · esc back`), painted just LEFT of
   * the pill. It is part of the same right-hand box, so it is budgeted here —
   * otherwise it can be glued to the ctx figure on a line that is exactly wide
   * enough (`…/128kenter open · …`), which is a real frame defect.
   */
  readonly pillHint?: string;
  /** ` · ↑3 more (↓ to follow)` / ` · expanded` / `` — whole or dropped, never cut. */
  readonly suffix: string;
}

export interface StatusLayout {
  /** The link state exactly as painted (cut with `…`, with its ` · `); `""` without one. */
  readonly link: string;
  /** Cells of `link`. */
  readonly linkCells: number;
  /** The whole badge as painted (`prefix` + name); the component splits it at `badgePrefix`. */
  readonly badge: string | null;
  /** The badge's leading part, colon included (`kubernetes:` / `k8s:` / …): painted grey. */
  readonly badgePrefix: string;
  readonly path: string | null;
  readonly tokens: string | null;
  readonly compact: boolean;
  /** The scroll/expand hint when it fits whole; `""` when dropped. */
  readonly suffix: string;
  readonly hint: string | null;
  /**
   * The pill as painted, and its CELL range on the row `[start, end)` (0-based,
   * end exclusive) — `null` when there is no pill or it did not fit. A mouse
   * report's column is 1-based, so a click at `x` hits it when `start < x <= end`
   * (see `pillHit`). The range is what the drop-down's click needs: nothing else
   * on the last row is a control.
   */
  readonly pill: { readonly text: string; readonly start: number; readonly end: number } | null;
  /** The pill's hint as painted (just left of it), or `""`. */
  readonly pillHint: string;
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
  // The cut can land right after the text's own `…` (`reconnecting…`): no second one.
  const head = headCells(text, max - 1).trimEnd();
  return head.endsWith("…") ? head : `${head}…`;
}

/**
 * ONE row, decided here (pure; the component only paints it). When the line is
 * short things give way in this order: the PATH shrinks (to `MIN_PATH`), the
 * auto-accept hint goes, `↑ ↓` go, the meter loses its bar; the ctx figure WITH
 * its max always stays. The badge is whole unless it does not fit; the owner's
 * rule (`targetText`) uses `k8s:` for `kubernetes:` when it would be cut, cuts
 * its name, then name/container, then `k8s:…`; under the width where `k8s:…`
 * (5 cells; `docker:…` 8), the separator and the meter fit (26; docker 29), the
 * WHOLE badge goes. The scroll/expand hint comes AFTER the badge name: shown only
 * if it fits whole beside the whole badge, else omitted — it never cuts the name.
 * The link state beats the badge NAME (it keeps at least its first word) and is
 * dropped only when not even 4 cells are left (a line under ~22 columns).
 */
function layoutRow(input: StatusLayoutInput): StatusLayout {
  const width = Math.max(10, input.columns);
  const meterCells = cellWidth(meterText(input.meter, true));
  const target = input.target;
  // ONE line whatever the text carries (a stop reason may embed a daemon's message).
  const linkText = input.linkText ? oneLine(input.linkText) : "";
  const linkFull = linkText ? cellWidth(linkText) + SEP.length : 0;
  const linkMin = linkText ? Math.min(linkFull, cellWidth(firstWord(linkText)) + SEP.length) : 0;
  const badgeMin = target ? minBadgeCells(target) + SEP.length : 0;
  // The hint (` · ↑3 more …`) is whole or dropped (`statusLayout` also drops it
  // when it would cost the badge its name).
  const suffixCells = cellWidth(input.suffix);
  const suffix =
    input.suffix !== "" && width - meterCells - suffixCells >= linkMin + badgeMin
      ? input.suffix
      : "";
  const avail = width - meterCells - cellWidth(suffix);

  let badgeParts: { prefix: string; name: string } | null = null;
  let linkCells = 0;
  if (target !== null && avail >= badgeMin + linkMin) {
    if (!linkText) {
      badgeParts = targetParts(target, avail - SEP.length);
    } else if (linkFull + cellWidth(targetText(target)) + SEP.length <= avail) {
      linkCells = linkFull;
      badgeParts = targetParts(target);
    } else {
      // The link beats the badge NAME: it takes up to its share, never under its
      // first word, and leaves the badge at least `k8s:…`.
      linkCells = Math.min(
        linkFull,
        Math.max(linkMin, Math.floor(avail * LINK_SHARE)),
        avail - badgeMin,
      );
      badgeParts = targetParts(target, avail - linkCells - SEP.length);
    }
  } else if (linkText) {
    // No badge (it does not fit with the meter): the link gets what is left.
    linkCells = Math.min(linkFull, avail);
  }
  const link =
    linkText && linkCells - SEP.length >= 1
      ? `${cutLink(linkText, linkCells - SEP.length)}${SEP}`
      : "";
  const linkWidth = cellWidth(link);
  const badge = badgeParts === null ? null : `${badgeParts.prefix}${badgeParts.name}`;
  const badgePart = badge === null ? "" : `${badge}${SEP}`;

  const tokenText = input.tokens
    ? `↑${formatTokens(input.tokens.prompt)} ↓${formatTokens(input.tokens.completion)}`
    : null;
  // The pill rides the auto-accept side, right of it: `⏵⏵ auto-accept on · 2 agents ↓`.
  // Whole or dropped, like the suffix: a status line never wraps and never cuts
  // its last control in half. Its CELL RANGE is measured from the RIGHT edge,
  // because that box is flush right (`flexShrink 0` on the row's end).
  const pillTextRaw = input.pill ?? "";
  // The separator before the pill is the component's paint (`· `), so `auto-accept
  // on · 2 agents` reads as one sentence. The pill's own text here is the pill.
  const pillPart = pillTextRaw;
  const pillCells = cellWidth(pillTextRaw);
  const pillHintRaw = input.pillHint ?? "";
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
      (v.hint
        ? cellWidth(input.hint) +
          cellWidth(" · ") +
          cellWidth(pillPart) +
          (pillHintRaw === "" ? 0 : cellWidth(pillHintRaw) + 4)
        : 0) +
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
  // The pill needs the hint's slot (they are one box): without it, no pill.
  const pillFits = pillTextRaw !== "" && hint !== null;
  const pillHint = pillFits ? ` ${pillHintRaw}   ` : "";
  const pill = pillFits ? { text: pillTextRaw, start: width - pillCells, end: width } : null;
  const lead = [path, tokens].filter((p): p is string => p !== null && p !== "").join(SEP);
  const plain = `${link}${badgePart}${lead}${lead ? SEP : ""}${meterText(input.meter, v.compact)}${suffix}${
    // A focused pill's hint, then auto-accept, then ` · <pill>`: one box, and
    // `plain` says exactly what the component paints (the tests pin both).
    pillHint === "" ? "" : pillHint
  }${hint ?? ""}${pill === null ? "" : ` · ${pillPart}`}`;
  return {
    link,
    linkCells: linkWidth,
    badge,
    badgePrefix: badgeParts?.prefix ?? "",
    path,
    tokens,
    compact: v.compact,
    suffix,
    hint,
    pill,
    pillHint,
    plain,
  };
}

/**
 * Is the SGR click at `x` (1-based column) on the pill? The one rule the App
 * asks, so the hit test cannot drift from the layout that placed it.
 */
export function pillHit(layout: Pick<StatusLayout, "pill">, x: number): boolean {
  const pill = layout.pill;
  return pill !== null && x > pill.start && x <= pill.end;
}

export function statusLayout(input: StatusLayoutInput): StatusLayout {
  const first = layoutRow(input);
  const { target } = input;
  // The scroll/expand hint NEVER cuts the badge name (owner, final pass): if the
  // row with the hint cut or dropped the badge, the hint is the one to go.
  if (
    first.suffix !== "" &&
    target !== null &&
    (first.badge === null || cellWidth(first.badge) < cellWidth(targetText(target)))
  ) {
    return layoutRow({ ...input, suffix: "" });
  }
  return first;
}
