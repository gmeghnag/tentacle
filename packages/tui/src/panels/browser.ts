/** `/browser` — the user's Chrome in this session: link, switches, tabs (docs/feat/browser-inspect.md B6a). */
import { browserPanelRows } from "../browser-view.ts";
import { CAPS_HINT, type CapOp, type CapsPhase } from "../capability-toggles.ts";
import type { LayerStep } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import {
  type PanelView,
  type TreeAction,
  type TreeGroup,
  applyTree,
  noteView,
  treeClick,
  treeRows,
  treeView,
} from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import { treeStep, withTree } from "./tree.ts";
import type { BrowserPanel, OpenPanel } from "./types.ts";

/** Childless rows: one per switch, then the tabs. Their count needs no switches. */
const groups = (panel: BrowserPanel): TreeGroup[] =>
  browserPanelRows(undefined, panel.data).rows.map((row) => ({ head: row.head, children: [] }));

function view(panel: BrowserPanel, at: PanelAt): PanelView {
  const caps = at.caps?.kind === "on" ? at.caps.caps : undefined;
  if (caps?.browser === undefined) {
    return noteView("Browser", "No browser in this session.", at.width);
  }
  const { title, rows } = browserPanelRows(caps, panel.data);
  return treeView(
    title,
    rows.map((row) => ({
      head: row.head,
      children: [],
      ...(row.off === true ? { off: true } : {}),
    })),
    panel.tree,
    at.width,
    at.maxBody,
    CAPS_HINT,
  );
}

/** Space: the cursor row's switch as the daemon last reported it. */
function switchOpOf(panel: BrowserPanel, _width: number, caps: CapsPhase): CapOp | null {
  if (caps.kind !== "on" || caps.caps.browser === undefined) {
    return null;
  }
  const { rows } = browserPanelRows(caps.caps, panel.data);
  const row = treeRows(groups(panel), panel.tree)[
    Math.min(Math.max(0, panel.tree.cursor), rows.length - 1)
  ];
  return row === undefined ? null : (rows[row.group]?.op ?? null);
}

/** An open `/browser` panel follows the latest read; any other panel is untouched. */
export const withBrowserData = (
  panel: OpenPanel | null,
  data: BrowserPanel["data"],
): OpenPanel | null =>
  panel?.kind === "browser" && panel.data !== data ? { ...panel, data } : panel;

export const browserKind: PanelKind<BrowserPanel> = {
  kind: "browser",
  layer: "tree",
  view,
  apply: (panel: BrowserPanel, action: TreeAction, _width: number): BrowserPanel =>
    withTree(panel, applyTree(groups(panel), panel.tree, action)),
  click: (panel: BrowserPanel, at: PanelView, bodyIndex: number, _width: number): BrowserPanel =>
    withTree(panel, treeClick(groups(panel), panel.tree, at, bodyIndex)),
  key: (_panel: BrowserPanel, snap: KeySnapshot): LayerStep => treeStep(snap),
  switchOp: switchOpOf,
  // A locked or a tab row has nothing to flip, and says so on the row itself.
  noSwitchNotice: () => null,
};
