import { artifactCard } from "@tentacle/core";
/** `/artifacts` — the session's presented artifacts, newest first (docs/feat/model-artifacts.md D8). */
import type { ArtifactMeta } from "@tentacle/protocol";
import {
  type ArtifactsData,
  artifactAt,
  artifactsTreeGroups,
  artifactsView,
  chartPreviewErrorView,
  chartPreviewView,
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

/** A CHART artifact — the one kind a preview may open (docs/feat/model-charts.md C8). */
const isChart = (meta: ArtifactMeta | undefined): meta is ArtifactMeta =>
  meta !== undefined && artifactCard(meta).kind === "chart";

/**
 * Rows: the chart preview when one is open (docs/feat/model-charts.md C8), else
 * the artifact tree, else the honest placeholder. A preview that was ASKED for
 * and whose read FAILED says so — it never falls back to the tree, which would
 * make the key look as if nothing happened.
 */
function view(panel: ArtifactsPanel, at: PanelAt): PanelView {
  const preview = panel.preview;
  if (preview !== null && preview !== undefined) {
    if (preview.error !== undefined) {
      return chartPreviewErrorView(preview.error, at.width);
    }
    return chartPreviewView({ bytes: preview.bytes ?? "" }, at.width, at.maxBody);
  }
  return artifactsView(panel.data, panel.tree, panel.now, at.width, at.maxBody);
}

/** The panel after `action` over its rows (loading: unchanged). */
function apply(panel: ArtifactsPanel, action: TreeAction): ArtifactsPanel {
  const g = groups(panel);
  return g === null ? panel : withTree(panel, applyTree(g, panel.tree, action));
}

/**
 * The panel's keys. Two decisions are this kind's own:
 *
 * 1. **A chart artifact is PREVIEWED, not opened** (docs/feat/model-charts.md
 *    C8): its bytes are a spec, so the panel draws it expanded in place — no
 *    temp file, no OS browser — and `esc`/`q` returns to the tree. Every other
 *    kind keeps S6b's `openArtifact` (the OS viewer, save, network).
 * 2. **`enter` on the tree opens the version under the cursor** (D8), which for a
 *    folded child is THAT version, not the artifact's newest (`artifactAt`).
 *
 * While a preview is open, EVERY key that only makes sense on the tree is spent
 * with no effect: a cursor key must not walk rows nobody can see.
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
    const previewOpen = panel.preview !== null && panel.preview !== undefined;
    const action = treeKey(snap.char, snap.key);
    if (previewOpen) {
      // The one way out is the way out of the panel's TREE state, not the panel:
      // the person asked to look at a chart, and `esc` puts them back where they
      // were rather than closing `/artifacts` on them.
      if (action === "close") {
        return consumed({ kind: "previewArtifact", artifact: null });
      }
      // Everything else (a cursor key, `enter`, `s`) belongs to the tree behind
      // the preview: spent, no effect — never a walk of invisible rows.
      return consumed();
    }
    // `s` save a copy / `n` open with the network (S6b): the same meta under the
    // cursor, with the intent the RUNTIME's plan then decides on (`artifactStep`:
    // a pod's page never gets the network).
    const modified = snap.key.ctrl === true || snap.key.meta === true;
    const intent = modified
      ? null
      : snap.char === "s"
        ? "save"
        : snap.char === "n"
          ? "network"
          : null;
    if (intent !== null) {
      const meta: ArtifactMeta | undefined = artifactAt(panel.data, panel.tree);
      return meta === undefined
        ? consumed()
        : consumed({ kind: "openArtifact", artifact: meta, intent });
    }
    if (action === "close") {
      return consumed({ kind: "closePanel" });
    }
    if (action === "toggle") {
      const meta: ArtifactMeta | undefined = artifactAt(panel.data, panel.tree);
      // Nothing to open (an empty or still-loading list): the key is spent here
      // rather than falling through to the layers below, which behind a panel is
      // the mouse layer's "nothing edits" swallow anyway.
      if (meta === undefined) {
        return consumed();
      }
      return consumed(
        isChart(meta)
          ? { kind: "previewArtifact", artifact: meta }
          : { kind: "openArtifact", artifact: meta },
      );
    }
    if (action === "none" || action === "switch") {
      // Not this panel's key (there is no switch on an artifact): the layers
      // below decide, as every tree panel's unclaimed key does.
      return NOTHING;
    }
    return consumed({ kind: "applyPanel", action });
  },
};
