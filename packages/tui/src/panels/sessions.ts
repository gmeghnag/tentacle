/**
 * `/sessions` (docs/feat/connect-sessions.md): the daemon's sessions as a flat
 * list with its own cursor and delete confirm. Its keys are richer than a tree
 * panel's — choose (switch), delete (arm, then delete) — and every decision is
 * `sessions-panel.ts`'s; this descriptor only turns a decision into the router's
 * `LayerStep`, exactly as the pre-S7 `sessionsLayer` did.
 */
import type { LayerStep } from "../keys/contract.ts";
import { NOTHING, consumed, passThrough } from "../keys/contract.ts";
import type { KeySnapshot } from "../keys/snapshot.ts";
import {
  type SessionsState,
  type SessionsView,
  sessionRows,
  sessionsMove,
  sessionsView,
} from "../sessions-panel.ts";
import {
  deleteFailedNotice,
  sessionsDelete as deleteStep,
  refreshedSessions,
  sessionsAt,
  sessionsChoose,
  sessionsKey,
  sessionsListError,
  sessionsRefreshApplies,
} from "../sessions-panel.ts";
import type { PanelView, TreeAction } from "../tree-panel.ts";
import type { PanelAt, PanelKind } from "./registry.ts";
import type { OpenPanel, SessionsPanel } from "./types.ts";

function view(panel: SessionsPanel, at: PanelAt): PanelView {
  return sessionsView(panel.data, panel.state, at.current, panel.now, at.width, at.maxBody);
}

export const sessionsKind: PanelKind<SessionsPanel> = {
  kind: "sessions",
  layer: "sessions",
  // The list is read live (`at.current`): no current session is captured in the state.
  view,
  apply: (panel: SessionsPanel, action: TreeAction, _width: number): SessionsPanel =>
    // Only the moves apply here; every other session key is this kind's `key`.
    action === "up" || action === "down"
      ? { ...panel, state: sessionsMove(panel.state, action, sessionRows(panel.data).length) }
      : panel,
  click: (
    panel: SessionsPanel,
    at: PanelView,
    bodyIndex: number,
    _width: number,
  ): SessionsPanel => {
    const row = at.rows[bodyIndex];
    const count = sessionRows(panel.data).length;
    const index = at.start + bodyIndex;
    return row?.kind === "head" && index < count
      ? { ...panel, state: { cursor: index, armed: null } }
      : panel;
  },
  key: (panel: SessionsPanel, snap: KeySnapshot): LayerStep => {
    const action = sessionsKey(snap.char, snap.key);
    if (action === "none") {
      // Any other key disarms a pending delete, then falls through.
      return panel.state.armed === null
        ? NOTHING
        : passThrough({ kind: "setSessionsState", state: { ...panel.state, armed: null } });
    }
    const entry = sessionsAt(panel.data, panel.state);
    const current = snap.sessionId();
    if (action === "close") {
      return consumed({ kind: "closePanel" });
    }
    if (action === "up" || action === "down") {
      return consumed({ kind: "applyPanel", action });
    }
    if (action === "choose" && entry !== undefined) {
      const busy = snap.running() || snap.compacting();
      const choice = sessionsChoose(entry, current, busy, snap.switching());
      if (choice.kind === "refused") {
        return consumed({ kind: "pushNotice", text: choice.text });
      }
      if (choice.kind === "switch") {
        return consumed(
          { kind: "closePanel" },
          { kind: "switchTo", id: choice.id, reopen: choice.reopen },
        );
      }
      // "stay": the panel closes, one effect, exactly as before.
      return consumed({ kind: "closePanel" });
    }
    if (action === "delete" && entry !== undefined && snap.sessions !== undefined) {
      const step = deleteStep(panel.state, entry, current);
      // The panel's state is written for EVERY step (arm, delete, refused): all
      // three carry the next `armed`, exactly as the inline handler set it.
      if (step.kind === "refused") {
        return consumed(
          { kind: "setSessionsState", state: step.state },
          { kind: "pushNotice", text: step.text },
        );
      }
      if (step.kind === "arm") {
        return consumed({ kind: "setSessionsState", state: step.state });
      }
      // The refresh updates only THIS panel, if still open (never re-opens one).
      return consumed(
        { kind: "setSessionsState", state: step.state },
        { kind: "sessionsDelete", id: step.id, startedGen: snap.panelGen() },
      );
    }
    return NOTHING;
  },
};

// Re-exported for the executor: the delete's refresh decides at the App with
// these, so the module that owns the decisions stays the only importer of them.
export { sessionsListError, deleteFailedNotice, sessionsRefreshApplies, refreshedSessions };

/**
 * The `/sessions` panel's OWN state rules (S7, plan H4(4)). Three App-side
 * `kind === "sessions"` branches used to write them inline; each is this kind's
 * rule, so it lives here — a new panel kind brings its own, and neither `App.tsx`
 * nor this file grows a switch.
 *
 * Each takes the panel as `null | OpenPanel` because that is what a functional
 * `setPanel` update hands over, and returns it unchanged when it is another kind.
 */

/**
 * Is the open panel a `/sessions` one? The delete's refresh gate asks (and must
 * read the live panel: `panelRef`), so the question lives with the kind that
 * knows the answer.
 */
export const isSessionsOpen = (panel: OpenPanel | null): boolean => panel?.kind === "sessions";

/** The panel with its state replaced (`sessionsDelete`'s arm/answer). */
export const withSessionsState = (
  panel: OpenPanel | null,
  state: SessionsState,
): OpenPanel | null => (panel?.kind === "sessions" ? { ...panel, state } : panel);

/**
 * The panel RE-READ at the next render: its "current" row is live (Review R3-1),
 * so a switch to another session must repaint it without re-opening it.
 */
export const touchPanel = (panel: OpenPanel | null): OpenPanel | null =>
  panel?.kind === "sessions" ? { ...panel } : panel;

/** The panel after its delete's refresh: the new list, now-stamped, cursor kept. */
export const withSessionsRefresh = (
  panel: OpenPanel | null,
  view: SessionsView,
): OpenPanel | null =>
  panel?.kind === "sessions"
    ? { ...panel, data: view, now: Date.now(), state: refreshedSessions(panel.state, view) }
    : panel;
