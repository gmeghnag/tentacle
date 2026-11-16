/** `/mcp` — the MCP servers and their tools, as a tree panel (docs/feat/mcp-tools-panel.md). */
import {
  CAPS_HINT,
  type CapOp,
  type CapsPhase,
  mcpSwitch,
  switchOp,
} from "../capability-toggles.ts";
import type { LayerStep } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { mcpGroups, mcpTitle } from "../mcp-panel.ts";
import { type PanelView, type TreeAction, noteView, treeView } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import { applyTreeAction, clickTreeBody, cursorGroup, treeStep } from "./tree.ts";
import type { TreePanel } from "./types.ts";

/** The panel's kind, narrowed (the registry stores it as `TreePanel`). */
type McpPanel = Extract<TreePanel, { readonly kind: "mcp" }>;

/** The rows the cursor walks: the switches change no row count, so none are needed. */
const groups = (panel: McpPanel) => (panel.data ? mcpGroups(panel.data) : null);

/** Rows, or the honest placeholder while the request is in flight / empty. */
function view(panel: McpPanel, at: PanelAt): PanelView {
  if (!panel.data) {
    return noteView("MCP servers · probing…", "Asking the daemon…", at.width);
  }
  if (panel.data.length === 0) {
    return noteView("MCP servers", "No MCP servers on this daemon.", at.width);
  }
  return treeView(
    mcpTitle(panel.data, at.caps),
    mcpGroups(panel.data, at.caps),
    panel.tree,
    at.width,
    at.maxBody,
    ...(at.caps?.kind === "on" ? [CAPS_HINT] : []),
  );
}

/** Space on a row: the server the cursor is on (a head or one of its tools). */
function switchOpOf(panel: McpPanel, _width: number, caps: CapsPhase): CapOp | null {
  const group = cursorGroup(groups(panel), panel.tree);
  const server = group === null ? undefined : panel.data?.[group];
  return server === undefined ? null : switchOp("mcp", server.name, mcpSwitch(caps, server.name));
}

export const mcpKind: PanelKind<McpPanel> = {
  kind: "mcp",
  layer: "tree",
  view,
  apply: (panel: McpPanel, action: TreeAction, _width: number): McpPanel =>
    applyTreeAction(panel, groups(panel), action),
  click: (panel: McpPanel, at: PanelView, bodyIndex: number, _width: number): McpPanel =>
    clickTreeBody(panel, groups(panel), at, bodyIndex),
  key: (_panel: McpPanel, snap: KeySnapshot): LayerStep => treeStep(snap),
  switchOp: switchOpOf,
};
