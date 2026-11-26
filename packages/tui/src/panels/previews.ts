/**
 * `/previews` (docs/feat/session-apps-container-ports.md S4): the session's
 * container previews as a flat list; `c` copies a shared one's link, `s` stops
 * one. Every decision is `previews-view.ts`'s. Both are the daemon's
 * (`session/preview_link`, `session/preview_stop`): a row leaves when its
 * `previews` frame says so, never on a local echo.
 */
import type { PreviewRow } from "@tentacle/protocol";
import { appsMove, clampCursor } from "../apps-view.ts";
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING, consumed } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { previewsKey, previewsView } from "../previews-view.ts";
import type { PanelView, TreeAction } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import type { OpenPanel, PreviewsPanel } from "./types.ts";

export const previewsKind: PanelKind<PreviewsPanel> = {
  kind: "previews",
  layer: "sessions",
  view: (panel: PreviewsPanel, at: PanelAt): PanelView =>
    previewsView(panel.data, panel.cursor, at.width, at.maxBody),
  apply: (panel: PreviewsPanel, action: TreeAction): PreviewsPanel =>
    action === "up" || action === "down"
      ? { ...panel, cursor: appsMove(panel.cursor, action, panel.data?.length ?? 0) }
      : panel,
  click: (panel: PreviewsPanel, view: PanelView, bodyIndex: number): PreviewsPanel => {
    // A preview is TWO rows: its summary (`head`) is the one the cursor may land on.
    if (view.rows[bodyIndex]?.kind !== "head") return panel;
    const index = view.start + Math.floor(bodyIndex / 2);
    return index < (panel.data?.length ?? 0) ? { ...panel, cursor: index } : panel;
  },
  key: (panel: PreviewsPanel, snap: KeySnapshot): LayerStep => {
    const action = previewsKey(snap.char, snap.key);
    if (action === "none") return NOTHING;
    if (action === "close") return consumed({ kind: "closePanel" });
    if (action === "up" || action === "down") return consumed({ kind: "applyPanel", action });
    const row = panel.data?.[clampCursor(panel.cursor, panel.data.length)];
    if (row === undefined) {
      return consumed({ kind: "pushNotice", text: "Nothing on that row." });
    }
    if (action === "stop") return consumed({ kind: "stopPreview", row });
    return row.link === undefined
      ? consumed({ kind: "pushNotice", text: "That one has no web link: paired devices only." })
      : consumed({ kind: "copyPreviewLink", row });
  },
};

/** An open `/previews` panel follows the daemon's report; the cursor stays in range. */
export const withPreviewsData = (
  panel: OpenPanel | null,
  rows: readonly PreviewRow[] | undefined,
): OpenPanel | null =>
  panel?.kind === "previews"
    ? { ...panel, data: rows, cursor: clampCursor(panel.cursor, rows?.length ?? 0) }
    : panel;
