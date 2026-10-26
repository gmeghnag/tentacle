/**
 * The panel the App has open (`/mcp`, `/skills` or `/sessions`), as ONE state with ONE
 * key/mouse route (docs/feat/skills-panel.md): this module dispatches on the
 * kind to the projection (`mcp-panel.ts`, `skills-panel.ts`) and hands the
 * mechanics to `tree-panel.ts`. Pure; `data` is null while the request is in
 * flight.
 */
import { type McpServerView, mcpGroups, mcpTitle } from "./mcp-panel.ts";
import {
  SESSIONS_START,
  type SessionsState,
  type SessionsView,
  sessionsMove,
  sessionsView,
} from "./sessions-panel.ts";
import { type SkillsListView, skillGroups, skillsEmpty, skillsTitle } from "./skills-panel.ts";
import {
  type PanelView,
  TREE_START,
  type TreeAction,
  type TreeGroup,
  type TreeState,
  applyTree,
  noteView,
  treeClick,
  treeView,
} from "./tree-panel.ts";

/** A tree panel (`/mcp`, `/skills`): groups and an expandable cursor. */
export type TreePanel =
  | {
      readonly kind: "mcp";
      readonly data: readonly McpServerView[] | null;
      readonly tree: TreeState;
    }
  | { readonly kind: "skills"; readonly data: SkillsListView | null; readonly tree: TreeState };

/** `/sessions` (docs/feat/connect-sessions.md): a flat list with its own cursor. */
export interface SessionsPanel {
  readonly kind: "sessions";
  readonly data: SessionsView | null;
  readonly state: SessionsState;
  /** When the list was read (the rows' ages). */
  readonly now: number;
  // No "current" here (Review R3-1): the session this TUI shows is read live
  // (`panelView`'s `current`, the App's key route) — never a captured copy.
}

export type OpenPanel = TreePanel | SessionsPanel;

export const sessionsPanel = (now: number, data: SessionsView | null = null): SessionsPanel => ({
  kind: "sessions",
  data,
  state: SESSIONS_START,
  now,
});

export const mcpPanel = (data: readonly McpServerView[] | null = null): TreePanel => ({
  kind: "mcp",
  data,
  tree: TREE_START,
});

export const skillsPanel = (data: SkillsListView | null = null): TreePanel => ({
  kind: "skills",
  data,
  tree: TREE_START,
});

/** `panel` with `tree` — the same object when nothing moved (no re-render). */
const withTree = (panel: TreePanel, tree: TreeState): TreePanel =>
  tree === panel.tree ? panel : { ...panel, tree };

/** The groups at `width`, or null while loading. */
function groupsOf(panel: TreePanel, width: number): TreeGroup[] | null {
  if (panel.kind === "mcp") {
    return panel.data ? mcpGroups(panel.data) : null;
  }
  return panel.data ? skillGroups(panel.data, width) : null;
}

/** `current`: the live session's id (the `/sessions` panel marks its row). */
export function panelView(
  panel: OpenPanel,
  width: number,
  maxBody: number,
  current: string | null = null,
): PanelView {
  if (panel.kind === "sessions") {
    return sessionsView(panel.data, panel.state, current, panel.now, width, maxBody);
  }
  if (panel.kind === "mcp") {
    if (!panel.data) {
      return noteView("MCP servers · probing…", "Asking the daemon…", width);
    }
    if (panel.data.length === 0) {
      return noteView("MCP servers", "No MCP servers on this daemon.", width);
    }
    return treeView(mcpTitle(panel.data), mcpGroups(panel.data), panel.tree, width, maxBody);
  }
  if (!panel.data) {
    return noteView("Skills · loading…", "Asking the daemon…", width);
  }
  if (skillsEmpty(panel.data)) {
    return noteView("Skills", "No skills on this daemon.", width);
  }
  return treeView(
    skillsTitle(panel.data),
    skillGroups(panel.data, width),
    panel.tree,
    width,
    maxBody,
  );
}

/** The panel after a key action, at `width` (the projection may wrap to it). */
export function applyPanel(panel: TreePanel, action: TreeAction, width: number): TreePanel;
export function applyPanel(panel: OpenPanel, action: TreeAction, width: number): OpenPanel;
export function applyPanel(panel: OpenPanel, action: TreeAction, width: number): OpenPanel {
  if (panel.kind === "sessions") {
    // Only the moves apply; the App routes this kind's other keys (`sessionsKey`).
    return action === "up" || action === "down"
      ? { ...panel, state: sessionsMove(panel.state, action, panel.data?.sessions.length ?? 0) }
      : panel;
  }
  const groups = groupsOf(panel, width);
  return groups ? withTree(panel, applyTree(groups, panel.tree, action)) : panel;
}

/** The panel after a click on body row `bodyIndex` of `view`. */
export function panelClick(
  panel: TreePanel,
  view: PanelView,
  bodyIndex: number,
  width: number,
): TreePanel;
export function panelClick(
  panel: OpenPanel,
  view: PanelView,
  bodyIndex: number,
  width: number,
): OpenPanel;
export function panelClick(
  panel: OpenPanel,
  view: PanelView,
  bodyIndex: number,
  width: number,
): OpenPanel {
  if (panel.kind === "sessions") {
    const row = view.rows[bodyIndex];
    const count = panel.data?.sessions.length ?? 0;
    const index = view.start + bodyIndex;
    return row?.kind === "head" && index < count
      ? { ...panel, state: { cursor: index, armed: null } }
      : panel;
  }
  const groups = groupsOf(panel, width);
  return groups ? withTree(panel, treeClick(groups, panel.tree, view, bodyIndex)) : panel;
}
