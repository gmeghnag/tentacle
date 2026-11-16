/**
 * docs/feat/app-decomposition.md S10 — the frame's VIEW-MODEL, pure and
 * React-free (AGENTS §7: every decision with branching lives in a pure module,
 * unit-tested; a component only renders).
 *
 * This module is the last slice's payload: the derived rows `App.tsx` used to
 * compute inline between its state and its `useInput` (the palette window, the
 * input box's height, the panel's view, the dock's dropdown/drawer, the pill,
 * the reply field, and the row arithmetic that decides the transcript's viewport
 * and where a click landed) all come from ONE call here — `frameLayout(input)` —
 * over an explicit input, so the whole frame's geometry is a function of values
 * and testable without mounting Ink.
 *
 * It is a MOVE, not a redesign: every expression below is the expression
 * `App.tsx` carried (same order, same comments), and the DECISIONS are still the
 * existing pure modules' (`statusTokens`, `contextShown`, `matchCommands`,
 * `paletteWindow`, `inputRowCount`, `attachRowView`/`attachRowRows`, `panelView`,
 * `shownRows`, `backgroundListView`, `jobDrawerView`/`drawerView`, `dockRows`,
 * `pillView`, `replyView`, `permissionPromptRows`, `panelHeight`/`panelMaxBody`).
 * Nothing here paints: the text and the glyphs stay `AppView.tsx`'s.
 *
 * What deliberately did NOT move: `useDockClock` (a hook — it owns an effect, so
 * it keeps its exact position in `App`'s hook order, Fable H1), the layout of the
 * transcript itself (`layoutTranscript`/`blink` — its consumers are three
 * `useEffect`s that must stay in `App` in today's order), and `statusRowRef`
 * (a ref, written by `App`'s `onPillRange` callback). Those arrive as inputs or
 * leave as values.
 */
import { type AttachDraft, attachRowRows, attachRowView } from "./attach-draft.ts";
import type { DockState } from "./background-focus.ts";
import {
  type DockJobRow,
  backgroundListView,
  dockRows,
  drawerView,
  jobDrawerView,
  listVisible,
} from "./background-list.ts";
import type { BackgroundAgentRow } from "./background-view.ts";
import { type CapsPhase, capsMarker } from "./capability-toggles.ts";
import {
  type QuitConfirmFacts,
  type SlashSkill,
  matchCommands,
  paletteWindow,
} from "./commands.ts";
import { permissionPromptRows } from "./components/PermissionPrompt.tsx";
import { QUIT_CONFIRM_ROWS } from "./components/QuitConfirm.tsx";
import { VOICE_STRIP_ROWS } from "./components/VoiceStrip.tsx";
import { inputRowCount } from "./input-view.ts";
import type { LinkIndicator } from "./link-status.ts";
import type { OpenPanel } from "./panel.ts";
import { panelView } from "./panel.ts";
import { replyView } from "./permission-reply.ts";
import {
  type PermissionController,
  permissionDetailLines,
  permissionShowsCwd,
} from "./permission-ui.ts";
import type { DaemonQueue, QueuedRows } from "./queued.ts";
import { shownRows } from "./queued.ts";
import type { Selection } from "./selection.ts";
import type { DisplayState } from "./state.ts";
import { type ContextOpen, contextShown, pillView, statusTokens } from "./status-view.ts";
import type { TargetBadge } from "./target-view.ts";
import { panelHeight, panelMaxBody } from "./tree-panel.ts";
import type { VoiceStripView } from "./voice-view.ts";

/** Rows reserved below the transcript viewport: a blank spacer, the input/thinking
 * line, the status bar, plus one slack row so the frame never overflows the
 * terminal (which, on the alternate screen, has no scrollback to absorb it). */
const RESERVED_ROWS = 4;
/** Max content lines the input box shows before it windows around the cursor. */
export const MAX_INPUT_ROWS = 10;

/**
 * Everything the frame's rows are a function of — the render values `App` holds,
 * the refs a row reads directly today (`subagentsRef`, `jobRowsRef`,
 * `jobOutputRef`, `dockFinishedRef`), and the two facts a hook owns (`dockNow`
 * from `useDockClock`, `blinkClock` for the layout) that `App` passes in.
 *
 * The refs stay in the input on purpose, and read where they are read today: a
 * row sourced from a ref keeps that source (the plan's freshness rule, H3), so
 * two keys with no render between them behave as before.
 */
