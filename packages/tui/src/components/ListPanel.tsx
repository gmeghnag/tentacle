/**
 * A list panel (`/mcp`, `/skills`; docs/feat/skills-panel.md), framed like the
 * permission dialog: a title rule, the head rows (and the children of an
 * expanded one), a key hint. Everything shown is precomputed by
 * `tree-panel.ts`; keys and clicks are routed in `App`.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { accentHex } from "../theme.ts";
import type { PanelView } from "../tree-panel.ts";

const ACCENT = accentHex;

export function ListPanel({ view, columns }: { view: PanelView; columns: number }): ReactElement {
  const titlePrefix = `╭─ ${view.title} `;
  const dashes = Math.max(0, columns - titlePrefix.length - 1);
  return (
    <Box flexDirection="column" width={columns}>
      <Text color={ACCENT} wrap="truncate-end">
        {titlePrefix}
        {"─".repeat(dashes)}
      </Text>
      {view.rows.map((row, i) => (
        <Text
          key={`${view.start + i}`}
          color={row.selected ? ACCENT : undefined}
          bold={row.selected}
          dimColor={!row.selected && row.kind !== "head"}
          wrap="truncate-end"
        >
          {row.text}
        </Text>
      ))}
      <Text dimColor wrap="truncate-end">
        {" "}
        {view.hint}
      </Text>
    </Box>
  );
}
