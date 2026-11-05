import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { LinkIndicator } from "../link-status.ts";
import type { TokenTotals } from "../state.ts";
import { METER_WIDTH, contextMeterView, statusLayout } from "../status-line.ts";
import type { TargetBadge } from "../target-view.ts";
import { accentHex } from "../theme.ts";

// The compact count lives in the pure `format.ts`; re-exported for callers.
export { formatTokens } from "../format.ts";

function meterColor(fraction: number): string {
  if (fraction >= 0.9) {
    return "red";
  }
  if (fraction >= 0.7) {
    return "yellow";
  }
  return "green";
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
    return <Text dimColor>ctx –/{view.max}</Text>;
  }
  const bar = "█".repeat(view.filled) + "░".repeat(METER_WIDTH - view.filled);
  return (
    <Text>
      <Text dimColor>ctx </Text>
      {compact ? null : <Text color={meterColor(view.fraction)}>{bar}</Text>}
      <Text dimColor>
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
  /** The link's state when it is not up ("reconnecting…", "disconnected: …"). */
  link?: LinkIndicator | null;
}): ReactElement {
  const width = Math.max(10, columns);
  const hintText = autoApprove ? " ⏵⏵ auto-accept on " : " ⏵⏵ auto-accept off (shift+tab) ";
  const suffix = scrolledUp
    ? ` · ↑${hiddenAbove} more (↓ to follow)`
    : expandAll
      ? " · expanded"
      : "";
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
    hint: hintText,
    suffix,
  });
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
          <Text color={link.tone === "error" ? "red" : "yellow"}>{layout.link}</Text>
        </Box>
      ) : null}
      {layout.badge !== null ? (
        <Box flexShrink={0}>
          <Text color={accentHex}>{layout.badge}</Text>
          <Text dimColor>{" · "}</Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          {lead.length > 0 ? <Text dimColor>{`${lead.join(" · ")} · `}</Text> : null}
          <ContextMeter
            used={contextTokens}
            window={contextWindow}
            approx={contextApprox}
            compact={layout.compact}
          />
          {layout.suffix === "" ? null : scrolledUp ? (
            <Text color="yellow">{layout.suffix}</Text>
          ) : (
            <Text dimColor>{layout.suffix}</Text>
          )}
        </Text>
      </Box>
      {layout.hint !== null ? (
        <Box flexShrink={0}>
          {autoApprove ? (
            <Text color={accentHex}>{layout.hint}</Text>
          ) : (
            <Text dimColor>{layout.hint}</Text>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
