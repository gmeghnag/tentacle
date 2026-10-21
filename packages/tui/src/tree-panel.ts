/**
 * A list panel's logic (`/mcp`, `/skills`; docs/feat/skills-panel.md),
 * React-free: groups (a head row and child rows shown when it is expanded),
 * the cursor, keys, clicks and the windowed view `components/ListPanel.tsx`
 * only renders. What a group says is a projection's job (`mcp-panel.ts`,
 * `skills-panel.ts`); `panel.ts` binds the two.
 *
 * The cursor walks every visible row (heads and the children of the expanded
 * groups), so a long child list scrolls like any other.
 */
import { paletteWindow } from "./commands.ts";

/** A head row and the rows shown under it when expanded (display-safe text). */
export interface TreeGroup {
  readonly head: string;
  readonly children: readonly string[];
}

export interface TreeState {
  /** Indices of the expanded groups. */
  readonly expanded: readonly number[];
  /** Index into `treeRows`. */
  readonly cursor: number;
}

export const TREE_START: TreeState = { expanded: [], cursor: 0 };

/** One visible row: a group's head (`child` null) or one of its children. */
export interface TreeRow {
  readonly group: number;
  readonly child: number | null;
}

export type TreeAction = "up" | "down" | "toggle" | "expand" | "collapse" | "close" | "none";

/** The subset of Ink's `Key` a panel reads. */
export interface PanelKeyState {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
}

export interface PanelViewRow {
  /** One terminal row, already cut to the width. */
  readonly text: string;
  readonly kind: "head" | "child" | "note";
  readonly selected: boolean;
}

export interface PanelView {
  readonly title: string;
  readonly rows: readonly PanelViewRow[];
  readonly hint: string;
  /** Index (into `treeRows`) of `rows[0]`. */
  readonly start: number;
}

/** Indent of a child row, after the cursor marker (lines up under the head's text). */
const CHILD_INDENT = "      ";
const HINT = "↑↓ select · enter expand · esc close";

export function treeRows(groups: readonly TreeGroup[], state: TreeState): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const [group, g] of groups.entries()) {
    rows.push({ group, child: null });
    if (state.expanded.includes(group)) {
      for (const child of g.children.keys()) {
        rows.push({ group, child });
      }
    }
  }
  return rows;
}

export function treeKey(input: string, key: PanelKeyState): TreeAction {
  if (key.escape || input === "q") {
    return "close";
  }
  if (key.upArrow) {
    return "up";
  }
  if (key.downArrow) {
    return "down";
  }
  if (key.return || input === " ") {
    return "toggle";
  }
  if (key.rightArrow) {
    return "expand";
  }
  if (key.leftArrow) {
    return "collapse";
  }
  return "none";
}

const clampCursor = (cursor: number, count: number): number =>
  Math.min(Math.max(0, cursor), Math.max(0, count - 1));

/** Collapse `group` and put the cursor on its head. */
function collapse(groups: readonly TreeGroup[], state: TreeState, group: number): TreeState {
  const expanded = state.expanded.filter((i) => i !== group);
  const at = treeRows(groups, { expanded, cursor: 0 }).findIndex(
    (r) => r.group === group && r.child === null,
  );
  return { expanded, cursor: Math.max(0, at) };
}

/** The state after `action` ("close" and "none" leave it as is: the App closes). */
export function applyTree(
  groups: readonly TreeGroup[],
  state: TreeState,
  action: TreeAction,
): TreeState {
  const rows = treeRows(groups, state);
  const n = rows.length;
  if (n === 0) {
    return state;
  }
  const cursor = clampCursor(state.cursor, n);
  const row = rows[cursor];
  const closedHead =
    row !== undefined &&
    row.child === null &&
    !state.expanded.includes(row.group) &&
    (groups[row.group]?.children.length ?? 0) > 0;
  switch (action) {
    case "up":
      return { ...state, cursor: (cursor - 1 + n) % n };
    case "down":
      return { ...state, cursor: (cursor + 1) % n };
    case "toggle":
      if (closedHead) {
        return { expanded: [...state.expanded, row.group], cursor };
      }
      return row && state.expanded.includes(row.group) ? collapse(groups, state, row.group) : state;
    case "expand":
      return closedHead ? { expanded: [...state.expanded, row.group], cursor } : state;
    case "collapse":
      return row && state.expanded.includes(row.group) ? collapse(groups, state, row.group) : state;
    default:
      return state;
  }
}

