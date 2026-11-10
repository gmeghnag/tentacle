import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LinkIndicator } from "../link-status.ts";
import type { TokenTotals } from "../state.ts";
import { METER_WIDTH, contextMeterView, statusLayout } from "../status-line.ts";
import { type PillView, pillText } from "../status-view.ts";
import type { TargetBadge } from "../target-view.ts";
import { dimProps, palette } from "../theme.ts";

// The compact count lives in the pure `format.ts`; re-exported for callers.
export { formatTokens } from "../format.ts";

/** The context meter's bar colour: the mode's own green/yellow/red tokens. */
function meterColor(fraction: number): string {
  const meter = palette().meter;
  if (fraction >= 0.9) {
    return meter.high;
  }
  if (fraction >= 0.7) {
    return meter.mid;
  }
  return meter.low;
}

/**
 * A fixed-width context-fill meter: `ctx ████░░░░░░ 42% (54k/128k)`; an
 * estimate (no turn measured yet) reads `ctx █░░░░░░░░░ ~7% (~9k/128k)`; an
 * unknown fill reads `ctx –/128k`; `compact` drops the bar on a short line. The
 * figures come from `contextMeterView` (pure); the max is always there.
 */
export function ContextMeter({
  used,
  window,
  approx = false,
  compact = false,
}: {
  used: number | null;
  window: number;
  approx?: boolean;
  compact?: boolean;
}): ReactElement {
  const view = contextMeterView(used, approx, window);
  if (view.kind === "unknown") {
    return <Text {...dimProps()}>ctx –/{view.max}</Text>;
  }
  const bar = "█".repeat(view.filled) + "░".repeat(METER_WIDTH - view.filled);
  return (
    <Text>
      <Text {...dimProps()}>ctx </Text>
      {compact ? null : <Text color={meterColor(view.fraction)}>{bar}</Text>}
      <Text {...dimProps()}>
        {compact ? "" : " "}
        {view.percent} ({view.used}/{view.max})
      </Text>
    </Text>
  );
}

