/**
 * The `/mcp` panel's logic (docs/feat/mcp-tools-panel.md), React-free: the rows
 * it shows, how keys and clicks move through them, and the windowed view that
 * `components/McpPanel.tsx` only renders.
 *
 * The cursor walks every row (servers and the tool rows of the expanded ones),
 * so a long tool list scrolls like any other. Every daemon string passes
 * through `oneLine` (bidi/zero-width dropped) before it is shown: the schema
 * only rejects control characters, and the daemon may be a pod.
 */
import { oneLine, paletteWindow } from "./commands.ts";

/** One MCP server as `mcp/status` reports it. */
export interface McpServerView {
  readonly name: string;
  readonly state: "connecting" | "connected" | "unresponsive" | "closed" | "failed";
  /** Bare tool names, the first ≤128; `moreTools` counts the rest. */
  readonly tools: readonly string[];
  readonly moreTools: number;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface McpPanel {
  /** The servers, or null while the probe is in flight. */
  readonly servers: readonly McpServerView[] | null;
  /** Indices (into `servers`) of the expanded servers. */
  readonly expanded: readonly number[];
  /** Index into `panelRows(panel)`. */
  readonly cursor: number;
}

export type PanelRow =
  | { readonly kind: "server"; readonly server: number }
  | { readonly kind: "tool"; readonly server: number; readonly name: string }
  | { readonly kind: "more"; readonly server: number; readonly count: number }
  | { readonly kind: "info"; readonly server: number; readonly text: string };

export type PanelAction = "up" | "down" | "toggle" | "expand" | "collapse" | "close" | "none";

/** The subset of Ink's `Key` the panel reads. */
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
  readonly kind: PanelRow["kind"] | "note";
  readonly selected: boolean;
}

export interface PanelView {
  readonly title: string;
  readonly rows: readonly PanelViewRow[];
  readonly hint: string;
  /** Index (into `panelRows`) of `rows[0]`. */
  readonly start: number;
}

const GLYPH: Readonly<Record<McpServerView["state"], string>> = {
  connected: "●",
  connecting: "…",
  unresponsive: "!",
  closed: "○",
  failed: "✗",
};

/** Server names are padded to align the state column, up to this width. */
const NAME_COLUMN_MAX = 24;
/** Indent of a server's child rows (under the cursor marker and the ▸). */
const CHILD_INDENT = "      ";

export const openPanel = (): McpPanel => ({ servers: null, expanded: [], cursor: 0 });

/** The probe answered: show its servers, all collapsed. */
export const loadPanel = (servers: readonly McpServerView[]): McpPanel => ({
  servers,
  expanded: [],
  cursor: 0,
});

/** The rows in display order: each server, then (if expanded) its details. */
export function panelRows(panel: McpPanel): PanelRow[] {
  const rows: PanelRow[] = [];
  for (const [server, s] of (panel.servers ?? []).entries()) {
    rows.push({ kind: "server", server });
    if (!panel.expanded.includes(server)) {
      continue;
    }
    if (s.state === "connecting") {
      rows.push({ kind: "info", server, text: "still connecting" });
    } else if (s.state !== "connected") {
      rows.push({ kind: "info", server, text: oneLine(s.error ?? "") || s.state });
    }
    for (const name of s.tools) {
      rows.push({ kind: "tool", server, name: oneLine(name) });
    }
    if (s.moreTools > 0) {
      rows.push({ kind: "more", server, count: s.moreTools });
    }
    if (s.state === "connected" && s.tools.length + s.moreTools === 0) {
      rows.push({ kind: "info", server, text: "no tools" });
    }
  }
  return rows;
}

