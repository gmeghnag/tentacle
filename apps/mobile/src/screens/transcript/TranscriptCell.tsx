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
import { rowErrorFields } from "../../row-guard.ts";
import { rowTimeLabel } from "../../row-swipe.ts";
import type { Palette } from "../../theme.ts";
import type { ThumbnailState } from "../../thumbnails.ts";
import { type CellData, sameCellProps } from "../../transcript-cell.ts";
import type { Row } from "../../transcript-rows.ts";
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
          {...(props.look === undefined ? {} : { look: props.look })}
          step={{
            cell: props.cell,
            open: props.open,
            full: props.full,
            reduceMotion: props.reduceMotion,
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
