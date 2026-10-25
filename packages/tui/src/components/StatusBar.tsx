import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { formatTokens } from "../format.ts";
import type { LinkIndicator } from "../link-status.ts";
import type { TokenTotals } from "../state.ts";
import { accentHex } from "../theme.ts";

function shortCwd(cwd: string): string {
  const home = process.env.HOME;
  const path = home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
  return path.length > 40 ? `…${path.slice(-39)}` : path;
}

// The compact count lives in the pure `format.ts`; re-exported for callers.
export { formatTokens } from "../format.ts";

const METER_WIDTH = 10;

function meterColor(fraction: number): string {
  if (fraction >= 0.9) {
    return "red";
  }
  if (fraction >= 0.7) {
    return "yellow";
  }
  return "green";
}

/** A fixed-width context-fill meter: `ctx ████░░░░░░ 42% (54k/128k)`. */
export function ContextMeter({ used, window }: { used: number; window: number }): ReactElement {
  const fraction = window > 0 ? Math.min(1, Math.max(0, used / window)) : 0;
  const filled = Math.round(fraction * METER_WIDTH);
  const bar = "█".repeat(filled) + "░".repeat(METER_WIDTH - filled);
  return (
    <Text>
      <Text dimColor>ctx </Text>
      <Text color={meterColor(fraction)}>{bar}</Text>
      <Text dimColor>
        {" "}
        {Math.round(fraction * 100)}% ({formatTokens(used)}/{formatTokens(window)})
      </Text>
    </Text>
  );
}

export function StatusBar({
  model,
  cwd,
  tokens,
  contextTokens,
  contextWindow,
  columns = 80,
  scrolledUp = false,
  hiddenAbove = 0,
  expandAll = false,
  autoApprove = false,
  link = null,
}: {
  model: string;
  cwd: string;
  tokens: TokenTotals;
  contextTokens: number;
  contextWindow: number;
  columns?: number;
  scrolledUp?: boolean;
  hiddenAbove?: number;
  expandAll?: boolean;
  autoApprove?: boolean;
  /** The link's state when it is not up ("reconnecting…", "disconnected: …"). */
  link?: LinkIndicator | null;
}): ReactElement {
  // One line: workspace + tokens + context meter on the left (truncated, never
  // wrapped); the auto-accept mode indicator (always shown, so the keybind is
  // discoverable) and the model name pinned right.
  return (
    <Box width={Math.max(10, columns)}>
      {/* The link state first, as a SIBLING box: nested in the truncated Text
          below it kept the first render's width (docs/library-bugs.md, Ink
          nested-Text mis-measure). Capped so the line keeps some context. */}
      {link ? (
        <Box
          flexShrink={0}
          width={Math.min(link.text.length + 3, Math.max(10, Math.floor(columns * 0.7)))}
        >
          <Text color={link.tone === "error" ? "red" : "yellow"} wrap="truncate-end">
            {`${link.text} · `}
          </Text>
        </Box>
      ) : null}
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">
          <Text dimColor>
            {shortCwd(cwd)} · ↑{formatTokens(tokens.prompt)} ↓{formatTokens(tokens.completion)} ·{" "}
          </Text>
          <ContextMeter used={contextTokens} window={contextWindow} />
          {scrolledUp ? (
            <Text color="yellow"> · ↑{hiddenAbove} more (↓ to follow)</Text>
          ) : expandAll ? (
            <Text dimColor> · expanded</Text>
          ) : null}
        </Text>
      </Box>
      {/* The mode indicator yields space before the model name: on a narrow
          line the hint truncates, the model id stays readable. */}
      <Box flexShrink={1} minWidth={0}>
        {autoApprove ? (
          <Text color={accentHex} wrap="truncate-end">
            {" ⏵⏵ auto-accept on "}
          </Text>
        ) : (
          <Text dimColor wrap="truncate-end">
            {" ⏵⏵ auto-accept off (shift+tab) "}
          </Text>
        )}
      </Box>
      <Box flexShrink={0}>
        <Text dimColor wrap="truncate-end">
          {" "}
          {model}
        </Text>
      </Box>
    </Box>
  );
}