export function panelKey(input: string, key: PanelKeyState): PanelAction {
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

/** Collapse `server` and put the cursor on its row. */
function collapse(panel: McpPanel, server: number): McpPanel {
  const next = { ...panel, expanded: panel.expanded.filter((i) => i !== server) };
  const at = panelRows(next).findIndex((r) => r.kind === "server" && r.server === server);
  return { ...next, cursor: Math.max(0, at) };
}

/** The panel after `action` ("close" and "none" leave it as is: the App closes it). */
export function applyPanel(panel: McpPanel, action: PanelAction): McpPanel {
  const rows = panelRows(panel);
  const n = rows.length;
  if (n === 0) {
    return panel;
  }
  const cursor = clampCursor(panel.cursor, n);
  const row = rows[cursor];
  switch (action) {
    case "up":
      return { ...panel, cursor: (cursor - 1 + n) % n };
    case "down":
      return { ...panel, cursor: (cursor + 1) % n };
    case "toggle":
      if (row?.kind === "server" && !panel.expanded.includes(row.server)) {
        return { ...panel, expanded: [...panel.expanded, row.server], cursor };
      }
      return row ? collapse(panel, row.server) : panel;
    case "expand":
      if (row?.kind === "server" && !panel.expanded.includes(row.server)) {
        return { ...panel, expanded: [...panel.expanded, row.server], cursor };
      }
      return panel;
    case "collapse":
      if (row && (row.kind !== "server" || panel.expanded.includes(row.server))) {
        return collapse(panel, row.server);
      }
      return panel;
    default:
      return panel;
  }
}

/** `text` cut to `width` columns (a trailing … marks the cut). */
function fit(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

const toolCount = (n: number): string => `${n} tool${n === 1 ? "" : "s"}`;

function serverText(s: McpServerView, nameWidth: number, open: boolean): string {
  const total = s.tools.length + s.moreTools;
  const head = `${open ? "▾" : "▸"} ${oneLine(s.name).padEnd(nameWidth)}  ${GLYPH[s.state]} ${s.state}`;
  switch (s.state) {
    case "connected":
      return `${head} · ${toolCount(total)} · ${s.latencyMs ?? 0} ms`;
    case "closed":
    case "unresponsive":
      return `${head} · ${toolCount(total)}`;
    default:
      return head;
  }
}

function rowText(
  row: PanelRow,
  servers: readonly McpServerView[],
  nameWidth: number,
  panel: McpPanel,
): string {
  switch (row.kind) {
    case "server": {
      const s = servers[row.server];
      return s ? serverText(s, nameWidth, panel.expanded.includes(row.server)) : "";
    }
    case "tool":
      return `${CHILD_INDENT}${row.name}`;
    case "more":
      return `${CHILD_INDENT}… ${row.count} more`;
    case "info":
      return `${CHILD_INDENT}${row.text}`;
  }
}

/** Body rows the panel may use on a terminal `termRows` tall (it never takes over the screen). */
export const panelMaxBody = (termRows: number): number => Math.max(3, Math.floor(termRows / 2) - 2);

/** The view at `width` columns with at most `maxBody` body rows, windowed on the cursor. */
export function panelView(panel: McpPanel, width: number, maxBody: number): PanelView {
  const note = (text: string): PanelViewRow => ({
    text: fit(`  ${text}`, width),
    kind: "note",
    selected: false,
  });
  const hint = "↑↓ select · enter expand · esc close";
  const servers = panel.servers;
  if (servers === null) {
    return {
      title: "MCP servers · probing…",
      rows: [note("Asking the daemon…")],
      hint: "esc close",
      start: 0,
    };
  }
  if (servers.length === 0) {
    return {
      title: "MCP servers",
      rows: [note("No MCP servers on this daemon.")],
      hint: "esc close",
      start: 0,
    };
  }
  const rows = panelRows(panel);
  const cursor = clampCursor(panel.cursor, rows.length);
  const nameWidth = Math.min(
    NAME_COLUMN_MAX,
    servers.reduce((w, s) => Math.max(w, oneLine(s.name).length), 0),
  );
  const win = paletteWindow(rows.length, cursor, Math.max(1, maxBody));
  const reachable = servers.filter((s) => s.state === "connected").length;
  return {
    title: `MCP servers · ${reachable} of ${servers.length} reachable`,
    rows: rows.slice(win.start, win.end).map((row, i) => {
      const selected = win.start + i === cursor;
      return {
        text: fit(`${selected ? "❯ " : "  "}${rowText(row, servers, nameWidth, panel)}`, width),
        kind: row.kind,
        selected,
      };
    }),
    hint:
      win.end - win.start < rows.length
        ? `${hint} · ${win.start + 1}–${win.end} of ${rows.length}`
        : hint,
    start: win.start,
  };
}

/** Rows the panel occupies: the title rule, the body, the hint. */
export const panelHeight = (view: PanelView): number => view.rows.length + 2;

/**
 * A click on body row `bodyIndex` (0 = the row under the title): the cursor
 * moves there, and a server row also expands/collapses. Elsewhere: unchanged.
 */
export function panelClick(panel: McpPanel, view: PanelView, bodyIndex: number): McpPanel {
  const rows = panelRows(panel);
  const index = view.start + bodyIndex;
  if (bodyIndex < 0 || bodyIndex >= view.rows.length || index >= rows.length) {
    return panel;
  }
  const moved = { ...panel, cursor: index };
  return rows[index]?.kind === "server" ? applyPanel(moved, "toggle") : moved;
}