/** `text` cut to `width` columns (a trailing … marks the cut). */
export function fit(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/** A panel with one note instead of rows (loading, empty). */
export function noteView(title: string, note: string, width: number): PanelView {
  return {
    title,
    rows: [{ text: fit(`  ${note}`, width), kind: "note", selected: false }],
    hint: "esc close",
    start: 0,
  };
}

/** The view at `width` columns with at most `maxBody` body rows, windowed on the cursor. */
export function treeView(
  title: string,
  groups: readonly TreeGroup[],
  state: TreeState,
  width: number,
  maxBody: number,
): PanelView {
  const rows = treeRows(groups, state);
  const cursor = clampCursor(state.cursor, rows.length);
  const win = paletteWindow(rows.length, cursor, Math.max(1, maxBody));
  return {
    title,
    rows: rows.slice(win.start, win.end).map((row, i) => {
      const selected = win.start + i === cursor;
      const marker = selected ? "❯ " : "  ";
      const g = groups[row.group];
      let text: string;
      if (row.child === null) {
        const arrow =
          (g?.children.length ?? 0) === 0 ? " " : state.expanded.includes(row.group) ? "▾" : "▸";
        text = `${marker}${arrow} ${g?.head ?? ""}`;
      } else {
        text = `${marker}${CHILD_INDENT}${g?.children[row.child] ?? ""}`;
      }
      return { text: fit(text, width), kind: row.child === null ? "head" : "child", selected };
    }),
    hint:
      win.end - win.start < rows.length
        ? `${HINT} · ${win.start + 1}–${win.end} of ${rows.length}`
        : HINT,
    start: win.start,
  };
}

/** Rows a panel occupies: the title rule, the body, the hint. */
export const panelHeight = (view: PanelView): number => view.rows.length + 2;

/** Body rows a panel may use on a terminal `termRows` tall (it never takes over the screen). */
export const panelMaxBody = (termRows: number): number => Math.max(3, Math.floor(termRows / 2) - 2);

/**
 * A click on body row `bodyIndex` (0 = the row under the title): the cursor
 * moves there, and a head also expands/collapses. Elsewhere: unchanged.
 */
export function treeClick(
  groups: readonly TreeGroup[],
  state: TreeState,
  view: PanelView,
  bodyIndex: number,
): TreeState {
  const rows = treeRows(groups, state);
  const index = view.start + bodyIndex;
  if (bodyIndex < 0 || bodyIndex >= view.rows.length || index >= rows.length) {
    return state;
  }
  const moved = { ...state, cursor: index };
  return rows[index]?.child === null ? applyTree(groups, moved, "toggle") : moved;
}

/** `text` word-wrapped to `width`, at most `maxLines` lines (the last ends in … if cut). */
export function wrapText(text: string, width: number, maxLines: number): string[] {
  const w = Math.max(10, width);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ").filter((x) => x !== "")) {
    let rest = word;
    while (rest.length > w) {
      if (line !== "") {
        lines.push(line);
        line = "";
      }
      lines.push(rest.slice(0, w));
      rest = rest.slice(w);
    }
    if (line === "") {
      line = rest;
    } else if (line.length + 1 + rest.length <= w) {
      line = `${line} ${rest}`;
    } else {
      lines.push(line);
      line = rest;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${fit(kept[maxLines - 1] ?? "", w - 1)}…`;
  return kept;
}