export interface FrameInput {
  readonly state: DisplayState;
  readonly permission: PermissionController;
  readonly dock: DockState;
  /** `useDockClock`'s current tick — the dock's own clock, passed in as a value. */
  readonly dockNow: number;
  readonly subagents: readonly BackgroundAgentRow[] | undefined;
  readonly subagentsRef: { current: readonly BackgroundAgentRow[] | undefined };
  readonly jobRows: readonly DockJobRow[] | undefined;
  readonly jobRowsRef: { current: readonly DockJobRow[] | undefined };
  readonly drawerRow: BackgroundAgentRow | null;
  readonly drawerJob: DockJobRow | null;
  /** `jobOutputRef.current`: a job's cached output tail, keyed by its wire id. */
  readonly jobOutput: Readonly<
    Record<
      string,
      {
        readonly output: readonly string[];
        readonly truncated?: boolean;
        readonly exitCode?: number | null;
      }
    >
  >;
  /** `dockFinishedRef.current`: when the last child finished (for the pill). */
  readonly dockFinished: { readonly id: string; readonly at: number } | null;
  readonly quitConfirm: QuitConfirmFacts | null;
  readonly panel: OpenPanel | null;
  /** The session's own id (`sessionRef.current?.sessionId ?? null`). */
  readonly sessionId: string | null;
  /**
   * The session's MCP/skill switches (docs/feat/session-capabilities.md S4):
   * the panels' switch column and the status-line marker. Absent: none.
   */
  readonly capsPhase?: CapsPhase;
  readonly field: { readonly value: string; readonly cursor: number };
  readonly attach: AttachDraft;
  readonly skills: readonly SlashSkill[];
  readonly commandIndex: number;
  /** The terminal's size, before the frame's own floors. */
  readonly sizeColumns: number;
  readonly sizeRows: number;
  readonly contextOpen: ContextOpen | null;
  readonly queued: QueuedRows;
  readonly daemonQueue: DaemonQueue | undefined;
  readonly loading: { readonly done: number; readonly total: number } | null;
  readonly compacting: boolean;
  /**
   * The dictation strip's view-model (`voice-view.ts`), or null when it draws
   * nothing. Its rows are INSIDE the input box and counted HERE, once, so the
   * frame's height never changes while a dictation runs (P8, same rule as the
   * attach row above it).
   */
  readonly voiceStrip?: VoiceStripView | null;
}

/**
 * The frame's derived rows, in the order `App.tsx` computed them (a later row
 * reads an earlier one: the palette's window feeds the bottom area's height, the
 * heights feed the viewport, the viewport feeds where a click lands).
 */
