import { Box, Text } from "ink";
import type { ReactElement } from "react";

/** Rows the confirmation occupies (App sizes the viewport): its framed line. */
export const QUIT_CONFIRM_ROWS = 3;

/**
 * `/quit`'s confirmation with other terminals on the session
 * (docs/fix/detach-live.md A2), in place of the input. Its text and its keys
 * are `commands.ts`'s (`quitConfirmText`, `quitConfirmKey`); this only draws.
 */
export function QuitConfirm({ text, columns }: { text: string; columns: number }): ReactElement {
  return (
    <Box
      width={columns}
      borderStyle="round"
      borderColor="yellow"
      borderLeft={false}
      borderRight={false}
    >
      <Text color="yellow">{text}</Text>
    </Box>
  );
}
