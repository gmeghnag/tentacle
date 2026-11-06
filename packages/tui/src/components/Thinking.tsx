import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { formatDuration } from "../format.ts";
import { useElapsed } from "../hooks.ts";
import { dimProps, palette } from "../theme.ts";

// Braille spinner frames: all render at a uniform width-1 cell, so the label
// next to it never shifts (the sparkle glyphs jitter — their rendered width
// varies by terminal).
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 80;

export function Thinking({
  since,
  label = "thinking…",
}: { since: number; label?: string }): ReactElement {
  const seconds = useElapsed(since);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), FRAME_MS);
    return () => clearInterval(id);
  }, []);
  const glyph = FRAMES[frame % FRAMES.length];
  return (
    <Box>
      <Text color={palette().accent}>{glyph}</Text>
      <Text {...dimProps()}>
        {" "}
        {label} {formatDuration(seconds)} · esc/ctrl+c to stop
      </Text>
    </Box>
  );
}
