import { Text } from "ink";
import type { ReactElement } from "react";
import { dimProps, palette } from "../theme.ts";
import type { VoiceStripView } from "../voice-view.ts";

/**
 * The one-line dictation strip (docs/feat/voice-dictation.md §5): a dumb renderer
 * of `voice-view.ts`'s view-model. It decides nothing — the state, the elapsed
 * clock, the meter's ladder and the truncation are all computed there — and it
 * draws nothing at all when the view is `null`, so an idle TUI pays no rows.
 *
 * AGENTS §6 gotcha: the partial's row is rendered `" "` when empty. An empty
 * `<Text>` measures 0×0 and would collapse the row, shifting the frame up.
 */
export const VOICE_STRIP_ROWS = 2;

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
    <>
      <Text color={t.subtle} wrap="truncate-end">
        {`  ${view.text}`.slice(0, columns)}
      </Text>
      <Text {...dimProps()} wrap="truncate-end">
        {view.partial === "" ? " " : `  ${view.partial}`.slice(0, columns)}
      </Text>
    </>
  );
}
