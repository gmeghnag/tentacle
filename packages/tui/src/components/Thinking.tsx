import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { useElapsed } from "../hooks.ts";

// Braille spinner frames: all render at a uniform width-1 cell, so the label
// next to it never shifts (the sparkle glyphs jitter — their rendered width
// varies by terminal).
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const FRAME_MS = 80;
// Claude brand orange, as a hex Ink understands.
const CLAUDE = "#d77757";

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
      <Text color={CLAUDE}>{glyph}</Text>
      <Text dimColor>
        {" "}
        {label} {seconds}s · esc/ctrl+c to stop
      </Text>
    </Box>
  );
}
