/**
 * The background dropdown above the input, and one child opened
 * (docs/feat/subagent-panel.md, UI revision; AGENTS §7: every decision — the
 * columns, the window, the cells-cut, the hint, the glyph, the pill's words and
 * its column range — is `background-list.ts`'s and `status-view.ts`'s; this
 * component maps a segment's semantic tone to a theme token and nothing else).
 *
 * The dropdown's own rule carries its title AND every key; the input rule under
 * it is a plain line (App's `inputRuleText`), so the dock reads as ONE framed
 * block and never as two labelled rules stacked.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { BackgroundListView, DockSegment } from "../background-list.ts";
import { palette } from "../theme.ts";
import { toneProps } from "./dock-tone.ts";

/** A run of segments on ONE row, each painted by its tone. */
export function DockSegments({ segments }: { segments: readonly DockSegment[] }): ReactElement {
  return (
    <Text wrap="truncate-end">
      {segments.map((s, i) => (
        <Text key={i} {...toneProps(s.tone)}>
          {s.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The dropdown: its titled rule (`── background · 3 ──── ↑↓ move · enter open ·
 * x stop · esc back ─`), then at most `LIST_MAX_ROWS` compact rows. Blank rows
 * are never rendered (the height is `1 + rows.length`), so it never holds a
 * collapsed empty `<Text>`.
 */
export function BackgroundList({
  view,
  columns,
}: {
  view: BackgroundListView;
  columns: number;
}): ReactElement {
  return (
    <Box flexDirection="column" width={Math.max(10, columns)}>
      <DockSegments segments={view.rule} />
      {view.rows.map((row) => (
        <DockSegments key={row.id} segments={row.segments} />
      ))}
    </Box>
  );
}

/**
 * One child OPEN: the drawer that replaces the list while it is open (mockup 03
 * option A — the main chat stays visible above). Its rule carries the child's
 * name, its type, what it is doing and how it is going; then `… +k earlier`, the
 * tail the daemon keeps (≤ 8), and the user's last messages to it.
 */
export function SubagentDrawer({
  head,
  hidden,
  tail,
  sent,
  columns,
}: {
  head: readonly DockSegment[];
  hidden: string;
  tail: readonly string[];
  sent: readonly { readonly segments: readonly DockSegment[] }[];
  columns: number;
}): ReactElement {
  const accent = palette().accent;
  return (
    <Box flexDirection="column" width={Math.max(10, columns)}>
      <DockSegments segments={head} />
      {hidden === "" ? null : (
        <Text wrap="truncate-end">
          <Text {...toneProps("dim")}>{"  "}</Text>
          <Text {...toneProps("dim")}>{hidden}</Text>
        </Text>
      )}
      {tail.map((label, i) => (
        <Text key={i} wrap="truncate-end">
          <Text {...toneProps("dim")}>{"  │ "}</Text>
          <Text color={accent}>{label}</Text>
        </Text>
      ))}
      {sent.map((s, i) => (
        <DockSegments key={i} segments={s.segments} />
      ))}
    </Box>
  );
}