export function frameLayout(input: FrameInput) {
  const {
    state: st,
    permission,
    dock,
    dockNow,
    subagents,
    subagentsRef,
    jobRows,
    jobRowsRef,
    drawerRow,
    drawerJob,
    jobOutput: jobOutputMap,
    dockFinished,
    quitConfirm,
    panel,
    sessionId,
    capsPhase,
    field,
    attach,
    skills,
    commandIndex,
    sizeColumns,
    sizeRows,
    contextOpen,
    queued,
    daemonQueue,
    loading,
    compacting,
    voiceStrip,
  } = input;

  const tokensShown = statusTokens(st);
  const ctxShown = contextShown(tokensShown.context, contextOpen);
  const columns = Math.max(20, sizeColumns);
  const termRows = Math.max(8, sizeRows);
  // Slash-command autocomplete: open only while idle and typing a `/command`.
  const paletteCommands =
    !permission.pending && !st.running && !panel ? matchCommands(field.value, skills) : [];
  const paletteOpen = paletteCommands.length > 0;
  const commandSel = paletteOpen
    ? Math.min(Math.max(0, commandIndex), paletteCommands.length - 1)
    : 0;
  // With many skills a bare "/" lists them all: show a window around the selection.
  const paletteWin = paletteWindow(paletteCommands.length, commandSel);
  const paletteRows = paletteCommands.slice(paletteWin.start, paletteWin.end);
  // The input box grows with a multi-line prompt (paste / `\`-continuation),
  // (and with a soft-wrapped long line), capped at MAX_INPUT_ROWS content rows;
  // +2 for its top/bottom borders.
  const inputContentLines = inputRowCount(field.value, field.cursor, columns, MAX_INPUT_ROWS);
  // One more row while the draft holds chips or an upload: the attach row sits
  // INSIDE the input box and is counted HERE, once — so the viewport shrinks by
  // one and the frame's height never changes (P8).
  const attachRow = attachRowView(attach, Math.max(1, columns - 2));
  // The dictation strip is the same kind of row: inside the input box, counted
  // once here, zero rows when it paints nothing.
  const voiceRows = voiceStrip === null || voiceStrip === undefined ? 0 : VOICE_STRIP_ROWS;
  const inputBoxRows =
    inputContentLines + 2 + attachRowRows(attach, Math.max(1, columns - 2)) + voiceRows;
  const listView = panel
    ? panelView(panel, columns, panelMaxBody(termRows), sessionId, capsPhase)
    : null;
  // The status-line marker while something is off (owner Q2): null otherwise.
  const capsShown = capsMarker(capsPhase?.kind === "on" ? capsPhase.caps : undefined);
  // Rows above the input/panel while a turn runs: the thinking line + the
  // queued-message lines (each one row: `wrap="truncate-end"`) + the send-now
  // hint row under them + one blank row between the hint and the thinking line.
  // The rows shown: the daemon's list (every writer's) + my rows not acked yet (C7).
  const shown = shownRows(queued, daemonQueue);
  const runningRows =
    (st.running || loading ? 1 : 0) +
    (st.running || compacting ? shown.length + (shown.length > 0 ? 1 : 0) : 0) +
    (st.running && shown.length > 0 ? 1 : 0);
  // Rows the bottom area occupies: the permission dialog; or the running rows,
  // then the list panel or the input box (plus any open palette rows, which
  // only open while idle).
  //
  // The dock's view-models (pure; the components only paint them) are computed
  // HERE, before the layout, because their height feeds `activeRows` (Review H3:
  // they used to be built after it, so the frame was taller than the terminal).
  // The DROPDOWN is shown only when the focus reached it: DOWN focuses the pill,
  // Enter opens the dropdown — at rest nothing is listed at all (the owner: "no
  // permanent list anywhere"). A quit confirm owns the screen. A PERMISSION PROMPT
  // does not take the dropdown away: the prompt may be a background child's ask,
  // and its row says `⚠ needs your permission` — hiding the list there made that
  // row unreachable (Review M1).
  const dockListVisible =
    dock.focus.kind === "list" && listVisible(subagents, jobRows) && quitConfirm === null;
  const dockView = dockListVisible
    ? backgroundListView({
        rows: subagentsRef.current,
        jobs: jobRowsRef.current,
        askingId: permission.pendingAgent?.id ?? null,
        focus: dock.focus,
        width: columns,
        now: dockNow,
      })
    : null;
  // The drawer: a child's (its tools and messages), or a job's (its output tail).
  const drawerOpen =
    dock.focus.kind === "open" && quitConfirm === null && !permission.pending
      ? { id: dock.focus.id, ended: dock.focus.ended }
      : null;
  const jobOutput = drawerOpen === null ? undefined : jobOutputMap[drawerOpen.id];
  const drawer =
    drawerOpen === null
      ? null
      : drawerJob !== null
        ? jobDrawerView({
            row: drawerJob,
            output: jobOutput?.output,
            ...(jobOutput?.truncated !== undefined ? { truncated: jobOutput.truncated } : {}),
            ...(jobOutput?.exitCode !== undefined ? { exitCode: jobOutput.exitCode } : {}),
            outcome: drawerOpen.ended,
            width: columns,
            now: dockNow,
            // Review 4 (fix round 1): the drawer used to be a fixed 14 rows, so on
            // a short terminal (80×20, 80×16) the frame was TALLER than the screen
            // and Ink re-cleared it on every repaint. The budget is what the
            // layout has left once the transcript's floor, the running rows and
            // the input+status block are reserved — the same parts `activeRows`
            // sums below, so `dockRows` can never reserve more than this.
            maxRows: Math.max(1, termRows - (RESERVED_ROWS - 1) - inputBoxRows - runningRows - 3),
          })
        : drawerRow !== null
          ? drawerView({
              row: drawerRow,
              sent: dock.sent[drawerOpen.id] ?? [],
              outcome: drawerOpen.ended,
              width: columns,
              now: dockNow,
            })
          : null;
  /** The rows the dock takes ABOVE the input: the dropdown's, or the drawer's. */
  // A permission prompt REPLACES the whole bottom area (it is the input, as
  // today), so nothing of the dock paints under it and it reserves no rows. The
  // "who is asking" the dropdown's ⚠ row used to carry is now the PILL's job —
  // the pill paints under the prompt (`▲ sa-1 asks`), which is strictly better:
  // it is visible with the dock closed too (docs/feat/subagent-panel.md).
  const dockHeight = permission.pending ? 0 : dockRows(dockView, drawer);
  // The status bar's pill (docs/feat/subagent-panel.md, UI revision): ONE control
  // for the background work, its words and state decided by the pure view-model.
  const pill = pillView({
    agents: subagents?.length ?? 0,
    jobs: jobRows?.length ?? 0,
    askingId: permission.pendingAgent?.id ?? null,
    finished: dockFinished,
    now: dockNow,
    focus:
      dock.focus.kind === "pill"
        ? "pill"
        : dock.focus.kind === "list"
          ? "dropdown"
          : dock.focus.kind === "open"
            ? "open"
            : "input",
    width: columns,
  });
  // The reply field's view while it is open (its rows feed the viewport maths).
  const replyMax = permission.pending?.reply?.maxChars ?? 0;
  const replyShown =
    permission.pending && permission.mode.mode === "reply"
      ? replyView(permission.mode, columns, replyMax)
      : undefined;
  const activeRows =
    quitConfirm !== null
      ? QUIT_CONFIRM_ROWS
      : permission.pending
        ? permissionPromptRows(
            permission.choices.length,
            permission.pending === null ? 0 : permissionDetailLines(permission.pending).length,
            permission.pending !== null && permissionShowsCwd(permission.pending),
            replyShown?.rows.length,
            permission.pendingAgent !== null,
          ) + dockHeight
        : runningRows +
          (listView ? panelHeight(listView) : inputBoxRows + paletteRows.length) +
          dockHeight;
  const viewport = Math.max(3, termRows - (RESERVED_ROWS - 1 + activeRows));
  // Terminal row (1-based) of the panel's first body row: the transcript
  // viewport, the bottom area's marginTop row, the running rows, the title rule.
  const panelBodyTop = viewport + 1 + runningRows + 2;
  /**
   * Where the DOCK's first row sits on screen (1-based), or `null` when it paints
   * nothing. Derived from the same parts `activeRows` sums, in the order the
   * tree paints them: the transcript viewport, the `marginTop` spacer, the running
   * rows, then the dock (the dropdown's rule + rows, or the drawer's block) — the
   * input rule, the input and the status bar come after it.
   *
   * A panel, the palette, a quit confirm and a permission prompt each own that
   * slot instead, and none of them paints the dock.
   */
  const dockTop =
    dockHeight === 0 || listView || paletteOpen || quitConfirm !== null || permission.pending
      ? null
      : viewport + 1 + runningRows + 1;
  /**
   * The row the STATUS BAR paints on (1-based): the frame's own rows, derived
   * exactly as the tree lays them out (the transcript viewport, the spacer, the
   * running rows, the dock, the input box), plus the bar's own one.
   *
   * It is a number, not a write: `App` owns `statusRowRef` and its `onPillRange`
   * callback pairs this row with the cell range the bar reports. The App must not
   * re-derive either (AGENTS §7: one source of truth — the component paints and
   * reports, it decides nothing), which is why the arithmetic lives here, once.
   */
  const statusRowY = viewport + 1 + runningRows + dockHeight + inputBoxRows + 1;

  return {
    tokensShown,
    ctxShown,
    columns,
    termRows,
    paletteCommands,
    paletteOpen,
    commandSel,
    paletteWin,
    paletteRows,
    inputContentLines,
    attachRow,
    voiceStrip,
    voiceRows,
    inputBoxRows,
    listView,
    capsShown,
    shown,
    runningRows,
    dockListVisible,
    dockView,
    drawerOpen,
    jobOutput,
    drawer,
    dockHeight,
    pill,
    replyMax,
    replyShown,
    activeRows,
    viewport,
    panelBodyTop,
    dockTop,
    statusRowY,
  };
}

