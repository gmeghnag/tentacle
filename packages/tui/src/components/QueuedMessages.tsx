import { Box, Text, useStdout } from "ink";
import type { ReactElement } from "react";
import { queuedRows } from "../message-row.ts";

// Messages queued while a turn runs: shaped like a sent message (`›`, the same
// full-width row background), the text in grey. `hint` (the send-now keys)
// is a grey row under the last one. The rows come from the pure `queuedRows`; the
// width is the terminal's, re-read on every render (a resize re-renders us).
export function QueuedMessages({
  queued,
  hint,
  columns,
}: {
  queued: readonly string[];
  hint?: string;
  columns?: number;
}): ReactElement | null {
  const { stdout } = useStdout();
  if (queued.length === 0) return null;
  const rows = queuedRows(queued, columns ?? stdout?.columns ?? 80, hint);
  return (
    <Box flexDirection="column">
      {rows.map((row, i) => (
        <Text key={`q-${i}-${queued[i] ?? "hint"}`} wrap="truncate-end">
          {row}
        </Text>
      ))}
    </Box>
  );
}
