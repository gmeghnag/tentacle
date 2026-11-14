/** `/skills` — every skill found, as a tree panel (docs/feat/skills-panel.md). */
import type { LayerStep } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { skillGroups, skillsEmpty, skillsTitle } from "../skills-panel.ts";
import { type PanelView, type TreeAction, noteView, treeView } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import { applyTreeAction, clickTreeBody, treeStep } from "./tree.ts";
import type { TreePanel } from "./types.ts";

/** The panel's kind, narrowed (the registry stores it as `TreePanel`). */
type SkillsPanel = Extract<TreePanel, { readonly kind: "skills" }>;

/** Groups wrap to the panel's width, so they need `at.width` (unlike `/mcp`'s). */
const groups = (panel: SkillsPanel, width: number) =>
  panel.data ? skillGroups(panel.data, width) : null;

/** Rows, or the honest placeholder while the request is in flight / empty. */
function view(panel: SkillsPanel, at: PanelAt): PanelView {
  if (!panel.data) {
    return noteView("Skills · loading…", "Asking the daemon…", at.width);
  }
  if (skillsEmpty(panel.data)) {
    return noteView("Skills", "No skills on this daemon.", at.width);
  }
  return treeView(
    skillsTitle(panel.data),
    groups(panel, at.width) ?? [],
    panel.tree,
    at.width,
    at.maxBody,
  );
}

export const skillsKind: PanelKind<SkillsPanel> = {
  kind: "skills",
  layer: "tree",
  view,
  apply: (panel: SkillsPanel, action: TreeAction, width: number): SkillsPanel =>
    applyTreeAction(panel, groups(panel, width), action),
  click: (panel: SkillsPanel, at: PanelView, bodyIndex: number, width: number): SkillsPanel =>
    clickTreeBody(panel, groups(panel, width), at, bodyIndex),
  key: (_panel: SkillsPanel, snap: KeySnapshot): LayerStep => treeStep(snap),
};
