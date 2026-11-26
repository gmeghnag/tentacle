/**
 * The MOUSE layer of the TUI's single key handler (docs/feat/app-decomposition.md
 * S4), as pure data: no React, no refs, no timers. Two decisions live here, and
 * `App` only executes them.
 *
 * 1. **The chunk state machine** (`stepMouseChunk`). Ink strips the leading ESC
 *    and hands the whole read as `char`, so one chunk may carry any number of
 *    complete SGR reports plus, at the end, a half-delivered one — and some
 *    terminals/ptys split one report across two chunks, the first half then
 *    arriving as a bare `[`, indistinguishable from a typed bracket. The step
 *    decides: which reports to dispatch, what to hold for the next chunk, and
 *    whether a held `[` was really typed (the CARRY the next layer must see).
 *
 * 2. **The per-event dispatch** (`dispatchMouse`). ONE report in, the effects
 *    the App must apply out, plus the new state (the click recogniser's, and the
 *    text selection). Every hit test is the view-models' (the pill's cell range
 *    is `statusLayout`'s, the dock rows' are their screen rows, the tool call's
 *    is `tool-hit.ts`'s), so nothing here re-derives a layout.
 *
 * Why a per-event function and not a hook: the router (S3) calls it with a
 * render SNAPSHOT at the moment of the event, so the decision's inputs are
 * declared and testable, and a coalesced chunk's reports are threaded through
 * one state instead of re-reading render values between reports that no render
 * has separated (docs/feat/app-decomposition.md, Fable H3's freshness rule).
 */

import type { ArtifactMeta } from "@tentacle/protocol";
import type { Key } from "ink";
import type { BackgroundListView } from "./background-list.ts";
import { type MouseReport, isMousePrefix, splitMouseReports } from "./mouse.ts";
import type { LaidItem } from "./render-lines.ts";
import type { ScrollWindow } from "./scroll.ts";
import type { Selection } from "./selection.ts";
import { type ClickState, nextClick } from "./tool-expand.ts";
import { linkAtViewport, toolCallAtViewport } from "./tool-hit.ts";
import type { PanelView } from "./tree-panel.ts";

/** Lines scrolled per mouse-wheel notch. */
export const WHEEL_LINES = 3;

// --- the chunk state machine ----------------------------------------------

/**
 * What one input chunk asks the mouse layer: the partial report held from the
 * previous chunk, this chunk's bytes, the key Ink parsed from them, and whether
 * a panel is open (behind one, nothing edits the hidden input).
 */
export interface MouseChunkInput {
  readonly held: string;
  readonly char: string;
  readonly key: Key;
  readonly panelOpen: boolean;
}

/**
 * The mouse layer's step for one chunk — the layer contract S3 generalises:
 * `verdict` is `consumed` when the layer took the chunk (reports dispatched, a
 * partial held, or a panel swallowed it); `pass` means the rest of the router
 * still runs, with `restored` as its CARRY (a held `[` that was really typed).
 */
export interface MouseChunkStep {
  /** Every complete report in the chunk, in order. */
  readonly reports: readonly MouseReport[];
  /** A partial report to hold for the next chunk (see `holdMouse`), or null. */
  readonly hold: string | null;
  /** A held bare `[` that was a typed bracket after all; empty when none. */
  readonly restored: string;
  /** `restored` is armed and this event is Enter: submit it with the key. */
  readonly submit: boolean;
  /** A panel is open: nothing edits the (hidden) input. */
  readonly swallowBehindPanel: boolean;
  readonly verdict: "consumed" | "pass";
}

/**
 * Whether this event is a "plain" key: no navigation, no control chord, no
 * escape. A chunk that is only a growable report prefix is HELD when plain
 * (`[` may be the first half of a report) and treated as a key when not (a
 * keypress means the `[` was typed).
 */
export function plainKeyOf(key: Key): boolean {
  return (
    !key.return &&
    !key.ctrl &&
    !key.meta &&
    !key.tab &&
    !key.escape &&
    !key.upArrow &&
    !key.downArrow &&
    !key.pageUp &&
    !key.pageDown &&
    !key.leftArrow &&
    !key.rightArrow &&
    !key.backspace &&
    !key.delete
  );
}

/**
 * Resolve one input chunk into the mouse layer's step. The caller has already
 * taken (and cleared) its own hold; `input.held` is that value, so this is a
 * pure function of the chunk.
 */