export function StatusBar({
  cwd,
  target = null,
  tokens,
  contextTokens,
  contextApprox = false,
  contextWindow,
  columns = 80,
  scrolledUp = false,
  hiddenAbove = 0,
  expandAll = false,
  autoApprove = false,
  pill = { kind: "none" },
  onPillRange,
  hint = null,
  link = null,
}: {
  cwd: string;
  /** In a container/pod: the accent badge at the left, never cut unless it alone does not fit. */
  target?: TargetBadge | null;
  /** `null`: not measured yet by this TUI — `↑ ↓` are hidden. */
  tokens: TokenTotals | null;
  /** `null`: nothing known yet, shown `ctx –/max`. */
  contextTokens: number | null;
  /** The figure is an estimate (no turn measured yet): shown with `~`. */
  contextApprox?: boolean;
  contextWindow: number;
  columns?: number;
  scrolledUp?: boolean;
  hiddenAbove?: number;
  expandAll?: boolean;
  autoApprove?: boolean;
  /**
   * The background work, as ONE pill after `auto-accept on`
   * (`status-view.ts`'s `pillView`; the owner's UI revision). `kind: "none"` =
   * nothing in the background, and the bar is exactly as before this task.
   * `targetBorder`/`statusHint` never replace the auto-accept indicator any more.
   */
  pill?: PillView;
  /**
   * Called with the pill's cell range on the row it just painted (`null` when it
   * painted none). The App's mouse handler is the one reader: a click inside it
   * opens the dropdown. This component reports; it decides nothing (§7).
   */
  onPillRange?: (range: { readonly start: number; readonly end: number } | null) => void;
  /**
   * Overrides the right-hand hint while a dock focus is active
   * (`enter sends to sa-1`); `null` keeps the auto-accept hint (the mockups).
   */
  hint?: string | null;
  /** The link's state when it is not up ("reconnecting…", "disconnected: …"). */
  link?: LinkIndicator | null;
}): ReactElement {
  const width = Math.max(10, columns);
  const hintText = autoApprove ? " ⏵⏵ auto-accept on " : " ⏵⏵ auto-accept off (shift+tab) ";
  const rightHint = hint ?? hintText;
  const suffix = scrolledUp
    ? ` · ↑${hiddenAbove} more (↓ to follow)`
    : expandAll
      ? " · expanded"
      : "";
  // The pill rides the right-hand box, AFTER the auto-accept indicator: it is one
  // more fact about the session, never a replacement for it (the owner's rule).
  const pillValue = pillText(pill);
  const meter = contextMeterView(contextTokens, contextApprox, contextWindow);
  // What is shown, and what gives way on a short line, is decided in the pure
  // `statusLayout` (the bar stays ONE row); this component only paints it.
  const layout = statusLayout({
    columns: width,
    linkText: link?.text ?? null,
    target,
    cwd,
    home: process.env.HOME,
    tokens,
    meter,
    hint: rightHint,
    suffix,
    pill: pillValue,
    pillHint: pill.kind === "pill" ? pill.hint : "",
  });
  // Report the range the layout placed the pill at (`null` when there is none):
  // the App's click handler needs exactly what was painted, never a re-derivation.
  onPillRange?.(layout.pill === null ? null : { start: layout.pill.start, end: layout.pill.end });
  const lead = [layout.path, layout.tokens].filter((p): p is string => p !== null && p !== "");
  return (
    <Box width={width}>
      {/* The link state first, as a SIBLING box: nested in the truncated Text
          below it kept the first render's width (docs/library-bugs.md, Ink
          nested-Text mis-measure). */}
      {link && layout.link !== "" ? (
        <Box flexShrink={0} width={layout.linkCells}>
          {/* The layout's own text (cut with `…`, with its separator): what
              `plain` says is what is painted. */}
          <Text
            color={link.tone === "error" ? palette().status.linkError : palette().status.linkWarn}
          >
            {layout.link}
          </Text>
        </Box>
      ) : null}
      {layout.badge !== null ? (
        <Box flexShrink={0}>
          {/* Prefix (colon included) grey, the name in the accent colour. */}
          <Text {...dimProps()}>{layout.badgePrefix}</Text>
          <Text color={palette().accent}>{layout.badge.slice(layout.badgePrefix.length)}</Text>
          <Text {...dimProps()}>{" · "}</Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          {lead.length > 0 ? <Text {...dimProps()}>{`${lead.join(" · ")} · `}</Text> : null}
          <ContextMeter
            used={contextTokens}
            window={contextWindow}
            approx={contextApprox}
            compact={layout.compact}
          />
          {layout.suffix === "" ? null : scrolledUp ? (
            <Text color={palette().status.scrolled}>{layout.suffix}</Text>
          ) : (
            <Text {...dimProps()}>{layout.suffix}</Text>
          )}
        </Text>
      </Box>
      {layout.hint !== null ? (
        <Box flexShrink={0}>
          {/* A focused pill's hint sits just LEFT of it, in the mockups' order:
              `⏵⏵ auto-accept on   enter open · esc back   2 agents ⏎`. It is the
              pill model's own `hint` (empty under the width tier), and it never
              replaces the auto-accept indicator. */}
          <Text {...dimProps()}>{layout.pillHint}</Text>
          {autoApprove && hint === null ? (
            <Text color={palette().autoAccept}>{layout.hint}</Text>
          ) : (
            <Text {...dimProps()}>{layout.hint}</Text>
          )}
          {/* The pill, painted from its STATE — the component picks the paint,
              never the words (`status-view.ts` decided those). Focused: inverse
              so it reads as a control; warning: it carries an ask; done: success;
              open/idle: the accent counts. Its `·` separator is the same one
              every other part of the bar uses. */}
          {layout.pill === null || pill.kind === "none" ? null : (
            <>
              <Text {...dimProps()}>{" · "}</Text>
              <Pill view={pill} text={layout.pill.text} />
            </>
          )}
        </Box>
      ) : null}
    </Box>
  );
}

/**
 * The status bar's one control. Its words and its state are `status-view.ts`'s;
 * this only maps the state to the palette (focused = inverse, ask = warning,
 * done = success, otherwise the accent).
 */
export function Pill({ view, text }: { view: PillView; text: string }): ReactElement | null {
  if (view.kind === "none") {
    return null;
  }
  const p = palette();
  if (view.state === "focus") {
    // INVERSE (the repo's idiom for a highlighted run: `input-view.ts`'s cursor,
    // `App`'s selection): SGR 7 swaps the terminal's own fg/bg, so the pill reads
    // as a control in both schemes WITHOUT a new colour token (the mockup paints
    // it accent-on-background, which is the same thing on a dark terminal).
    return (
      <Text inverse bold>
        {text}
      </Text>
    );
  }
  if (view.state === "ask") {
    return <Text color={p.warn}>{text}</Text>;
  }
  if (view.state === "done") {
    return <Text color={p.success}>{text}</Text>;
  }
  return <Text color={p.accent}>{text}</Text>;
}
