import type { WorkflowRow } from "@tentacle/protocol";
/**
 * `/workflow` (docs/feat/workflows-ui.md D3, mockup TUI 2): the run in flight as
 * two columns — the steps on the left (the cursor walks them), the selected
 * step's detail on the right, and `o` to read its prompt/report from the log.
 *
 * Every decision is `workflow-view.ts`'s; this descriptor only turns one into the
 * router's `LayerStep`, exactly as `panels/schedule.ts` does for its kind. Two of
 * its keys are the kind's OWN and are not in `TreeAction` (`o` reads a step's log
 * entry, `r` re-runs it), so they are their own effects — the effect CARRIES the
 * decided `runId`/`stepId`/generation, and the App executes it.
 *
 * **No `[a]/[d]` here (D3, deliberate):** an approve ask already takes the input
 * as the permission dialog, with the verbatim detail; a second answer path would
 * be a second UI for one ask. The right column says `? needs approval — answer in
 * the prompt` for that reason.
 */
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING, consumed } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import type { PanelView, TreeAction } from "../tree-panel.ts";
import {
  type CatalogueView,
  type WorkflowDetailState,
  type WorkflowState,
  catalogueSection,
  selectedStep,
  shownRun,
  workflowKey,
  workflowMove,
  workflowPanelView,
} from "../workflow-view.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import type { OpenPanel, WorkflowPanel } from "./types.ts";

/**
 * The run this panel shows: the pinned one, else the one in flight, else the
 * newest (`shownRun` — the SAME rule the view paints, so a key never acts on a
 * run other than the one on screen).
 */
export function workflowPanelRun(panel: WorkflowPanel): WorkflowRow | undefined {
  return shownRun(panel.data, panel.runId);
}

/** The step the panel's cursor is on (undefined: no run, or a run with no steps). */
export function workflowAt(panel: WorkflowPanel) {
  return selectedStep(workflowPanelRun(panel), panel.state);
}

function view(panel: WorkflowPanel, at: PanelAt): PanelView {
  return workflowPanelView(
    panel.data,
    panel.runId,
    panel.state,
    panel.detail,
    at.width,
    at.maxBody,
    panel.catalogue,
  );
}

/**
 * The keys. `up`/`down` go through `applyPanel` (the whole panel state moves), so
 * this descriptor's OWN answers are the three the registry has no word for: `r`
 * (re-run the step), `o` (read its log entry) and the note for a step waiting on
 * a person. Both carry the DECIDED identity + the generation the key landed in,
 * because the answer is async and the panel may have closed, or moved, since.
 */
export const workflowKind: PanelKind<WorkflowPanel> = {
  kind: "workflow",
  // The flat-list layer, shared with `/sessions` and `/schedule`: a list whose
  // Esc must close the panel rather than reach "Esc stops a running turn".
  layer: "sessions",
  view,
  // Only the moves apply here; every other workflow key is this kind's `key`.
  apply: (panel: WorkflowPanel, action: TreeAction, _width: number): WorkflowPanel =>
    action === "up" || action === "down"
      ? {
          ...panel,
          state: workflowMove(panel.state, action, workflowPanelRun(panel)?.steps.length ?? 0),
        }
      : panel,
  click: (
    panel: WorkflowPanel,
    view: PanelView,
    bodyIndex: number,
    width: number,
  ): WorkflowPanel => {
    const row = view.rows[bodyIndex];
    if (row?.kind !== "head") {
      // The "Workflows" section's rows are notes: the section has no cursor of its
      // own (`/workflow run <name>` is how one starts), so a click there is a no-op.
      return panel;
    }
    // The step rows follow the section in the same list; `start` indexes the steps.
    const section = catalogueSection(panel.catalogue, width);
    const index = view.start + bodyIndex - section.length;
    const count = workflowPanelRun(panel)?.steps.length ?? 0;
    return index < 0 || index >= count ? panel : { ...panel, state: { cursor: index } };
  },
  key: (panel: WorkflowPanel, snap: KeySnapshot): LayerStep => {
    const action = workflowKey(snap.char, snap.key);
    if (action === "none") {
      // Any other key falls through (the wheel scrolls, `q` was already closed by
      // `workflowKey`): this kind holds no arm/confirm state to disarm.
      return NOTHING;
    }
    if (action === "close") {
      return consumed({ kind: "closePanel" });
    }
    if (action === "up" || action === "down") {
      return consumed({ kind: "applyPanel", action });
    }
    const run = workflowPanelRun(panel);
    const step = workflowAt(panel);
    if (run === undefined || step === undefined) {
      // Nothing selected to act on: say so rather than send a request with no id.
      return consumed({ kind: "pushNotice", text: "_No workflow step to act on._" });
    }
    if (action === "detail") {
      return consumed({
        kind: "workflowDetail",
        runId: run.runId,
        stepId: step.id,
        startedGen: snap.panelGen(),
      });
    }
    return consumed({
      kind: "workflowRerun",
      runId: run.runId,
      stepId: step.id,
      startedGen: snap.panelGen(),
    });
  },
};

