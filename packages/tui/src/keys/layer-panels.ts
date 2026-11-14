import { applyPanel } from "../panel.ts";
import {
  deleteFailedNotice,
  refreshedSessions,
  sessionsAt,
  sessionsChoose,
  sessionsDelete,
  sessionsKey,
  sessionsListError,
  sessionsRefreshApplies,
} from "../sessions-panel.ts";
import { treeKey } from "../tree-panel.ts";
/**
 * The panel layers (docs/feat/app-decomposition.md S3): `/sessions`, then the
 * tree panels (`/mcp`, `/skills`, `/agents`, a sub-agent's or job's tail).
 *
 * Order is safety, not taste: the sessions panel's Esc must close the panel
 * rather than reach "Esc stops a running turn" below (S0 precedence pin), and a
 * mouse report must fall through BOTH (it is dispatched by the mouse layer).
 *
 * Two "act and pass" behaviours live here, both of them S0b matrix rows:
 * - a non-panel key on an ARMED sessions row DISARMS it and then falls through,
 *   so the key still does its own job (the wheel cancels the delete and scrolls);
 * - a key neither panel claims falls through to the layers below (the mouse
 *   layer then swallows it behind a panel — "behind a panel nothing edits",
 *   the 14th layer's role).
 */
import type { KeyLayer, LayerStep } from "./contract.ts";
import { consumed, passThrough } from "./contract.ts";

const NONE: LayerStep = { effects: [], verdict: "pass", carry: "" };

/**
 * 7. `/sessions`: every decision is `sessions-panel.ts`'s; this executes it.
 * Reads the CURRENT session id at key time (Review R3-1) and never the palette.
 */
export const sessionsLayer: KeyLayer = {
  name: "sessions",
  step: (snap): LayerStep => {
    const panel = snap.panel;
    if (panel?.kind !== "sessions") {
      return NONE;
    }
    const action = sessionsKey(snap.char, snap.key);
    if (action === "none") {
      // Any other key disarms a pending delete, then falls through.
      return panel.state.armed === null
        ? NONE
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
      const step = sessionsDelete(panel.state, entry, current);
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
    return NONE;
  },
};

/**
 * 8. The tree panels. Esc closes; a claimed action applies; anything else falls
 * through (the mouse layer swallows it behind a panel).
 */ export const treeLayer: KeyLayer = {
  name: "tree",
  step: (snap): LayerStep => {
    const panel = snap.panel;
    if (panel === null || panel.kind === "sessions") {
      return NONE;
    }
    const action = treeKey(snap.char, snap.key);
    if (action === "close") {
      return consumed({ kind: "closePanel" });
    }
    if (action === "none") {
      return NONE;
    }
    return consumed({ kind: "applyPanel", action });
  },
};

// Re-exported for the executor: the delete's refresh decides at the App with
// these, so the module that owns the decisions stays the only importer of them.
export { sessionsListError, deleteFailedNotice, sessionsRefreshApplies, refreshedSessions };
