import chalk from "chalk";
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { formatDuration } from "../format.ts";
import { useElapsed } from "../hooks.ts";
import { SHIMMER_TICK_MS, shimmerSpans } from "../shimmer.ts";
import { dimProps, palette } from "../theme.ts";

// Braille spinner frames: all render at a uniform width-1 cell, so the label
// next to it never shifts (the sparkle glyphs jitter — their rendered width
// varies by terminal).
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function Thinking({
  since,
  label = "Thinking…",
}: { since: number; label?: string }): ReactElement {
  const seconds = useElapsed(since);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), SHIMMER_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const glyph = FRAMES[frame % FRAMES.length];
  // The sweep rides the spinner's own clock (`shimmer.ts`): no second timer. With
  // colour off — `NO_COLOR`, no TTY — `chalk.level` is 0 and the label is the
  // plain accent run it has always been, exactly as `blink.ts` degrades.
  const t = palette();
  const spans = shimmerSpans(label, frame, { color: chalk.level > 0 });
  return (
    <Box>
      <Text color={t.accent}>
        {glyph}{" "}
        {spans.map((span, i) => (
          <Text
            key={`${i}:${span.text}`}
            color={
              span.tone === "peak" ? t.shimmer.peak : span.tone === "mid" ? t.shimmer.mid : t.accent
            }
          >
            {span.text}
          </Text>
        ))}
      </Text>
      <Text {...dimProps()}> {formatDuration(seconds)} · esc/ctrl+c to stop</Text>
    </Box>
  );
}
