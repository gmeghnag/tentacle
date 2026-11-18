import { Text } from "ink";
import type { ReactElement } from "react";
import { palette } from "../theme.ts";
import type { VoiceStripView } from "../voice-view.ts";

export { VOICE_STRIP_ROWS } from "../voice-view.ts";

/**
 * The one-line dictation strip (docs/feat/voice-dictation.md §5): a dumb renderer
 * of `voice-view.ts`'s view-model. It decides nothing — the state, the elapsed
 * clock, the meter's ladder and the truncation are all computed there — and it
 * draws nothing at all when the view is `null`, so an idle TUI pays no rows.
 *
 * ONE row: the live partial is previewed in the input, after the cursor
 * (`voiceGhost`, docs/feat/voice-live-transcript.md), not on a strip row.
 */
export function VoiceStrip({
  view,
  columns,
}: {
  view: VoiceStripView | null;
  columns: number;
}): ReactElement | null {
  if (view === null) return null;
  const t = palette();
  return (
    <Text color={t.subtle} wrap="truncate-end">
      {`  ${view.text}`.slice(0, columns)}
    </Text>
  );
}
