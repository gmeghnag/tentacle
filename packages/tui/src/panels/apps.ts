/**
 * `/apps` (docs/feat/session-apps-publish.md D10): the session's published
 * pages as a flat list; `s` stops the one under the cursor. Every decision is
 * `apps-view.ts`'s. The stop is the daemon's (`session/app_unpublish`): the row
 * leaves when its `apps` frame says so, never on a local echo.
 */
import type { AppRow } from "@tentacle/protocol";
import { appsKey, appsMove, appsView, clampCursor } from "../apps-view.ts";
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING, consumed } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import type { PanelView, TreeAction } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import type { AppsPanel, OpenPanel } from "./types.ts";

export const appsKind: PanelKind<AppsPanel> = {
  kind: "apps",
  layer: "sessions",
  view: (panel: AppsPanel, at: PanelAt): PanelView =>
    appsView(panel.data, panel.cursor, at.width, at.maxBody),
  apply: (panel: AppsPanel, action: TreeAction): AppsPanel =>
    action === "up" || action === "down"
      ? { ...panel, cursor: appsMove(panel.cursor, action, panel.data?.length ?? 0) }
      : panel,
  click: (panel: AppsPanel, view: PanelView, bodyIndex: number): AppsPanel => {
    // An app is TWO rows: its summary (`head`) is the one the cursor may land on.
    if (view.rows[bodyIndex]?.kind !== "head") return panel;
    const index = view.start + Math.floor(bodyIndex / 2);
    return index < (panel.data?.length ?? 0) ? { ...panel, cursor: index } : panel;
  },
  key: (panel: AppsPanel, snap: KeySnapshot): LayerStep => {
    const action = appsKey(snap.char, snap.key);
    if (action === "none") return NOTHING;
    if (action === "close") return consumed({ kind: "closePanel" });
    if (action === "up" || action === "down") return consumed({ kind: "applyPanel", action });
    const row = panel.data?.[clampCursor(panel.cursor, panel.data.length)];
    return row === undefined
      ? consumed({ kind: "pushNotice", text: "No app on that row." })
      : consumed({ kind: "unpublishApp", app: row.app });
  },
};

/** An open `/apps` panel follows the daemon's report; the cursor stays in range. */
export const withAppsData = (
  panel: OpenPanel | null,
  rows: readonly AppRow[] | undefined,
): OpenPanel | null =>
  panel?.kind === "apps"
    ? { ...panel, data: rows, cursor: clampCursor(panel.cursor, rows?.length ?? 0) }
    : panel;
