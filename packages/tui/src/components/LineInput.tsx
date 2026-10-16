import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { inputRender } from "../input-view.ts";

/**
 * The prompt input renderer: a dumb view over the rows computed by
 * `inputRender` (which resolves the block cursor, the selection highlight and
 * the windowing). This component owns only presentation — the accent colour,
 * the dim placeholder, and mapping a segment's `inverse` flag to Ink's prop.
 * All editing lives in `App`'s key handler, so no control key (Ctrl+O, mouse
 * reports, …) can ever be echoed into the buffer.
 */
const CLAUDE = "#d77757";

export function LineInput({
  value,
  cursor,
  anchor = null,
  placeholder,
  maxRows = 10,
}: {
  value: string;
  cursor: number;
  /** Selection anchor (`null` = no selection); selected cells render inverse. */
  anchor?: number | null;
  placeholder: string;
  maxRows?: number;
}): ReactElement {
  const { rows } = inputRender(value, cursor, anchor, maxRows);
  const empty = value === "";
  return (
    <Box flexDirection="column">
      {rows.map((row, r) => {
        const key = `${r}`;
        return (
          <Box key={key}>
            <Text color={row.gutter ? "gray" : CLAUDE} dimColor={row.gutter}>
              {row.prefix}
            </Text>
            {row.segments.map((seg, s) => (
              <Text key={`${r}-${s}`} inverse={seg.inverse}>
                {seg.text}
              </Text>
            ))}
            {empty && r === 0 ? <Text dimColor>{placeholder}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
