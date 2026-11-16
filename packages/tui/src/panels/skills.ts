/** `/skills` — every skill found, as a tree panel (docs/feat/skills-panel.md). */
import {
  CAPS_HINT,
  type CapOp,
  type CapsPhase,
  skillSwitch,
  switchOp,
} from "../capability-toggles.ts";
import type { LayerStep } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import { skillGroups, skillsEmpty, skillsTitle } from "../skills-panel.ts";
import { type PanelView, type TreeAction, noteView, treeView } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import { applyTreeAction, clickTreeBody, cursorGroup, treeStep } from "./tree.ts";
import type { TreePanel } from "./types.ts";

/** The panel's kind, narrowed (the registry stores it as `TreePanel`). */
type SkillsPanel = Extract<TreePanel, { readonly kind: "skills" }>;

/**
 * Groups wrap to the panel's width, so they need `at.width` (unlike `/mcp`'s).
 * The switches change no row count, so the rows the cursor walks need none.
 */
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
    skillsTitle(panel.data, at.caps),
    skillGroups(panel.data, at.width, at.caps),
    panel.tree,
    at.width,
    at.maxBody,
    ...(at.caps?.kind === "on" ? [CAPS_HINT] : []),
  );
}

/**
 * Space on a row: the skill the cursor is on (its head or a child). Skill `i`
 * is group `i`; the problems group, last, has no switch.
 */
function switchOpOf(panel: SkillsPanel, width: number, caps: CapsPhase): CapOp | null {
  const group = cursorGroup(groups(panel, width), panel.tree);
  const skill = group === null ? undefined : panel.data?.skills[group];
  return skill === undefined ? null : switchOp("skill", skill.name, skillSwitch(caps, skill));
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
  switchOp: switchOpOf,
};