/** The frame's view-model: what `App` hands `AppView` besides the raw render values. */
export type FrameLayout = ReturnType<typeof frameLayout>;

/**
 * The whole model `AppView` renders: the computed rows (`FrameLayout`), the
 * render values and the transcript window the tree paints, the callbacks it
 * fires, and nothing that is a decision (the view re-derives no geometry).
 *
 * Every field is either a value `App`'s render already held or a `FrameLayout`
 * row, which is what makes the move checkable: `AppView` destructures these back
 * to the pre-move identifiers, so no use site inside the tree changed.
 */
export type AppViewModel = FrameLayout & {
  /** The transcript's state (`stateRef.current`), read by the tree's own copy. */
  readonly st: DisplayState;
  readonly field: {
    readonly value: string;
    readonly cursor: number;
    readonly anchor: number | null;
  };
  readonly permission: PermissionController;
  readonly dock: DockState;
  readonly drawerJob: DockJobRow | null;
  readonly linkView: LinkIndicator | null;
  readonly shownModel: string;
  readonly shownTarget: TargetBadge | null;
  readonly cwd: string;
  readonly contextWindow: number;
  readonly expandAll: boolean;
  readonly selection: Selection | null;
  readonly quitConfirm: QuitConfirmFacts | null;
  /** The hop's own status row (`null`: no hop runs — the normal bar paints). */
  readonly hopRow: string | null;
  readonly loading: { readonly done: number; readonly total: number } | null;
  readonly compacting: boolean;
  /** The visible transcript window: where it starts, its rows, and the flags. */
  readonly win: { readonly start: number; readonly end: number };
  readonly visible: readonly string[];
  readonly scrolledUp: boolean;
  readonly hiddenAbove: number;
  /**
   * The bar's report of the cells it painted the pill in. `App` supplies it (it
   * writes `statusRowRef`); the view only forwards it — §7: the component paints
   * and reports, the App owns the click's state.
   */
  readonly onPillRange:
    | ((range: { readonly start: number; readonly end: number } | null) => void)
    | undefined;
};
