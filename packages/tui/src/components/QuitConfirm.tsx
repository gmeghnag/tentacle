import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { palette } from "../theme.ts";

/** Rows the confirmation occupies (App sizes the viewport): its framed line. */
export const QUIT_CONFIRM_ROWS = 3;

/**
 * `/quit`'s confirmation — other terminals on the session (docs/fix/detach-live.md
 * A2), or background sub-agents a quit would lose (docs/feat/subagent-background-ui.md)
 * — in place of the input. Its text and its keys are `commands.ts`'s
 * (`quitConfirmText`, `quitConfirmKey`); this only draws. `truncate-end` keeps
 * it the ONE row `QUIT_CONFIRM_ROWS` reserves, whatever the names' length.
 */
export function QuitConfirm({ text, columns }: { text: string; columns: number }): ReactElement {
  const t = palette();
  return (
    <Box
      width={columns}
      borderStyle="round"
      borderColor={t.quit}
      borderLeft={false}
      borderRight={false}
    >
      <Text color={t.quit} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}
