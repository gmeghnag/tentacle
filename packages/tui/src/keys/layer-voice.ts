import type { KeyLayer, LayerStep } from "./contract.ts";
import { consumed } from "./contract.ts";
import { NOTHING } from "./contract.ts";
/**
 * 7. Voice dictation (docs/feat/voice-dictation.md, F6/F7).
 *
 * The dictation's key and its two escape hatches. Placed AFTER `paste` and
 * BEFORE `sessions`/`tree`/`dock`/`escUpload`/`escAbort`, and the position is the
 * point rather than a detail:
 *
 * - **F7 — Esc while dictating must not abort the agent's turn.** Esc already
 *   means "cancel the upload" (10) and "stop the turn" (11). While audio is
 *   being captured or transcribed, this layer takes Esc first, so the turn keeps
 *   running and only the dictation is discarded. Idle, it passes, so every Esc
 *   behaviour the TUI had is untouched.
 * - **F6 — Enter while listening must not send.** The field would go out without
 *   the dictation and the transcript would then land in an emptied field. Enter
 *   finishes the dictation instead; the user presses it again to send.
 *
 * Behind a dialog, the palette or a panel it passes: those own the screen, and a
 * dictation must not start from underneath one. It also passes while `idle`
 * unless the chunk IS the voice key, so typing, the arrows and every other
 * binding are exactly as they were.
 */
import type { KeyEffect } from "./effects.ts";

const NONE: LayerStep = NOTHING;

/** Does this chunk press `voice.key` (in the `ctrl+<letter>` spelling)? */
export function isVoiceKey(
  snap: { readonly char: string; readonly key: { readonly ctrl?: boolean } },
  key: string,
): boolean {
  const match = /^ctrl\+([a-z])$/.exec(key);
  if (match === null) return false;
  return snap.key.ctrl === true && snap.char === match[1];
}

export const voiceKeyLayer: KeyLayer = {
  name: "voice",
  step: (snap): LayerStep => {
    // A dialog/palette/panel owns the screen: not the voice layer's chunk.
    if (snap.panel !== null || snap.paletteOpen || snap.permission.pending !== null) return NONE;
    const phase = snap.voice();
    // `off` is terminal for this session; taking the key would eat it silently.
    if (phase === "off") return NONE;

    const effects: KeyEffect[] = [];

    // Esc: cancel while a dictation exists (either captured or being
    // transcribed). Idle Esc falls through to escUpload/escAbort unchanged.
    if (snap.key.escape === true) {
      return phase === "starting" || phase === "listening" || phase === "transcribing"
        ? consumed({ kind: "voiceCancel" })
        : NONE;
    }

    // Enter finishes, and NEVER submits (F6).
    if (snap.key.return === true) {
      return phase === "listening" || phase === "starting"
        ? consumed({ kind: "voiceFinish" })
        : NONE;
    }

    if (!isVoiceKey(snap, snap.voiceKey())) return NONE;
    // One key, two meanings: idle starts, running finishes (there is no key-up
    // in a terminal, so hold-to-talk is not implementable — Owner Q1).
    return consumed(phase === "idle" ? { kind: "voiceToggle" } : { kind: "voiceToggle" });
  },
};
