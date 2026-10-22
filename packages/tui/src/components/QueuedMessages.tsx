import { Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { ARC, spinnerFrame } from "../spinner.ts";

// Messages queued while a turn runs, each behind the `arc` spinner. One timer
// for the whole list (not one per row), and none when the list is empty.
export function QueuedMessages({ queued }: { queued: readonly string[] }): ReactElement | null {
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
      {queued.map((q, i) => (
        <Text key={`q-${i}-${q}`} dimColor wrap="truncate-end">
          {glyph} {q}
        </Text>
      ))}
    </>
  );
}
