/**
 * When a transcript cell must redraw (docs/fix/mobile-fan-jank-device.md).
 *
 * The session screen re-renders on every state change, and its list re-renders
 * every visible cell with it — each one re-parsing its markdown — although
 * during a stream only the LAST row changed. A cell is memoized on the data it
 * draws; this module is the one place that says what "the same data" means, so
 * the decision is tested here, not buried in a component (AGENTS §7).
 *
 * Identity for everything, except two values the screen rebuilds on each
 * layout pass for EVERY row (`stepLayout`'s cell, `noticeLooks`' look): those
 * are compared by content, or no cell would ever be skipped. The callbacks a
 * cell fires are NOT data: they go through one stable handle that always
 * reaches the screen's latest closures (`TranscriptCell.tsx`).
 */
import { agentCardTarget } from "./activity.ts";
import type { LabelMode } from "./chart-layout-kit.ts";
import type { DiagramStyle } from "./diagram-settings-store.ts";
import type { NoticeLook } from "./notice-group.ts";
import type { ReadAloudState } from "./read-aloud.ts";
import type { Palette } from "./theme.ts";
import type { ThumbnailState } from "./thumbnails.ts";
import { type StepCell, isOpen } from "./tool-steps.ts";
import type { Row } from "./transcript-rows.ts";
import { speakButtonOf } from "./voice-view.ts";

/**
 * Everything a cell reads besides its row (docs/feat/mobile-ui-fluidity-s4.md,
 * decision 5): the screen memoizes ONE of these, which is both `renderItem`'s
 * key and the list's `extraData`. Nothing here changes on a streamed delta.
 */
export interface CellEnv {
  readonly palette: Palette;
  readonly thumbnails: ThumbnailState;
  readonly diagramStyle: DiagramStyle;
  readonly chartLabels: LabelMode;
  readonly reduceMotion: boolean;
  readonly compactShell: boolean;
  /** Whether the speaker is wired at all (there is a voice controller). */
  readonly voice: boolean;
  readonly readAloud: ReadAloudState | undefined;
  /** The Beta `Read aloud` switch. */
  readonly speakShown: boolean;
  readonly artifacts: boolean;
  /** The live and Finished sub-agents: an agent card's link follows them. */
  readonly activity: {
    readonly subagents: Parameters<typeof agentCardTarget>[2];
    readonly memory: { readonly finished: Parameters<typeof agentCardTarget>[3] };
  };
  readonly cells: ReadonlyMap<string, StepCell>;
  readonly looks: ReadonlyMap<string, NoticeLook>;
  readonly openSteps: readonly string[];
  readonly fullSteps: readonly string[];
}

/**
 * One cell's props from its row and the environment — the one place for it, for
 * a list cell and for the live one. `live`: this row is the one the stream is
 * writing (`liveRow`), so its speaker is not offered yet.
 */
export function cellDataOf(
  row: Row,
  env: CellEnv,
  live: boolean,
): CellData<Row, Palette, ThumbnailState> & {
  readonly diagramStyle: DiagramStyle;
  readonly chartLabels: LabelMode;
} {
  return {
    row,
    cell: env.cells.get(row.key),
    look: row.kind === "notice" ? env.looks.get(row.key) : undefined,
    open: isOpen(env.openSteps, row.key),
    full: isOpen(env.fullSteps, row.key),
    reduceMotion: env.reduceMotion,
    compactShell: env.compactShell,
    // `speakButtonOf` asks the rows only which one streams: the live row alone
    // stands for them (it IS the last one), and a list cell never streams.
    speak: speakButtonOf(
      env.readAloud === undefined ? null : { readAloud: env.readAloud },
      row,
      live ? [row] : [],
      live,
      { readAloudButton: env.speakShown },
    ),
    child:
      row.kind === "tool"
        ? agentCardTarget(
            row.id,
            row.sub?.movedTo,
            env.activity.subagents,
            env.activity.memory.finished,
          )
        : null,
    voice: env.voice,
    artifacts: env.artifacts,
    palette: env.palette,
    thumbnails: env.thumbnails,
    diagramStyle: env.diagramStyle,
    chartLabels: env.chartLabels,
  };
}

/** What a cell draws; every field is compared (see `sameCellData`). */
export interface CellData<RowT = unknown, PaletteT = unknown, ThumbsT = unknown> {
  readonly row: RowT;
  readonly cell: StepCell | undefined;
  readonly look: NoticeLook | undefined;
  readonly open: boolean;
  readonly full: boolean;
  readonly reduceMotion: boolean;
  /** Beta `Compact shell rows` (docs/feat/shell-intent-line.md §7). */
  readonly compactShell: boolean;
  readonly speak: "offered" | "speaking" | undefined;
  /** The sub-agent the card opens, or null. */
  readonly child: string | null;
  /** Whether the speaker / the artifact card are wired at all. */
  readonly voice: boolean;
  readonly artifacts: boolean;
  readonly palette: PaletteT;
  readonly thumbnails: ThumbsT;
  readonly diagramStyle: unknown;
  readonly chartLabels: unknown;
}

export function sameStepCell(a: StepCell | undefined, b: StepCell | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (a === undefined || b === undefined || a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case "hidden":
      return true;
    case "step": {
      const o = b as Extract<StepCell, { kind: "step" }>;
      return (
        a.thought === o.thought &&
        a.thoughtFirst === o.thoughtFirst &&
        a.thread.up === o.thread.up &&
        a.thread.down === o.thread.down
      );
    }
    case "thought": {
      const o = b as Extract<StepCell, { kind: "thought" }>;
      return a.ms === o.ms && a.thread.up === o.thread.up && a.thread.down === o.thread.down;
    }
    case "context": {
      // The row itself is compared by identity (`sameCellData`), so only the
      // thread this layout pass decided on has to match.
      const o = b as Extract<StepCell, { kind: "context" }>;
      return a.thread.up === o.thread.up && a.thread.down === o.thread.down;
    }
  }
}

export function sameLook(a: NoticeLook | undefined, b: NoticeLook | undefined): boolean {
  if (a === b) {
    return true;
  }
  return a !== undefined && b !== undefined && a.glyph === b.glyph && a.joined === b.joined;
}

/** Whether a cell drawn from `a` would draw the same from `b` (so it may be skipped). */
export function sameCellData(a: CellData, b: CellData): boolean {
  return (
    a.row === b.row &&
    a.open === b.open &&
    a.full === b.full &&
    a.reduceMotion === b.reduceMotion &&
    a.compactShell === b.compactShell &&
    a.speak === b.speak &&
    a.child === b.child &&
    a.voice === b.voice &&
    a.artifacts === b.artifacts &&
    a.palette === b.palette &&
    a.thumbnails === b.thumbnails &&
    a.diagramStyle === b.diagramStyle &&
    a.chartLabels === b.chartLabels &&
    sameStepCell(a.cell, b.cell) &&
    sameLook(a.look, b.look)
  );
}

/**
 * `TranscriptCell`'s `memo` comparator: the ONE handle it receives plus the data
 * it draws. `actions` is a ref the screen keeps for its whole life, so it never
 * decides anything — which is why the data comparison must not be dropped from
 * here (a cell that only compared the handle would freeze on a streamed row's
 * first delta; `transcript-cell.test.ts` holds both halves).
 */
export function sameCellProps(
  a: CellData & { readonly actions: unknown },
  b: CellData & { readonly actions: unknown },
): boolean {
  return a.actions === b.actions && sameCellData(a, b);
}
