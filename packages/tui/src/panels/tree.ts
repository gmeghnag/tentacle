/**
 * The TREE panels' shared mechanic (`/mcp`, `/skills`): both are a group list with
 * an expandable cursor, so their key decision is ONE function and each kind file
 * supplies only what differs (its groups, its title, its notes).
 *
 * The decision is `tree-panel.ts`'s (`treeKey`); this module turns its action into
 * the router's `LayerStep` — the same verdicts the pre-S7 `treeLayer` produced:
 * Esc closes and is CONSUMED, a claimed action is consumed, anything else passes
 * (the mouse layer then swallows it behind a panel).
 */
import type { LayerStep } from "../keys/contract.ts";
import { consumed } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { type TreeGroup, type TreeState, applyTree, treeClick, treeKey } from "../tree-panel.ts";
import type { PanelView } from "../tree-panel.ts";
import type { TreePanel } from "./types.ts";

/**
 * `panel` with `tree` — the SAME object when nothing moved, so a no-op action
 * cannot re-render the App.
 */
export function withTree<P extends TreePanel>(panel: P, tree: TreeState): P {
  return tree === panel.tree ? panel : { ...panel, tree };
}

/** The panel after `action` over `groups` (null while loading: unchanged). */
export function applyTreeAction<P extends TreePanel>(
  panel: P,
  groups: readonly TreeGroup[] | null,
  action: Parameters<typeof applyTree>[2],
): P {
  return groups === null ? panel : withTree(panel, applyTree(groups, panel.tree, action));
}

/** The panel after a click on body row `bodyIndex` of `view` (null groups: unchanged). */
export function clickTreeBody<P extends TreePanel>(
  panel: P,
  groups: readonly TreeGroup[] | null,
  view: PanelView,
  bodyIndex: number,
): P {
  return groups === null ? panel : withTree(panel, treeClick(groups, panel.tree, view, bodyIndex));
}

/** The tree panels' key decision: Esc closes, a claimed action applies, else pass. */
export function treeStep(snap: KeySnapshot): LayerStep {
  const action = treeKey(snap.char, snap.key);
  if (action === "close") {
    return consumed({ kind: "closePanel" });
  }
  if (action === "none") {
    // Not this panel's key: the layers below decide (the mouse layer swallows it).
    return { effects: [], verdict: "pass", carry: "" };
  }
  return consumed({ kind: "applyPanel", action });
}
