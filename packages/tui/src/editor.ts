/**
 * The text-input model behind the prompt line: a value plus a cursor offset,
 * with pure operations. Framework-free so it unit-tests without Ink, and so the
 * App's key handler owns editing (no third-party input can echo a control key).
 *
 * The value may contain `\n` (multi-line prompts); the cursor is a plain offset
 * into the string, so these operations are line-agnostic. Vertical movement and
 * rendering into rows live with the input component.
 */
export interface EditorState {
  readonly value: string;
  readonly cursor: number;
}

export const EMPTY_EDITOR: EditorState = { value: "", cursor: 0 };

const clampCursor = (value: string, cursor: number): number =>
  Math.max(0, Math.min(value.length, cursor));

/** Insert `text` at the cursor, advancing past it. */
export function insert(state: EditorState, text: string): EditorState {
  const at = clampCursor(state.value, state.cursor);
  return {
    value: state.value.slice(0, at) + text + state.value.slice(at),
    cursor: at + text.length,
  };
}

/** Delete the character before the cursor (backspace). No-op at the start. */
export function deleteBack(state: EditorState): EditorState {
  const at = clampCursor(state.value, state.cursor);
  if (at === 0) {
    return state;
  }
  return { value: state.value.slice(0, at - 1) + state.value.slice(at), cursor: at - 1 };
}

/** Move the cursor by `delta` characters, clamped to the value. */
export function moveCursor(state: EditorState, delta: number): EditorState {
  return { ...state, cursor: clampCursor(state.value, state.cursor + delta) };
}

/** Replace the whole value, placing the cursor at `cursor` (default: the end). */
export function setValue(value: string, cursor: number = value.length): EditorState {
  return { value, cursor: clampCursor(value, cursor) };
}
