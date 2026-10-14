import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { inputView } from "../input-view.ts";

/**
 * The prompt input renderer: a block cursor over a (possibly multi-line) value,
 * or a dim placeholder when empty. Multi-line buffers (a pasted block, or a
 * `\`-continuation) render as a column, windowed around the cursor to at most
 * `maxRows` lines. All editing lives in `App`'s key handler, so no control key
 * (Ctrl+O, mouse reports, …) can ever be echoed into the buffer.
 */
const CLAUDE = "#d77757";

export function LineInput({
  value,
  cursor,
  placeholder,
  maxRows = 10,
}: {
  value: string;
  cursor: number;
  placeholder: string;
  maxRows?: number;
}): ReactElement {
  if (value === "") {
    return (
      <Box>
        <Text color={CLAUDE}>❯ </Text>
        <Text inverse> </Text>
        <Text dimColor>{placeholder}</Text>
      </Box>
    );
  }

  const view = inputView(value, cursor, maxRows);
  return (
    <Box flexDirection="column">
      {view.lines.map((line, r) => {
        // "❯" marks the first logical line (not a windowed continuation); more-
        // above/below are flagged with a dim arrow in the gutter instead.
        const firstLogicalVisible = !view.moreAbove && r === 0;
        const lastVisible = r === view.lines.length - 1;
        const gutter =
          view.moreAbove && r === 0 ? "↑ " : view.moreBelow && lastVisible ? "↓ " : null;
        const prefix = gutter ?? (firstLogicalVisible ? "❯ " : "  ");
        const prefixColor = gutter ? "gray" : CLAUDE;
        // Ink measures an empty <Text> as 0×0, which would collapse the row and
        // shift the box; a single space keeps every row one cell tall.
        const key = `${r}`;
        if (r !== view.cursorRow) {
          return (
            <Box key={key}>
              <Text color={prefixColor} dimColor={gutter !== null}>
                {prefix}
              </Text>
              <Text>{line === "" ? " " : line}</Text>
            </Box>
          );
        }
        const col = Math.max(0, Math.min(line.length, view.cursorCol));
        return (
          <Box key={key}>
            <Text color={prefixColor} dimColor={gutter !== null}>
              {prefix}
            </Text>
            <Text>
              {line.slice(0, col)}
              <Text inverse>{line[col] ?? " "}</Text>
              {line.slice(col + 1)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
