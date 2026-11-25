/**
 * The workflow rail (docs/feat/workflows-ui.md D3, mockup `agent-workflows-view`
 * TUI 1): the run in flight, one row per step, in the live area above the
 * queued/slot block.
 *
 * AGENTS §7: every cell — the header's figures, the columns, the width tier, the
 * window around the active step, the `… +k` rows, the glyph and the WORD — is
 * `workflow-view.ts`'s. This component maps a line's semantic tone to a theme
 * token and paints the text; it re-derives nothing, so the frames test can
 * assert the pane equals the projection.
 *
 * A blank line arrives as `" "` (AGENTS §6): an empty `<Text>` measures 0×0 and
 * would collapse the row the layout reserved.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { RailLine } from "../workflow-view.ts";
import { toneProps } from "./dock-tone.ts";

export function WorkflowRail({
  lines,
  columns,
}: {
  readonly lines: readonly RailLine[];
  readonly columns: number;
}): ReactElement {
  return (
    <Box flexDirection="column" width={Math.max(10, columns)}>
      {lines.map((line, i) => (
        <Text key={i} wrap="truncate-end" {...toneProps(line.tone)}>
          {line.text === "" ? " " : line.text}
        </Text>
      ))}
    </Box>
  );
}