/**
 * The `/workflow` kind's own state rules (as `panels/schedule.ts` carries its
 * three): each takes the panel as `null | OpenPanel`, because that is what a
 * functional `setPanel` update hands over, and returns it unchanged when it is
 * another kind. No App-side `kind === "workflow"` branch.
 */
export const isWorkflowOpen = (panel: OpenPanel | null): boolean => panel?.kind === "workflow";

/** The panel with its cursor replaced (a move's own answer). */
export const withWorkflowState = (
  panel: OpenPanel | null,
  state: WorkflowState,
): OpenPanel | null => (panel?.kind === "workflow" ? { ...panel, state } : panel);

/**
 * The panel with a fetched step detail, ONLY if it belongs to the step the panel
 * is showing now: a read that lands after the cursor moved (or after another
 * run was pinned) is DROPPED, never painted on the wrong step.
 */
export const withWorkflowDetail = (
  panel: OpenPanel | null,
  detail: WorkflowDetailState,
): OpenPanel | null => {
  if (panel?.kind !== "workflow") {
    return panel;
  }
  const step = workflowAt(panel);
  const run = workflowPanelRun(panel);
  if (run === undefined || step === undefined) {
    return panel;
  }
  if (run.runId !== detail.runId || step.id !== detail.stepId) {
    return panel;
  }
  return { ...panel, detail };
};

/**
 * The open `/workflow` panel after a REPORT (`withSchedulesData`' counterpart):
 * the daemon's new runs, the clock re-stamped, and the cursor brought back in
 * range by `workflowMove`'s own clamp — with the fetched detail KEPT only while
 * its step still exists (a re-run replaces the attempt the report describes).
 * The project's catalogue rides the same update (slice 2b / D8): its own answer
 * lands independently of the run feed, and the section above the runs repaints.
 */
export const withWorkflowsData = (
  panel: OpenPanel | null,
  rows: readonly WorkflowRow[] | undefined,
  now: number,
  catalogue?: CatalogueView,
): OpenPanel | null => {
  if (panel?.kind !== "workflow") {
    return panel;
  }
  const next: WorkflowPanel = {
    ...panel,
    data: rows,
    now,
    ...(catalogue === undefined ? {} : { catalogue }),
  };
  const run = workflowPanelRun(next);
  const count = run?.steps.length ?? 0;
  const cursor = count === 0 ? 0 : Math.min(Math.max(0, panel.state.cursor), count - 1);
  const step = selectedStep(run, { cursor });
  const keep =
    panel.detail !== null &&
    step !== undefined &&
    panel.detail.stepId === step.id &&
    panel.detail.runId === (run?.runId ?? "");
  return {
    ...next,
    state: { cursor },
    detail: keep ? panel.detail : null,
  };
};
