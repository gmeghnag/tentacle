/**
 * One transcript cell, memoized (docs/fix/mobile-fan-jank-device.md): the row
 * guard, the swipe-for-time wrapper and the row itself. It redraws only when
 * the data it draws changes (`transcript-cell.ts` `sameCellData` decides), so a
 * streaming turn redraws its last row, not every visible one with its markdown.
 *
 * The callbacks are not props: they go through ONE stable handle (`actions`)
 * whose `current` the screen refreshes on every render, so a skipped cell
 * still reaches the screen's latest state when tapped.
 */
import type { ArtifactMeta } from "@tentacle/protocol";
import { type JSX, type RefObject, memo } from "react";
import type { LabelMode } from "../../chart-layout-kit.ts";
import type { DiagramStyle } from "../../diagram-settings-store.ts";
import type { CopyVia } from "../../message-copy.ts";
import { rowErrorFields } from "../../row-guard.ts";
import { rowTimeLabel } from "../../row-swipe.ts";
import type { SessionStore } from "../../session-store.ts";
import type { Palette } from "../../theme.ts";
import type { ThumbnailState } from "../../thumbnails.ts";
import { type CellData, type CellEnv, cellDataOf, sameCellProps } from "../../transcript-cell.ts";
import type { Row } from "../../transcript-rows.ts";
import { useSlice } from "../../use-slice.ts";
import { RowGuard } from "./RowGuard.tsx";
import { SwipeTime } from "./SwipeTime.tsx";
import { RowFallback, TranscriptRow } from "./TranscriptRow.tsx";

/** What a cell can ask of the screen (read at tap time, never captured). */
export interface CellActions {
  readonly onLink: (href: string) => void;
  readonly onToggle: (key: string) => void;
  readonly onShowAll: (key: string) => void;
  readonly onAgent: (child: string) => void;
  readonly onSpeak: (row: { readonly key: string; readonly text: string }) => void;
  readonly onArtifact: (meta: ArtifactMeta) => void;
  readonly onRowError: (fields: ReturnType<typeof rowErrorFields>) => void;
  /**
   * A long-press on a message (docs/feat/mobile-copy-text.md D2): the screen
   * decides what the row copies and owns the clipboard and the pill, so a
   * skipped cell still reaches the latest handler (this handle's rule).
   */
  readonly onCopy: (row: Row, via: CopyVia) => void;
  /**
   * The press that copied a message ended (docs/feat/mobile-copy-text.md D3):
   * the pill's countdown starts at the release, never under the finger.
   */
  readonly onCopyRelease: () => void;
}

export interface TranscriptCellProps extends CellData<Row, Palette, ThumbnailState> {
  readonly diagramStyle: DiagramStyle;
  readonly chartLabels: LabelMode;
  readonly actions: RefObject<CellActions>;
}

function TranscriptCellView(props: TranscriptCellProps): JSX.Element {
  const { row, palette, actions, child } = props;
  return (
    <RowGuard
      // A row object is replaced only when its content changes
      // (transcript.ts keeps unchanged rows): that one retries.
      resetKey={row}
      fallback={<RowFallback palette={palette} />}
      onError={(error) => actions.current.onRowError(rowErrorFields(row.kind, error))}
    >
      <SwipeTime row={row} palette={palette} label={rowTimeLabel(row)}>
        <TranscriptRow
          row={row}
          palette={palette}
          diagramStyle={props.diagramStyle}
          onLink={(href) => actions.current.onLink(href)}
          thumbnails={props.thumbnails}
          chartLabels={props.chartLabels}
          onCopy={(row, via) => actions.current.onCopy(row, via)}
          onCopyRelease={() => actions.current.onCopyRelease()}
          {...(props.look === undefined ? {} : { look: props.look })}
          step={{
            cell: props.cell,
            open: props.open,
            full: props.full,
            reduceMotion: props.reduceMotion,
            compactShell: props.compactShell,
            onToggle: () => actions.current.onToggle(row.key),
            onShowAll: () => actions.current.onShowAll(row.key),
          }}
          {...(child === null
            ? {}
            : { agent: { id: child, onOpen: () => actions.current.onAgent(child) } })}
          {...(props.speak === undefined || !props.voice
            ? {}
            : { speak: props.speak, onSpeak: (r) => actions.current.onSpeak(r) })}
          {...(props.artifacts ? { onArtifact: (meta) => actions.current.onArtifact(meta) } : {})}
        />
      </SwipeTime>
    </RowGuard>
  );
}

export const TranscriptCell = memo(TranscriptCellView, sameCellProps);

interface LiveCellProps {
  readonly store: SessionStore;
  readonly env: CellEnv;
  readonly actions: RefObject<CellActions>;
  /** The stand-in's key (`LiveSlot`): the only row this cell may draw. */
  readonly rowKey: string;
}

/**
 * The cell of the row a stream is writing (docs/feat/mobile-ui-fluidity-s4.md,
 * decision 1): the list holds a stand-in that no delta changes, and this follows
 * the `tail` slice for the row's content. A live reasoning row draws nothing
 * (the Thinking line has it), and so does another key's row (the next commit
 * brings the stand-in that matches).
 */
export const LiveCell = memo(function LiveCell({
  store,
  env,
  actions,
  rowKey,
}: LiveCellProps): JSX.Element | null {
  const { live } = useSlice(store, "tail");
  if (live === null || live.kind !== "assistant" || live.key !== rowKey) {
    return null;
  }
  return <TranscriptCell {...cellDataOf(live, env, true)} actions={actions} />;
});
