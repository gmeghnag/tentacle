import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { inputRender } from "../input-view.ts";
import { dimProps, palette } from "../theme.ts";

/**
 * The prompt input renderer: a dumb view over the rows computed by
 * `inputRender` (which resolves the block cursor, the selection highlight and
 * the windowing). This component owns only presentation — the accent colour,
 * the dim placeholder, and mapping a segment's `inverse` flag to Ink's prop.
 * All editing lives in `App`'s key handler, so no control key (Ctrl+O, mouse
 * reports, …) can ever be echoed into the buffer.
 */
export function LineInput({
  value,
  cursor,
  anchor = null,
  placeholder,
  maxRows = 10,
  width,
  ghost = "",
}: {
  value: string;
  cursor: number;
  /** Selection anchor (`null` = no selection); selected cells render inverse. */
  anchor?: number | null;
  placeholder: string;
  maxRows?: number;
  /** The box width in cells, for soft-wrapping (rows are wrapped here, never by Ink). */
  width: number;
  /** A dictation's live partial, drawn dim after the cursor (`withGhost`). */
  ghost?: string;
}): ReactElement {
  const { rows } = inputRender(value, cursor, anchor, maxRows, width, ghost);
  // The placeholder is for an EMPTY box: a ghost is content on screen.
  const empty = value === "" && ghost === "";
  const t = palette();
  return (
    <Box flexDirection="column">
      {rows.map((row, r) => {
        const key = `${r}`;
        return (
          <Box key={key}>
            <Text color={row.gutter ? t.gutter : t.accent} {...(row.gutter ? dimProps() : {})}>
              {row.prefix}
            </Text>
            {row.segments.map((seg, s) => (
              <Text key={`${r}-${s}`} inverse={seg.inverse} {...(seg.ghost ? dimProps() : {})}>
                {seg.text}
              </Text>
            ))}
            {empty && r === 0 ? <Text {...dimProps()}>{placeholder}</Text> : null}
          </Box>
        );
      })}
    </Box>
  );
}
