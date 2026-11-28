/**
 * The session screen's floating hub (docs/feat/mobile-ui-fluidity-s3.md). It
 * follows the `hub` slice and takes the shell's memoized items, so a streamed
 * delta never re-renders it. A dumb renderer (AGENTS §7): the items and badge
 * are `hub-actions.ts`'s, what a gesture does is the shell's `actions`.
 */
import { type JSX, memo } from "react";
import type { ActivitySettings } from "../../activity-settings-store.ts";
import type { FloatBounds } from "../../floating-button.ts";
import type { HubItem } from "../../hub-actions.ts";
import type { ScrollDim } from "../../hub-scroll-dim.ts";
import { PERF } from "../../perf-probe.ts";
import type { SessionStore } from "../../session-store.ts";
import type { Palette } from "../../theme.ts";
import { FloatingActivity } from "../../ui/FloatingActivity.tsx";
import { useSlice } from "../../use-slice.ts";
import type { PaneActionsRef } from "./actions.ts";

interface HubPaneProps {
  readonly store: SessionStore;
  readonly palette: Palette;
  readonly actions: PaneActionsRef;
  readonly bounds: FloatBounds | null;
  readonly position: ActivitySettings["position"];
  readonly opacity: ActivitySettings["opacity"];
  readonly shown: boolean;
  readonly scroll: ScrollDim;
  readonly count: number | null;
  readonly pulse: number;
  readonly accessibilityLabel: string;
  readonly voiceOver: boolean;
  readonly reduceMotion: boolean;
  readonly reduceTransparency: boolean;
  readonly fanItems: readonly HubItem[];
  readonly allItems: readonly HubItem[];
}

export const HubPane = memo(function HubPane({
  store,
  actions,
  ...hub
}: HubPaneProps): JSX.Element {
  PERF.pane("hub");
  const slice = useSlice(store, "hub");
  return (
    <FloatingActivity
      {...hub}
      turnRunning={slice.view.composer.running}
      solve={() => actions.current.solveHub()}
      onFanChange={(open) => actions.current.hubFan(open)}
      onCommit={(id) => actions.current.hubCommit(id)}
      onFlash={(id) => actions.current.hubFlash(id)}
      onMenu={() => actions.current.hubShowAll()}
      onDrop={(position) => actions.current.hubDrop(position)}
    />
  );
});
