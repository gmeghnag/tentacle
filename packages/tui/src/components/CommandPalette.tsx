/**
 * Slash-command autocomplete, shown above the input while the user types a
 * `/command`. Claude-Code style: a plain column of rows (no frame), the
 * selected row highlighted in the brand colour, the rest dimmed; the command
 * name is column-aligned so the descriptions line up.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import type { SlashCommand } from "../commands.ts";
import { accentHex } from "../theme.ts";

const ACCENT = accentHex;

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
  return (
    <Box flexDirection="column" width={columns}>
      {commands.map((cmd, i) => {
        const isSelected = i === selected;
        return (
          <Text
            key={cmd.name}
            color={isSelected ? ACCENT : undefined}
            dimColor={!isSelected}
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
