/**
 * The transcript list's footer (docs/feat/mobile-ui-fluidity-s4.md): the
 * compaction slot, the live "Thinking…" node and the pending bubbles. It follows
 * the `tail` slice, so a streamed delta redraws it and not the list. A dumb
 * renderer (AGENTS §7); with nothing to say it draws nothing.
 */
import { type JSX, memo } from "react";
import { PERF } from "../../perf-probe.ts";
import type { SessionScreenController } from "../../session-screen-controller.ts";
import type { SessionStore } from "../../session-store.ts";
import type { Palette } from "../../theme.ts";
import { CompactSlotNode, ThinkingNode } from "../../ui/StepNode.tsx";
import { useSlice } from "../../use-slice.ts";
import { PendingBubbles } from "../compose/PendingBubble.tsx";

interface TailPaneProps {
  readonly store: SessionStore;
  readonly palette: Palette;
  readonly reduceMotion: boolean;
  readonly controller: SessionScreenController;
}

export const TailPane = memo(function TailPane({
  store,
  palette,
  reduceMotion,
  controller,
}: TailPaneProps): JSX.Element {
  PERF.pane("tail");
  const slice = useSlice(store, "tail");
  const { thinking } = slice;
  return (
    <>
      {/* The compaction slot (mobile-hub-commands C2 item 15): in the
          Thinking node's place; `slotView` already yields to a turn. */}
      {slice.slot === null ? null : (
        <CompactSlotNode palette={palette} slot={slice.slot} reduceMotion={reduceMotion} />
      )}
      {/* The live "Thinking…" node (Owner Q2): the thread's last node while
          the turn thinks, under the rows so their keys never shift. The
          PENDING bubbles follow it (docs/feat/mobile-queued-compose.md D1):
          a queued message is read at the next step, so it IS the thread's last
          node — and it leaves in the `queued` that drops its row. */}
      {thinking === null ? null : (
        <ThinkingNode
          palette={palette}
          thought={thinking.thought}
          up={thinking.up}
          {...(thinking.since === undefined ? {} : { since: thinking.since })}
          reduceMotion={reduceMotion}
        />
      )}
      <PendingBubbles
        bubbles={slice.view.pending}
        palette={palette}
        ctx={{
          link: slice.view.state === "Live",
          turn: slice.view.composer.running,
          sendNow: slice.compose.sendNow,
          unqueue: !slice.compose.unqueueOff,
        }}
        onAction={(id, action) => {
          switch (action) {
            case "edit":
              void controller.edit(id);
              return;
            case "cancel":
              void controller.cancel(id);
              return;
            case "send-now":
              void controller.sendNowRow(id);
              return;
          }
        }}
      />
    </>
  );
});
