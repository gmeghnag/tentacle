/**
 * The Charts setting, as a component reads it (docs/feat/mobile-chart-labels.md
 * D7): the in-memory copy at the first render, then whatever a write publishes.
 *
 * It lives here so the two consumers (a transcript chart row and the full
 * screen) read the setting exactly the same way, and it stays the `useState` +
 * `subscribe` pair `ACTIVITY_SETTINGS` uses in `SessionScreen.tsx`. The layout
 * cache is keyed by the mode (`chart-row.ts`), so a change costs one re-layout.
 */
import { useEffect, useState } from "react";
import type { LabelMode } from "../../chart-layout-kit.ts";
import { CHART_SETTINGS } from "../../chart-settings-expo.ts";

export function useChartLabels(): LabelMode {
  const [labels, setLabels] = useState<LabelMode>(() => CHART_SETTINGS.current().labels);
  useEffect(() => CHART_SETTINGS.subscribe((next) => setLabels(next.labels)), []);
  return labels;
}
