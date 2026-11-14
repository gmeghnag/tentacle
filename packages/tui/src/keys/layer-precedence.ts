import { dockClaimsCtrlX } from "../background-focus.ts";
import { idleChord, stepChord } from "../chord.ts";
import { quitConfirmKey } from "../commands.ts";
/**
 * The first three layers (docs/feat/app-decomposition.md S3), in the order that
 * IS the safety property:
 *
 * 1. **shiftTab** — auto-accept toggles in ANY state (idle, running, over the
 *    palette, over the quit dialog), so it is decided before everything else.
 * 2. **quitConfirm** — every key answers `/quit`'s dialog BEFORE the chord and
 *    before the permission dialog, so its `y` can never approve an ask that
 *    opened meanwhile (`App.tsx:3814–3833` pre-S3; S0b's no-render-between pin).
 * 3. **chord** — `Ctrl+X Ctrl+S` (send queued now) before the permission dialog,
 *    yet it PASSES a key that breaks the chord. The one exception is a `ctrl+x`
 *    the dock owns (dropdown focused, not pinned): the chord must not consume
 *    it, and its state is reset (`dockClaimsCtrlX`).
 *
 * All three were one `if` each inline; the decisions they call are unchanged
 * (`stepChord`, `quitConfirmKey`, `dockClaimsCtrlX`), and this file adds none.
 */
import type { KeyLayer, LayerStep } from "./contract.ts";
import { NOTHING, consumed, passThrough } from "./contract.ts";
import type { KeyEffect } from "./effects.ts";

/** 1. Shift+Tab: auto-accept, in every state (never the palette's Tab). */
export const shiftTabLayer: KeyLayer = {
  name: "shiftTab",
  step: (snap): LayerStep =>
    snap.key.tab && snap.key.shift
      ? consumed({ kind: "toggleAutoAccept" })
      : { effects: [], verdict: "pass", carry: "" },
};

/**
 * 2. `/quit`'s confirmation: every other key answers it. `y` closes (and, for a
 * dialog that spoke for others, closes their session too); Ctrl+C is "No" —
 * it dismisses, so the `(y/N)` text stays true and losing children needs a `y`.
 */
export const quitConfirmLayer: KeyLayer = {
  name: "quitConfirm",
  step: (snap): LayerStep => {
    const facts = snap.quitConfirm();
    if (facts === null) {
      return { effects: [], verdict: "pass", carry: "" };
    }
    // Read the facts BEFORE clearing: who the dialog spoke for decides whether
    // `y` closes others' session, and Ctrl+C's dismiss drops the dialog.
    const yes =
      quitConfirmKey(snap.char, snap.key.ctrl === true || snap.key.meta === true) === "yes";
    if (!yes) {
      return consumed({ kind: "setQuitConfirm", facts: null });
    }
    return consumed(
      { kind: "setQuitConfirm", facts: null },
      // `closeForAll` is only for a dialog that SAID "close the session for all".
      { kind: "quit", closeForAll: facts.others > 0 },
    );
  },
};

/**
 * 3. The `Ctrl+X Ctrl+S` chord. A key that breaks the chord goes on below
 * unchanged — EXCEPT while the LIST has the keys: there `ctrl+x` is the dock's
 * stop (arm, then confirm), so the chord keeps its idle state and passes.
 */
export const chordLayer: KeyLayer = {
  name: "chord",
  step: (snap): LayerStep => {
    const state = snap.chord();
    if (dockClaimsCtrlX(snap.dock())) {
      // The dock owns this `ctrl+x`: the chord must not consume it, and its
      // half-armed state is dropped. A write only when the state is armed — the
      // inline handler assigned `idleChord` unconditionally, which is the same
      // thing (writing idle over idle changes nothing) minus the no-op.
      return state.armedAt === null ? NOTHING : passThrough({ kind: "setChord", state: idleChord });
    }
    const chord = stepChord(state, snap.char, snap.key, Date.now());
    // The inline handler wrote `chordRef.current = chord.state` for EVERY verdict;
    // `stepChord` returns the same object when nothing changed, so a write is
    // emitted only when it would actually change the ref (identical behaviour,
    // and the effects list stays readable: no no-op writes).
    const write: readonly KeyEffect[] =
      chord.state === state ? [] : [{ kind: "setChord", state: chord.state }];
    if (chord.action === "consumed") {
      return write.length === 0 ? consumed() : consumed(...write);
    }
    if (chord.action === "sendNow") {
      return consumed(...write, { kind: "sendNow" });
    }
    // "pass": the key goes on, with the (possibly reset) state applied first.
    return write.length === 0 ? NOTHING : passThrough(...write);
  },
};
