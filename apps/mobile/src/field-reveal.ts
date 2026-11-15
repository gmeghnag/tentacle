/**
 * When to scroll a focused field (and the action under it) back above the
 * keyboard (mobile-ui-polish slice 6). `KeyboardAvoidingView` shrinks the
 * screen, but a `ScrollView` keeps its offset, so a field low in the list ends
 * up under the keyboard. Pure and React-free (AGENTS §7): the screen feeds it
 * focus and keyboard events and performs the scroll it returns.
 *
 * The reveal fires once BOTH hold — the field focused and the keyboard up —
 * on whichever event completes the pair, and again on every keyboard frame
 * change while focused (the QuickType bar grows the keyboard), and on every
 * content resize while both hold (a pasted line wraps the multiline field and
 * pushes its button down). `keyboardDidShow`
 * is the cue (not `Will`): by then the avoiding view has already resized.
 */

export type FieldRevealEvent =
  | "focus"
  | "blur"
  | "keyboard-shown"
  | "keyboard-hidden"
  /** The list's content changed size (a multiline field wrapped as it filled). */
  | "content-resized";

export interface FieldRevealState {
  readonly focused: boolean;
  readonly keyboardUp: boolean;
}

export const FIELD_REVEAL_IDLE: FieldRevealState = { focused: false, keyboardUp: false };

export function revealStep(
  state: FieldRevealState,
  event: FieldRevealEvent,
): { readonly state: FieldRevealState; readonly reveal: boolean } {
  switch (event) {
    case "focus":
      return { state: { ...state, focused: true }, reveal: state.keyboardUp };
    case "blur":
      return { state: { ...state, focused: false }, reveal: false };
    case "keyboard-shown":
      return { state: { ...state, keyboardUp: true }, reveal: state.focused };
    case "keyboard-hidden":
      return { state: { ...state, keyboardUp: false }, reveal: false };
    case "content-resized":
      return { state, reveal: state.focused && state.keyboardUp };
  }
}
