/** `/tools` — the session's built-in tools and their switches, as a tree panel (docs/feat/tool-toggles.md D7). */
import { CAPS_HINT, type CapOp, type CapsPhase, toolsPhase } from "../capability-toggles.ts";
import type { LayerStep } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { toolsGroups, toolsNoSwitchNotice, toolsSwitchOp, toolsTitle } from "../tools-panel.ts";
import { type PanelView, type TreeAction, noteView, treeRows, treeView } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import { applyTreeAction, clickTreeBody, treeStep } from "./tree.ts";
import type { TreePanel } from "./types.ts";

/** The panel's kind, narrowed (the registry stores it as `TreePanel`). */
type ToolsPanel = Extract<TreePanel, { readonly kind: "tools" }>;

const NO_CAPS: CapsPhase = { kind: "unsupported" };

/** The rows the cursor walks: the switches change no row count. */
const groups = (panel: ToolsPanel) => (panel.data ? toolsGroups(panel.data, NO_CAPS) : null);

/** Rows, or the honest placeholder while the request is in flight / empty. */
function view(panel: ToolsPanel, at: PanelAt): PanelView {
  if (!panel.data) {
    return noteView("Tools · loading…", "Asking the daemon…", at.width);
  }
  if (panel.data.length === 0) {
    return noteView("Tools", "No built-in tools in this session.", at.width);
  }
  const caps = at.caps ?? NO_CAPS;
  return treeView(
    toolsTitle(panel.data, caps),
    toolsGroups(panel.data, caps),
    panel.tree,
    at.width,
    at.maxBody,
    ...(toolsPhase(caps).kind === "on" ? [CAPS_HINT] : []),
  );
}

/** Space on a row: a group head → the group; a member or a single tool → that tool. */
function switchOpOf(panel: ToolsPanel, _width: number, caps: CapsPhase): CapOp | null {
  const g = groups(panel);
  if (g === null || panel.data === null) {
    return null;
  }
  const rows = treeRows(g, panel.tree);
  const row = rows[Math.min(Math.max(0, panel.tree.cursor), rows.length - 1)];
  return row === undefined ? null : toolsSwitchOp(panel.data, caps, row.group, row.child);
}

export const toolsKind: PanelKind<ToolsPanel> = {
  kind: "tools",
  layer: "tree",
  view,
  apply: (panel: ToolsPanel, action: TreeAction, _width: number): ToolsPanel =>
    applyTreeAction(panel, groups(panel), action),
  click: (panel: ToolsPanel, at: PanelView, bodyIndex: number, _width: number): ToolsPanel =>
    clickTreeBody(panel, groups(panel), at, bodyIndex),
  key: (_panel: ToolsPanel, snap: KeySnapshot): LayerStep => treeStep(snap),
  switchOp: switchOpOf,
  noSwitchNotice: toolsNoSwitchNotice,
};
