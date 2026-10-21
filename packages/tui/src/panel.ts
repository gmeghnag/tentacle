/**
 * The panel the App has open (`/mcp` or `/skills`), as ONE state with ONE
 * key/mouse route (docs/feat/skills-panel.md): this module dispatches on the
 * kind to the projection (`mcp-panel.ts`, `skills-panel.ts`) and hands the
 * mechanics to `tree-panel.ts`. Pure; `data` is null while the request is in
 * flight.
 */
import { type McpServerView, mcpGroups, mcpTitle } from "./mcp-panel.ts";
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

export type OpenPanel =
  | {
      readonly kind: "mcp";
      readonly data: readonly McpServerView[] | null;
      readonly tree: TreeState;
    }
  | { readonly kind: "skills"; readonly data: SkillsListView | null; readonly tree: TreeState };

export const mcpPanel = (data: readonly McpServerView[] | null = null): OpenPanel => ({
  kind: "mcp",
  data,
  tree: TREE_START,
});

export const skillsPanel = (data: SkillsListView | null = null): OpenPanel => ({
  kind: "skills",
  data,
  tree: TREE_START,
});

/** `panel` with `tree` — the same object when nothing moved (no re-render). */
const withTree = (panel: OpenPanel, tree: TreeState): OpenPanel =>
  tree === panel.tree ? panel : { ...panel, tree };

/** The groups at `width`, or null while loading. */
function groupsOf(panel: OpenPanel, width: number): TreeGroup[] | null {
  if (panel.kind === "mcp") {
    return panel.data ? mcpGroups(panel.data) : null;
  }
  return panel.data ? skillGroups(panel.data, width) : null;
}

export function panelView(panel: OpenPanel, width: number, maxBody: number): PanelView {
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
export function applyPanel(panel: OpenPanel, action: TreeAction, width: number): OpenPanel {
  const groups = groupsOf(panel, width);
  return groups ? withTree(panel, applyTree(groups, panel.tree, action)) : panel;
}

/** The panel after a click on body row `bodyIndex` of `view`. */
export function panelClick(
  panel: OpenPanel,
  view: PanelView,
  bodyIndex: number,
  width: number,
): OpenPanel {
  const groups = groupsOf(panel, width);
  return groups ? withTree(panel, treeClick(groups, panel.tree, view, bodyIndex)) : panel;
}
