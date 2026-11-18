/**
 * The scrub's React glue (docs/feat/model-charts.md D6, slice C7): forwards the
 * plot's responder events and one HOLD_MS timer to `createScrubDriver`
 * (`chart-interact.ts`, which decides everything) and keeps the scrubbed index
 * as state. The haptic goes through the one haptic owner, `haptics.ts`.
 */
import { useEffect, useRef, useState } from "react";
import type { GestureResponderEvent, GestureResponderHandlers } from "react-native";
import { createScrubDriver } from "../../chart-interact.ts";
import type { ChartLayout, ScrubView } from "../../chart-layout.ts";
import { HOLD_MS } from "../../chart-scrub.ts";
import { playHaptic } from "../../haptics.ts";

export interface ChartScrub {
  readonly scrub: ScrubView | null;
  readonly handlers: GestureResponderHandlers;
}

/** `layout` may be `null` (no view yet): the hook still runs, and nothing scrubs. */
export function useChartScrub(layout: ChartLayout | null, onTap: () => void): ChartScrub {
  const [index, setIndex] = useState<number | null>(null);
  const latest = useRef({ layout, onTap });
  latest.current = { layout, onTap };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The finger's x in the plot: locationX at the press, then page deltas (a move's
  // locationX is relative to whatever child is under the finger).
  const origin = useRef({ x: 0, pageX: 0 });
  const driver = useRef(
    createScrubDriver(() => ({
      hit: latest.current.layout?.hit ?? (() => null),
      play: playHaptic,
      onIndex: setIndex,
      onTap: () => latest.current.onTap(),
      onYield: () => {},
    })),
  ).current;
  const stopTimer = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  // Unmount: a pending hold timer must not fire into a gone row.
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const at = (e: GestureResponderEvent) => ({
    x: origin.current.x + (e.nativeEvent.pageX - origin.current.pageX),
    y: e.nativeEvent.locationY,
  });
  const handlers: GestureResponderHandlers = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => false,
    onResponderGrant: (e) => {
      origin.current = { x: e.nativeEvent.locationX, pageX: e.nativeEvent.pageX };
      const t0 = Date.now();
      driver.send({ type: "down", p: at(e), t: t0 });
      stopTimer();
      timer.current = setTimeout(() => {
        timer.current = null;
        // A timer never fires early, but a 1 ms clock can read 249: the hold is over.
        driver.send({ type: "timer", t: Math.max(Date.now(), t0 + HOLD_MS) });
      }, HOLD_MS);
    },
    onResponderMove: (e) => driver.send({ type: "move", p: at(e), t: Date.now() }),
    onResponderRelease: () => {
      stopTimer();
      driver.send({ type: "up" });
    },
    onResponderTerminate: () => {
      stopTimer();
      driver.send({ type: "cancel" });
    },
    // While scrubbing the list must not steal the finger; before the hold it may (a pan).
    onResponderTerminationRequest: () => !driver.scrubbing(),
  };
  const scrub = index === null || layout === null ? null : layout.scrubAt(index);
  return { scrub, handlers };
}
