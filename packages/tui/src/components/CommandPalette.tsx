/**
 * Slash-command autocomplete, shown above the input while the user types a
 * `/command`. Claude-Code style: a plain column of rows (no frame), the
 * selected row highlighted in the brand colour, the rest dimmed; the command
 * name is column-aligned so the descriptions line up.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { SlashCommand } from "../commands.ts";
import { dimProps, palette } from "../theme.ts";

export function CommandPalette({
  commands,
  selected,
  columns,
}: {
  commands: readonly SlashCommand[];
  selected: number;
  columns: number;
}): ReactElement {
  const nameWidth = commands.reduce((w, c) => Math.max(w, c.name.length), 0);
  const accent = palette().accent;
  return (
    <Box flexDirection="column" width={columns}>
      {commands.map((cmd, i) => {
        const isSelected = i === selected;
        return (
          <Text
            key={cmd.name}
            color={isSelected ? accent : undefined}
            {...(isSelected ? {} : dimProps())}
            wrap="truncate"
          >
            {isSelected ? "❯ " : "  "}
            {cmd.name.padEnd(nameWidth)}
            {"  "}
            {cmd.description}
          </Text>
        );
      })}
    </Box>
  );
}
