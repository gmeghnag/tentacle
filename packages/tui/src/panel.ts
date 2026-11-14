/**
 * The open list panel (`/mcp`, `/skills`, `/sessions`), as ONE state with ONE
 * key/mouse route (docs/feat/skills-panel.md): this module is the FACADE the rest
 * of the TUI imports, and it dispatches to the open panel's own descriptor
 * (`panels/registry.ts` → `panels/<kind>.ts`).
 *
 * **S7 (docs/feat/app-decomposition.md, plan H4(4)).** This file used to hold the
 * `kind ===` branches itself; that made "a new panel is a file plus a registry
 * line" false. The branches are now the descriptors' own `view`/`apply`/`click`
 * and `key`, and the only dispatch left is one kind lookup — so a fourth panel
 * adds `panels/<kind>.ts` and ONE line in `PANEL_KINDS`. Every name this module
 * exported before S7 still resolves here (the model is re-exported from
 * `panels/types.ts`), so no importer and no test changed.
 *
 * Pure; a tree panel's `data` is null while the request is in flight.
 */
import { type PanelAt, kindOf } from "./panels/registry.ts";
import type { OpenPanel, TreePanel } from "./panels/types.ts";
import type { PanelView, TreeAction } from "./tree-panel.ts";

// The model and its constructors moved to `panels/types.ts` (the kinds need them,
// and importing them from here would be a value cycle). Re-exported so every
// pre-S7 import of `panel.ts` keeps working.
export {
  type OpenPanel,
  type SessionsPanel,
  type TreePanel,
  mcpPanel,
  sessionsPanel,
  skillsPanel,
} from "./panels/types.ts";

/**
 * `current`: the live session's id (the `/sessions` panel marks its row); null
 * when there is none. The panel projects through its own kind's `view`.
 */
export function panelView(
  panel: OpenPanel,
  width: number,
  maxBody: number,
  current?: string | null,
): PanelView {
  const at: PanelAt = { width, maxBody, current: current ?? null };
  return kindOf(panel).view(panel, at);
}

/**
 * The panel after a key action, at `width` (the projection may wrap to it).
 *
 * The overloads are pre-S7 signatures kept verbatim: a caller holding a
 * `TreePanel` (the MCP and skills suites do) gets a `TreePanel` back, so the
 * registry's erased-union signature never widens a caller's type.
 */
export function applyPanel(panel: TreePanel, action: TreeAction, width: number): TreePanel;
export function applyPanel(panel: OpenPanel, action: TreeAction, width: number): OpenPanel;
export function applyPanel(panel: OpenPanel, action: TreeAction, width: number): OpenPanel {
  return kindOf(panel).apply(panel, action, width);
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
  return kindOf(panel).click(panel, view, bodyIndex, width);
}
