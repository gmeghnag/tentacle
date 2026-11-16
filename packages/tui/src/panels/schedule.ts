/**
 * `/schedule` (docs/feat/cron-tool.md S5, mockup M3): the session's armed wakes
 * as a flat list with its own cursor and its own delete confirm — the
 * `/sessions` grammar minus `enter` (a wake has no second surface to open; its
 * prompt is already quoted under it).
 *
 * Every decision is `schedule-view.ts`'s; this descriptor only turns one into
 * the router's `LayerStep`, exactly as `panels/sessions.ts` does for its kind.
 * The DELETE is the daemon's (`session/schedule_delete`): the row leaves when
 * its `schedules` frame says so, never on a local echo.
 */
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING, consumed, passThrough } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import {
  type ScheduleDeleteStep,
  type ScheduleDockRow,
  refreshedSchedules,
  scheduleDeleteStep,
  scheduleKey,
  schedulesMove,
  schedulesView,
} from "../schedule-view.ts";
import type { PanelView, TreeAction } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import type { OpenPanel, SchedulesPanel } from "./types.ts";

/** The wake under the cursor, or undefined (the panel paints a placeholder then). */
export function scheduleAt(
  data: readonly ScheduleDockRow[] | undefined,
  cursor: number,
): ScheduleDockRow | undefined {
  if (data === undefined || data.length === 0) {
    return undefined;
  }
  return data[Math.min(Math.max(0, cursor), data.length - 1)];
}

function view(panel: SchedulesPanel, at: PanelAt): PanelView {
  return schedulesView(panel.data, panel.state, panel.now, at.width, at.maxBody);
}

/** What a delete step asks the router to do: write the state, and maybe send the RPC. */
function deleteEffects(step: ScheduleDeleteStep): LayerStep {
  if (step.kind === "refused") {
    return consumed(
      { kind: "setSchedulesState", state: step.state },
      { kind: "pushNotice", text: step.text },
    );
  }
  if (step.kind === "arm") {
    return consumed({ kind: "setSchedulesState", state: step.state });
  }
  return consumed(
    { kind: "setSchedulesState", state: step.state },
    { kind: "deleteSchedule", id: step.id },
  );
}

export const scheduleKind: PanelKind<SchedulesPanel> = {
  kind: "schedule",
  // The flat-list layer, shared with `/sessions`: both are cursor lists whose
  // Esc must close the panel rather than reach "Esc stops a running turn".
  layer: "sessions",
  view,
  // Only the moves apply here; every other schedule key is this kind's `key`.
  apply: (panel: SchedulesPanel, action: TreeAction, _width: number): SchedulesPanel =>
    action === "up" || action === "down"
      ? {
          ...panel,
          state: schedulesMove(panel.state, action, panel.data?.length ?? 0),
        }
      : panel,
  click: (panel: SchedulesPanel, view: PanelView, bodyIndex: number): SchedulesPanel => {
    const row = view.rows[bodyIndex];
    const count = panel.data?.length ?? 0;
    // A wake is TWO rows: its summary (`head`) is the one the cursor may land on.
    if (row?.kind !== "head") {
      return panel;
    }
    const index = Math.floor((view.start + bodyIndex) / 2);
    return index >= count ? panel : { ...panel, state: { cursor: index, armed: null } };
  },
  key: (panel: SchedulesPanel, snap: KeySnapshot): LayerStep => {
    const action = scheduleKey(snap.char, snap.key);
    if (action === "none") {
      // Any other key disarms a pending delete, then falls through (the wheel
      // cancels the confirm and still scrolls, as in `/sessions`).
      return panel.state.armed === null
        ? NOTHING
        : passThrough({ kind: "setSchedulesState", state: { ...panel.state, armed: null } });
    }
    if (action === "close") {
      return consumed({ kind: "closePanel" });
    }
    if (action === "up" || action === "down") {
      return consumed({ kind: "applyPanel", action });
    }
    return deleteEffects(
      scheduleDeleteStep(panel.state, scheduleAt(panel.data, panel.state.cursor), panel.now),
    );
  },
};

/**
 * The `/schedule` kind's own state rules (as `panels/sessions.ts` carries its
 * three): each takes the panel as `null | OpenPanel`, because that is what a
 * functional `setPanel` update hands over, and returns it unchanged when it is
 * another kind. No App-side `kind === "schedule"` branch.
 */
export const isScheduleOpen = (panel: OpenPanel | null): boolean => panel?.kind === "schedule";

/** The panel with its arm/cursor state replaced (the delete's arm and answer). */
export const withSchedulesState = (
  panel: OpenPanel | null,
  state: SchedulesPanel["state"],
): OpenPanel | null => (panel?.kind === "schedule" ? { ...panel, state } : panel);

/**
 * The open `/schedule` panel after a REPORT (`refreshedSessions`' counterpart,
 * fix round 1 finding 2): the daemon's new table, the clock re-stamped (the rows'
 * distances are computed from it), and the cursor/arm brought back in range by
 * `refreshedSchedules`. Without this the panel is a SNAPSHOT: it would keep a
 * deleted wake and offer a delete for an id the table no longer has.
 */
export const withSchedulesData = (
  panel: OpenPanel | null,
  rows: readonly ScheduleDockRow[] | undefined,
  now: number,
): OpenPanel | null =>
  panel?.kind === "schedule"
    ? { ...panel, data: rows, now, state: refreshedSchedules(panel.state, rows) }
    : panel;