export function stepMouseChunk(input: MouseChunkInput): MouseChunkStep {
  const data = input.held + input.char;
  const { reports, rest } = splitMouseReports(data);
  if (reports.length > 0) {
    // A trailing, half-delivered report is held; any other leftover is dropped
    // (it is not a report and not a prefix of one).
    return {
      reports,
      hold: isMousePrefix(rest) ? rest : null,
      restored: "",
      submit: false,
      swallowBehindPanel: false,
      verdict: "consumed",
    };
  }
  // No complete report. If the chunk is still a growable report prefix (and
  // this event is not a real keypress), keep holding it for the next chunk.
  if (isMousePrefix(data) && plainKeyOf(input.key)) {
    return {
      reports,
      hold: data,
      restored: "",
      submit: false,
      swallowBehindPanel: false,
      verdict: "consumed",
    };
  }
  // Behind a list panel nothing edits the (hidden) input — not even a restored
  // bracket: it is dropped with the hold.
  if (input.panelOpen) {
    return {
      reports,
      hold: null,
      restored: "",
      submit: false,
      swallowBehindPanel: true,
      verdict: "consumed",
    };
  }
  // Not a report or a continuable prefix: a held bare "[" was a typed bracket,
  // so it is restored (a longer truncated hold is dropped). It precedes
  // whatever this event's own key does, and Enter submits it in the same event.
  const restored = input.held === "[" ? "[" : "";
  return {
    reports,
    hold: null,
    restored,
    submit: restored !== "" && input.key.return === true,
    swallowBehindPanel: false,
    verdict: "pass",
  };
}

// --- the per-event dispatch -----------------------------------------------

/** The status bar's row and the pill's cells on it, as `StatusBar` reported them. */
export interface StatusRowRange {
  readonly y: number;
  readonly pill: { readonly start: number; readonly end: number } | null;
}

/** The mouse layer's own state, threaded across the reports of one chunk. */
export interface MouseState {
  /** The click recogniser's (`tool-expand.ts`). */
  readonly click: ClickState;
  /** The live text selection (the App's ref mirror of its state). */
  readonly selection: Selection | null;
}

/**
 * What one report's decision reads off the render it landed on. Passed in at the
 * moment of the event (a SNAPSHOT), never re-read per report: a coalesced
 * chunk's reports see the same frame, exactly as the painted frame is.
 */
export interface MouseSnapshot {
  /** The open panel's view-model, or null when no panel is open. */
  readonly listView: PanelView | null;
  /**
   * A panel is open, as TODAY's source has it: the RENDER value in the key path
   * (S0b's freshness pin — in a handler closure the ref and the render value are
   * the same value, and this one is not "cleaned up" into a ref here).
   */
  readonly panelOpen: boolean;
  /** The panel's width, for `panelClick`. */
  readonly columns: number;
  /** Terminal row (1-based) of the panel's first body row. */
  readonly panelBodyTop: number;
  /** The dock's dropdown rule row (1-based), or null when it paints nothing. */
  readonly dockTop: number | null;
  /** The dock's dropdown view-model, or null when it is closed. */
  readonly dockView: BackgroundListView | null;
  /** The bar's row and the pill's cell range, as the last render reported them. */
  readonly statusRow: StatusRowRange | null;
  /** The transcript's positional layout (the tool-call hit test reads it). */
  readonly laid: readonly LaidItem[];
  /** The transcript's window (the hit test's viewport bound). */
  readonly win: ScrollWindow;
  /** The transcript's whole row count (a scroll clamps against it). */
  readonly total: number;
  /** The transcript viewport's height (a scroll clamps against it). */
  readonly viewport: number;
  /** How many transcript rows are on screen (`visible.length`). */
  readonly visibleCount: number;
  /** Ctrl+O: every call's command already shows, so a click has nothing to reveal. */
  readonly expandAll: boolean;
  /**
   * The artifact call `id`'s row carries (`artifact-open.ts: artifactOfCall`), or
   * undefined. A click on such a header OPENS it (docs/feat/tui-present-row.md).
   */
  readonly artifactOf: (id: string) => ArtifactMeta | undefined;
}

/**
 * What the App must DO for one report. Data, not calls: the effects keep their
 * ORDER, and the App applies them with the state it owns (`setScrollOffset`'s
 * functional update, `setPanel`, `setDock`, the clipboard).
 *
 * The text SELECTION is not an effect: it is part of `MouseState`, because a
 * drag in a coalesced chunk extends the selection the previous report in the
 * SAME chunk just made (which no render separates). The App applies a report's
 * effects FIRST and its state after — a release's `copySelection` still reads
 * the selection it is clearing, exactly as the inline handler did.
 */
export type MouseEffect =
  /** Scroll by `delta` lines (clamped by the App against `total`/`viewport`). */
  | { readonly kind: "scroll"; readonly delta: number }
  /** A click on the panel's body row `bodyIndex` (`panelClick` decides). */
  | { readonly kind: "panelClick"; readonly bodyIndex: number }
  /** A click on the dock's PILL (`clickDock` decides what it means). */
  | { readonly kind: "dockPill" }
  /** A click on the dock's row for item `id`. */
  | { readonly kind: "dockRow"; readonly id: string }
  /** A completed click on a tool call's header row: toggle its expansion. */
  | { readonly kind: "toggleTool"; readonly id: string }
  /**
   * A completed click on a `present` call's header: open its artifact through the
   * App's ONE artifact path (`artifactStep` → confirm / open / notice), exactly
   * what `^X^O` and `/artifacts`' Enter do.
   */
  | { readonly kind: "openArtifact"; readonly artifact: ArtifactMeta }
  /** A completed click on a URL in the transcript (`links.ts` spans). */
  | { readonly kind: "openLink"; readonly url: string }
  /** Copy the current selection (the App assembles the whole buffer) and clear it. */
  | { readonly kind: "copySelection" };

