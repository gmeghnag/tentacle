import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { ARC, spinnerFrame } from "../spinner.ts";

// Messages queued while a turn runs, each behind the `arc` spinner. One timer
// for the whole list (not one per row), and none when the list is empty.
// `hint` (the send-now keys) sits beside the LAST row; a long row truncates
// its own text, never the hint.
export function QueuedMessages({
  queued,
  hint,
}: {
  queued: readonly string[];
  hint?: string;
}): ReactElement | null {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  const active = queued.length > 0;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), ARC.intervalMs);
    return () => clearInterval(id);
  }, [active]);
  if (!active) return null;
  const glyph = spinnerFrame(ARC, now - start);
  return (
    <>
      {queued.map((q, i) =>
        hint !== undefined && i === queued.length - 1 ? (
          <Box key={`q-${i}-${q}`}>
            <Box flexShrink={1}>
              <Text dimColor wrap="truncate-end">
                {glyph} {q}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor> · {hint}</Text>
            </Box>
          </Box>
        ) : (
          <Text key={`q-${i}-${q}`} dimColor wrap="truncate-end">
            {glyph} {q}
          </Text>
        ),
      )}
    </>
  );
}
