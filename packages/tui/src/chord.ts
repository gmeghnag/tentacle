/**
 * The `Ctrl+X Ctrl+S` chord (send the queued messages now;
 * docs/feat/send-now-c.md). Pure: the App feeds it every key and acts on the
 * returned action. Ctrl+X arms it; Ctrl+S within the window fires it. Any
 * other key, or a late Ctrl+S, disarms it and is passed on unchanged, so a
 * broken chord behaves as if it never started. Letters match
 * case-insensitively: some terminals report Ctrl+Shift+S as `S`.
 */

/** How long after Ctrl+X a Ctrl+S still completes the chord. */
export const CHORD_WINDOW_MS = 1500;

export interface ChordState {
  /** When Ctrl+X armed the chord, or null when idle. */
  readonly armedAt: number | null;
}

export const idleChord: ChordState = { armedAt: null };

/** `consumed`: the key was the chord's own (swallow it). `pass`: handle the key as usual. */
export type ChordAction = "sendNow" | "consumed" | "pass";

export function stepChord(
  state: ChordState,
  char: string,
  key: { readonly ctrl?: boolean },
  now: number,
): { readonly state: ChordState; readonly action: ChordAction } {
  const letter = key.ctrl ? char.toLowerCase() : "";
  if (letter === "x") {
    return { state: { armedAt: now }, action: "consumed" };
  }
  if (state.armedAt === null) {
    return { state, action: "pass" };
  }
  if (letter === "s" && now - state.armedAt <= CHORD_WINDOW_MS) {
    return { state: idleChord, action: "sendNow" };
  }
  return { state: idleChord, action: "pass" };
}
