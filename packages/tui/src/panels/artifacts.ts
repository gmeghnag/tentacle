/** `/artifacts` — the session's presented artifacts, newest first (docs/feat/model-artifacts.md D8). */
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  type ArtifactsData,
  artifactAt,
  artifactsTreeGroups,
  artifactsView,
} from "../artifacts-panel.ts";
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING, consumed } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { type PanelView, type TreeAction, applyTree, treeClick, treeKey } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import { withTree } from "./tree.ts";
import type { ArtifactsPanel } from "./types.ts";

/** The groups the cursor walks at the panel's own `now` (null while loading). */
const groups = (panel: ArtifactsPanel) =>
  panel.data === null ? null : artifactsTreeGroups(panel.data, panel.now);

/** Rows, or the honest placeholder while the request is in flight / empty. */
function view(panel: ArtifactsPanel, at: PanelAt): PanelView {
  return artifactsView(panel.data, panel.tree, panel.now, at.width, at.maxBody);
}

/** The panel after `action` over its rows (loading: unchanged). */
function apply(panel: ArtifactsPanel, action: TreeAction): ArtifactsPanel {
  const g = groups(panel);
  return g === null ? panel : withTree(panel, applyTree(g, panel.tree, action));
}

/**
 * The panel's keys. `enter` is the ONE this kind owns (`treeKey` reads it as
 * "toggle", which for a list of versions means "open the one under the cursor"):
 * it becomes the `openArtifact` effect carrying the decided meta — never an
 * index the App would have to resolve again, and never a "toggle" that would
 * expand a group the person asked to open.
 */
export const artifactsKind: PanelKind<ArtifactsPanel> = {
  kind: "artifacts",
  layer: "tree",
  view,
  apply: (panel: ArtifactsPanel, action: TreeAction, _width: number): ArtifactsPanel =>
    apply(panel, action),
  click: (
    panel: ArtifactsPanel,
    at: PanelView,
    bodyIndex: number,
    _width: number,
  ): ArtifactsPanel => {
    const g = groups(panel);
    return g === null ? panel : withTree(panel, treeClick(g, panel.tree, at, bodyIndex));
  },
  key: (panel: ArtifactsPanel, snap: KeySnapshot): LayerStep => {
    const action = treeKey(snap.char, snap.key);
    if (action === "close") {
      return consumed({ kind: "closePanel" });
    }
    if (action === "toggle") {
      const meta: ArtifactMeta | undefined = artifactAt(panel.data, panel.tree);
      // Nothing to open (an empty or still-loading list): the key is spent here
      // rather than falling through to the layers below, which behind a panel is
      // the mouse layer's "nothing edits" swallow anyway.
      return meta === undefined ? consumed() : consumed({ kind: "openArtifact", artifact: meta });
    }
    if (action === "none" || action === "switch") {
      // Not this panel's key (there is no switch on an artifact): the layers
      // below decide, as every tree panel's unclaimed key does.
      return NOTHING;
    }
    return consumed({ kind: "applyPanel", action });
  },
};