export interface MouseStep {
  readonly state: MouseState;
  readonly effects: readonly MouseEffect[];
}

const NONE: readonly MouseEffect[] = [];

/**
 * Dispatch ONE SGR mouse report: the new state, plus the effects to apply.
 *
 * Order is the whole priority list and must not be rearranged: the wheel; the
 * list panel's body; the dock's pill and rows; the click recogniser, a tool
 * call's header and a link; then the selection (a release copies it, a press
 * starts or extends it).
 */
export function dispatchMouse(
  state: MouseState,
  report: MouseReport,
  snapshot: MouseSnapshot,
): MouseStep {
  // Wheel notches (64=up, 65=down).
  if (report.btn & 64) {
    const delta = report.btn & 1 ? -WHEEL_LINES : WHEEL_LINES;
    return { state, effects: [{ kind: "scroll", delta }] };
  }
  // A left press on a list panel body row selects it (a head row also
  // expands/collapses). Drags and releases there do nothing.
  const { listView, panelBodyTop } = snapshot;
  if (listView && report.y >= panelBodyTop && report.y < panelBodyTop + listView.rows.length) {
    if (report.press && report.btn === 0) {
      const bodyIndex = report.y - panelBodyTop;
      return { state, effects: [{ kind: "panelClick", bodyIndex }] };
    }
    return { state, effects: NONE };
  }
  // The DOCK's two controls (docs/feat/subagent-panel.md, UI revision): a click
  // on the PILL opens the dropdown; a click on a dropdown ROW opens that child.
  if (report.press && report.btn === 0) {
    const range = snapshot.statusRow;
    // The bar is the row the component just painted, and `report.y` is 1-based
    // on the same frame; the range is in cells, also 1-based per column.
    const clickedPill =
      range !== null &&
      range.pill !== null &&
      report.y === range.y &&
      report.x > range.pill.start &&
      report.x <= range.pill.end;
    if (clickedPill) {
      return { state, effects: [{ kind: "dockPill" }] };
    }
    // `dockTop` is the dropdown's own RULE row; row 0 is the one under it.
    const rowIndex =
      snapshot.dockTop !== null &&
      report.y > snapshot.dockTop &&
      report.y <= snapshot.dockTop + (snapshot.dockView?.rows.length ?? 0)
        ? report.y - snapshot.dockTop - 1
        : -1;
    const rowId = rowIndex < 0 ? undefined : snapshot.dockView?.rows[rowIndex]?.id;
    if (rowId !== undefined && rowId !== "") {
      return { state, effects: [{ kind: "dockRow", id: rowId }] };
    }
  }
  // Left button, part 1: classify the report as click / drag / neither. The
  // whole rule is `tool-expand.ts`'s (`nextClick`); here we only feed it and
  // act on a completed click. A click is a press and a release on the SAME cell
  // with no motion in between, and a coalesced chunk (both reports in one
  // write) is seen as press then release, in order.
  const step = nextClick(state.click, report);
  const click = step.state;
  if (step.click) {
    // The call under the cursor's SCREEN row, or null when the row is outside
    // the transcript viewport (the prompt rule, the input box, the status bar)
    // — `tool-hit.ts` owns the whole rule, window included.
    const id = toolCallAtViewport(snapshot.laid, snapshot.win, step.click.y);
    // A `present` header with its card OPENS the artifact (Ctrl+O or not: there
    // is nothing to expand on it, its args are not a command).
    const artifact = id === null ? undefined : snapshot.artifactOf(id);
    if (artifact !== undefined) {
      return { state: { click, selection: null }, effects: [{ kind: "openArtifact", artifact }] };
    }
    // Only a tool call's header (and a shell's `$` rows) is a control; elsewhere the click stays
    // what it is today (a zero-length selection, i.e. nothing).
    if (id !== null && !snapshot.expandAll) {
      return { state: { click, selection: null }, effects: [{ kind: "toggleTool", id }] };
    }
    // A URL opens, Ctrl+O or not (a control row has no link: `linkAtViewport`).
    const url = linkAtViewport(snapshot.laid, snapshot.win, step.click.x, step.click.y);
    if (url !== null) {
      return { state: { click, selection: null }, effects: [{ kind: "openLink", url }] };
    }
  }
  // Left button, part 2: release copies the selection, press/drag starts or
  // extends it.
  if (!report.press) {
    // Selection can span rows scrolled out of view, so the App assembles the
    // whole buffer on release — never on the per-frame render path.
    return { state: { click, selection: null }, effects: [{ kind: "copySelection" }] };
  }
  const visibleIndex = report.y - 1;
  if ((report.btn & 3) === 0 && visibleIndex >= 0 && visibleIndex < snapshot.visibleCount) {
    const row = snapshot.win.start + visibleIndex;
    const col = Math.max(0, report.x - 1);
    const point = { row, col };
    const dragging = (report.btn & 32) !== 0;
    const selection =
      dragging && state.selection
        ? { anchor: state.selection.anchor, head: point }
        : { anchor: point, head: point };
    return { state: { click, selection }, effects: NONE };
  }
  return { state: { click, selection: state.selection }, effects: NONE };
}
