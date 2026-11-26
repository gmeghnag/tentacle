/**
 * The panel registry (docs/feat/app-decomposition.md S7, plan H4(4)): every panel
 * kind DESCRIBES ITSELF — how it projects to rows, how a tree action or a body
 * click moves it, and which keys it claims on which precedence layer.
 *
 * Why a registry rather than the `kind ===` branches `panel.ts` used to carry: the
 * measurable target of this decomposition is "a new panel is a file plus one
 * registry line, zero `App.tsx` lines". A central switch makes that false — a
 * fourth panel would have to edit every branch, and the "which layer" question
 * would live in code that does not own the panel. Here each kind is one
 * descriptor, the two branches are the descriptor's own `view`/`apply`/`click`
 * and `key`, and the ONLY dispatch left is the lookup below.
 *
 * The single dispatch point is also what makes the claim testable: `kindOf` takes
 * the registry as a parameter, so a test can hand it a FOURTH kind and prove the
 * facades answer through it with no edit to `panel.ts` or `keys/layer-panels.ts`.
 *
 * Pure: no React, no state. The stateful half is `usePanels.ts`.
 */
import type { CapOp, CapsPhase } from "../capability-toggles.ts";
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import type { OpenPanel } from "../panel.ts";
import type { PanelView, TreeAction } from "../tree-panel.ts";
import { appsKind } from "./apps.ts";
import { artifactsKind } from "./artifacts.ts";
import { browserKind } from "./browser.ts";
import { mcpKind } from "./mcp.ts";
import { scheduleKind } from "./schedule.ts";
import { sessionsKind } from "./sessions.ts";
import { skillsKind } from "./skills.ts";
import { toolsKind } from "./tools.ts";
import { workflowKind } from "./workflow.ts";

/** The precedence layer a panel kind is offered keys on (two of the 14, unchanged). */
export type PanelLayerName = "sessions" | "tree";

/** A kind's every kind. The registry must cover exactly this set (a test pins it). */
export type PanelKindName = OpenPanel["kind"];

/** What a projection needs besides the panel: the width it wraps to, its row budget, and the live session. */
export interface PanelAt {
  readonly width: number;
  /** `panelMaxBody(termRows)`: the panel's body row budget. */
  readonly maxBody: number;
  /** The live session id (`/sessions` marks its row); null when there is none. */
  readonly current: string | null;
  /**
   * The session's MCP/skill switches, read live like `current`
   * (docs/feat/session-capabilities.md S4); absent → no switch column.
   */
  readonly caps?: CapsPhase;
  /**
   * The session is open daemon-side (`SessionController.opened()`). A lazy
   * session (a fresh or resumed one opens at its first message) has no run feed
   * yet, and a panel that called that "not supported by this computer's tentacle"
   * said something false. Absent → taken as open (a host-less mount).
   */
  readonly opened?: boolean;
}

/**
 * One panel kind, as data. `P` is the kind's own panel variant, so a descriptor
 * body reads its fields without a cast and the registry can hold all of them
 * (method syntax keeps the parameters bivariant, which is what lets a narrow
 * descriptor live in a `PanelKind<OpenPanel>` map).
 */
export interface PanelKind<P extends { readonly kind: string }> {
  readonly kind: P["kind"];
  /** The precedence layer this kind claims keys on — the panel's own decision. */
  readonly layer: PanelLayerName;
  /** The rows at `at` (never null: a loading panel projects its own placeholder). */
  view(panel: P, at: PanelAt): PanelView;
  /** The panel after a key action, at `width` (the projection may wrap to it). */
  apply(panel: P, action: TreeAction, width: number): P;
  /** The panel after a click on body row `bodyIndex` of `view`. */
  click(panel: P, view: PanelView, bodyIndex: number, width: number): P;
  /** Which of this kind's keys this chunk is, and what it decides (`LayerStep`). */
  key(panel: P, snap: KeySnapshot): LayerStep;
  /**
   * What Space on the selected row asks the daemon (an on/off switch), or null
   * when the row has none. Absent: this kind carries no switches.
   */
  switchOp?(panel: P, width: number, caps: CapsPhase): CapOp | null;
  /**
   * What Space says when this kind shows no switch (null: nothing to say).
   * Absent: the shared MCP/skill wording (`noSwitchNotice`).
   */
  noSwitchNotice?(caps: CapsPhase): string | null;
}

/**
 * THE registry: ONE line per panel kind, in no significant order (lookup is by
 * `kind`). `/mcp` and `/skills` share the tree mechanic (`panels/tree.ts`),
 * `/artifacts` too (its versions fold under their artifact); `/sessions` and
 * `/schedule` are flat lists with their own.
 */
export const PANEL_KINDS: readonly PanelKind<OpenPanel>[] = [
  sessionsKind,
  mcpKind,
  skillsKind,
  toolsKind,
  artifactsKind,
  scheduleKind,
  appsKind,
  workflowKind,
  browserKind,
];

/**
 * The descriptor of `panel`'s kind. `kinds` is a parameter (not a closed-over
 * constant) so a test can prove a NEW kind needs one entry and no other edit;
 * production always uses the registry above.
 */
export function kindOf<P extends { readonly kind: string }>(
  panel: P,
  kinds: readonly PanelKind<P>[] = PANEL_KINDS as unknown as readonly PanelKind<P>[],
): PanelKind<P> {
  const desc = kinds.find((k) => k.kind === panel.kind);
  if (desc === undefined) {
    // Never silently: an undescribed kind would otherwise be projected as another
    // panel (the bug the `kind ===` fallthrough used to hide).
    throw new Error(`No panel descriptor for kind "${panel.kind}"`);
  }
  return desc;
}

/**
 * The panel layers' ONE decision (`keys/layer-panels.ts` is now a thin call): the
 * open panel's descriptor answers, and only on its own layer. A null panel, or a
 * panel of another kind, passes — precedence and order are the layer list's.
 */
export function panelStep(
  snap: KeySnapshot,
  layer: PanelLayerName,
  kinds: readonly PanelKind<OpenPanel>[] = PANEL_KINDS,
): LayerStep {
  const panel = snap.panel;
  if (panel === null) {
    return NOTHING;
  }
  const desc = kinds.find((k) => k.kind === panel.kind);
  if (desc === undefined || desc.layer !== layer) {
    return NOTHING;
  }
  return desc.key(panel, snap);
}
