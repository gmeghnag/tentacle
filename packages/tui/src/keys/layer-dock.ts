import { dockKey, dockKindOf } from "../background-focus.ts";
/**
 * The layers between the panels and line editing (docs/feat/app-decomposition.md
 * S3), in the order that is the safety property:
 *
 * 9.  **dock** — `dockKey` (`background-focus.ts`) decides; this executes. It
 *     runs BEFORE the Esc-abort layers, so Esc in the dropdown closes the dock
 *     and never stops a running turn (S0 precedence pin). Its STATE is applied
 *     for every verdict, `pass` included: a printable key on the focused pill
 *     both types into the input AND returns the focus to it (owner P3 (a)) — a
 *     "state only on consumed" reading left the pill focused, so the next Enter
 *     opened the dropdown and the message never went out (Review round 3, H1).
 * 10. **escUpload** — Esc aborts an upload in flight; the chips stay and the
 *     failure path says "upload cancelled".
 * 11. **escAbort** — Esc stops the running turn.
 * 12. **expandAll** — Ctrl+O.
 * 13. **palette** — the slash-command menu owns the arrows, Tab, Enter, Esc.
 * 14. **mouse** — the chunk machine (`mouse-stream.ts`), whose `pass` carries a
 *     restored `[` to line editing. It is last because everything above reads a
 *     key as a key; a mouse report is only read here.
 */
import type { KeyLayer, LayerStep } from "./contract.ts";
import { consumed, passThrough } from "./contract.ts";
import type { KeyEffect } from "./effects.ts";

const NONE: LayerStep = { effects: [], verdict: "pass", carry: "" };

/** 9. The dock. Behind a panel it is not offered the key at all. */
export const dockLayer: KeyLayer = {
  name: "dock",
  step: (snap): LayerStep => {
    if (snap.panel !== null) {
      return NONE;
    }
    const state = snap.dock();
    const step = dockKey(state, snap.char, snap.key, {
      ids: snap.dockIds(),
      // Both kinds open: a child onto its drawer, a JOB onto its output tail.
      openable: (id: string) => id.startsWith("sa-") || id.startsWith("bg-"),
      // The LIVE field, never a stashed `drafts` copy: typing goes straight to
      // `field`, so `drafts` is empty on the first open/close (Review H1).
      draft: snap.fieldValue,
    });
    const effects: KeyEffect[] = [];
    if (step.state !== state) {
      effects.push({ kind: "setDock", state: step.state });
    }
    if (step.effect.kind === "pass") {
      // Ctrl+T from the INPUT (owner Q16 (b)): the same toggle `/agents` runs.
      if (snap.key.ctrl === true && snap.char === "t") {
        effects.push({ kind: "toggleAgents" });
        return consumed(...effects);
      }
      return effects.length === 0 ? NONE : passThrough(...effects);
    }
    if (step.effect.kind === "stop") {
      // Routed by the id's KIND, never by which list the row came from: a job's
      // `x`+`y` goes to `session/job_kill` (the daemon's own registry), and a
      // scheduled wake's goes to `session/schedule_delete` (cron-tool S5).
      effects.push(
        dockKindOf(step.effect.id) === "job"
          ? { kind: "killJob", id: step.effect.id }
          : dockKindOf(step.effect.id) === "schedule"
            ? { kind: "deleteSchedule", id: step.effect.id }
            : { kind: "killChild", id: step.effect.id },
      );
    } else if (step.effect.kind === "open" || step.effect.kind === "close") {
      effects.push({ kind: "fieldSet", text: step.effect.draftIn });
    }
    return { effects, verdict: "consumed", carry: "" };
  },
};

/** 10. Esc while an upload is in flight: cancel the upload, never the turn. */
export const escUploadLayer: KeyLayer = {
  name: "escUpload",
  step: (snap): LayerStep =>
    snap.key.escape === true && snap.uploadInFlight() ? consumed({ kind: "cancelUpload" }) : NONE,
};

/** 11. Esc mid-turn: stop the turn (only with an abort handle to stop). */
export const escAbortLayer: KeyLayer = {
  name: "escAbort",
  step: (snap): LayerStep =>
    snap.key.escape === true && snap.running() && snap.abortable()
      ? consumed({ kind: "abortTurn" })
      : NONE,
};

/** 12. Ctrl+O: expand/collapse all. */
export const expandAllLayer: KeyLayer = {
  name: "expandAll",
  step: (snap): LayerStep =>
    snap.key.ctrl === true && snap.char === "o" ? consumed({ kind: "toggleExpandAll" }) : NONE,
};

/**
 * 13. The slash-command palette: arrows move the highlight, Tab completes the
 * name, Enter runs it, Esc dismisses. It takes priority over scrolling and line
 * editing so the menu is drivable; a key it does not claim falls through.
 */
export const paletteLayer: KeyLayer = {
  name: "palette",
  step: (snap): LayerStep => {
    if (!snap.paletteOpen) {
      return NONE;
    }
    const name = snap.paletteNames[snap.commandSel];
    if (snap.key.upArrow) {
      return consumed({ kind: "moveCommandSel", step: -1 });
    }
    if (snap.key.downArrow) {
      return consumed({ kind: "moveCommandSel", step: 1 });
    }
    if (snap.key.tab) {
      return name === undefined ? consumed() : consumed({ kind: "fieldSet", text: name });
    }
    if (snap.key.return) {
      if (name === undefined) {
        return NONE;
      }
      return consumed({ kind: "fieldReset" }, { kind: "runCommand", name });
    }
    if (snap.key.escape) {
      return consumed({ kind: "fieldReset" });
    }
    return NONE;
  },
};
