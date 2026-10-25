/**
 * The text-input model behind the prompt line: a value plus a cursor offset,
 * with pure operations. Framework-free so it unit-tests without Ink, and so the
 * App's key handler owns editing (no third-party input can echo a control key).
 *
 * The value may contain `\n` (multi-line prompts); the cursor is a plain offset
 * into the string. Selection is an `anchor` (the end the user started dragging
 * from): the selected range is `[min(anchor, cursor), max(anchor, cursor)]`
 * when `anchor !== null && anchor !== cursor`. `desiredCol` remembers the column
 * a vertical move wanted, so up→short line→down restores it (readline
 * behaviour) instead of walking the clamped column; every op except
 * `moveVertical` resets it, so it never goes stale across edits.
 *
 * Word/line/vertical movement is line-aware (logical lines, split on `\n`);
 * rendering those lines into the box lives with `input-view.ts`.
 */
export interface EditorState {
  readonly value: string;
  readonly cursor: number;
  /** Selection start (drag origin); `null` = no selection. */
  readonly anchor: number | null;
  /** Column requested by the last vertical move (may exceed a short line). */
  readonly desiredCol?: number | null;
}

export const EMPTY_EDITOR: EditorState = { value: "", cursor: 0, anchor: null, desiredCol: null };

const clampCursor = (value: string, cursor: number): number =>
  Math.max(0, Math.min(value.length, cursor));

/** The selected `[start, end)` offsets, or `null` when nothing is selected. */
export function selectionRange(state: EditorState): readonly [number, number] | null {
  if (state.anchor === null || state.anchor === state.cursor) {
    return null;
  }
  const lo = Math.min(state.anchor, state.cursor);
  const hi = Math.max(state.anchor, state.cursor);
  return [lo, hi] as const;
}

/**
 * Apply a move, resolving the selection:
 * - `extend`: start (or keep) the selection at `anchor` and move the cursor.
 * - otherwise, with a selection: collapse it at the edge being travelled to
 *   (`"min"` / `"max"`), clearing `anchor`.
 * - otherwise: just move the cursor.
 * `desiredCol` is preserved here; the public ops set it.
 */
function applyMove(
  state: EditorState,
  target: number,
  extend: boolean,
  edge: "min" | "max",
): EditorState {
  const t = clampCursor(state.value, target);
  if (extend) {
    return { ...state, cursor: t, anchor: state.anchor ?? state.cursor };
  }
  const range = selectionRange(state);
  if (range) {
    const [lo, hi] = range;
    return { ...state, cursor: edge === "min" ? lo : hi, anchor: null };
  }
  return { ...state, cursor: t };
}

/** Insert `text` at the cursor, advancing past it. Replaces a selection. */
export function insert(state: EditorState, text: string): EditorState {
  const range = selectionRange(state);
  if (range) {
    const [lo, hi] = range;
    return {
      value: state.value.slice(0, lo) + text + state.value.slice(hi),
      cursor: lo + text.length,
      anchor: null,
      desiredCol: null,
    };
  }
  const at = clampCursor(state.value, state.cursor);
  // A collapsed anchor (anchor === cursor) is stale selection state: an edit
  // invalidates it, so clear it.
  return {
    value: state.value.slice(0, at) + text + state.value.slice(at),
    cursor: at + text.length,
    anchor: null,
    desiredCol: null,
  };
}

/** Delete the character before the cursor. Deletes a selection (cursor to its start). */
export function deleteBack(state: EditorState): EditorState {
  const range = selectionRange(state);
  if (range) {
    const [lo, hi] = range;
    return {
      value: state.value.slice(0, lo) + state.value.slice(hi),
      cursor: lo,
      anchor: null,
      desiredCol: null,
    };
  }
  const at = clampCursor(state.value, state.cursor);
  if (at === 0) {
    return state;
  }
  // As in `insert`: a collapsed anchor is stale selection state — clear it.
  return {
    value: state.value.slice(0, at - 1) + state.value.slice(at),
    cursor: at - 1,
    anchor: null,
    desiredCol: null,
  };
}

/** Move the cursor by `delta` characters (optionally extending a selection). */
export function moveCursor(state: EditorState, delta: number, extend = false): EditorState {
  const edge = delta >= 0 ? "max" : "min";
  return { ...applyMove(state, state.cursor + delta, extend, edge), desiredCol: null };
}

// Combining marks (\p{M}: accents, vowel signs, virama, VS16, keycap) belong to
// their base character, so a boundary never leaves an orphan mark.
const WORD = /[\p{L}\p{M}\p{N}_]/u;

/**
 * Jump to the next (forward) or previous (backward) word boundary, readline
 * style: skip the gap (non-word chars, incl. punctuation and newlines), then
 * the word. So a jump always lands on a word boundary; newlines count as gap,
 * so a jump CAN cross a logical line (the next word, wherever it is).
 * `word = /[\p{L}\p{M}\p{N}_]/u`.
 */
export function moveWord(state: EditorState, dir: -1 | 1, extend = false): EditorState {
  const i = wordBoundary(state.value, clampCursor(state.value, state.cursor), dir);
  return { ...applyMove(state, i, extend, dir === 1 ? "max" : "min"), desiredCol: null };
}

/** The word boundary reached from `at` going `dir` (shared by jump and delete). */
function wordBoundary(v: string, at: number, dir: -1 | 1): number {
  let i = at;
  if (dir === 1) {
    while (i < v.length && !WORD.test(v[i] ?? "")) i++; // the gap first
    while (i < v.length && WORD.test(v[i] ?? "")) i++; // then the word
  } else {
    while (i > 0 && !WORD.test(v[i - 1] ?? "")) i--; // the gap before the cursor
    while (i > 0 && WORD.test(v[i - 1] ?? "")) i--; // then the whole word
  }
  return i;
}

/**
 * Delete the previous (`-1`) or next (`1`) word, with the SAME boundary as
 * `moveWord` (skip the gap, then the word; crosses `\n`). With a selection it
 * deletes the selection instead, exactly as Backspace does. A no-op at the
 * buffer's start/end.
 */
export function deleteWord(state: EditorState, dir: -1 | 1): EditorState {
  const range = selectionRange(state);
  if (range) {
    return deleteBack(state);
  }
  const at = clampCursor(state.value, state.cursor);
  const to = wordBoundary(state.value, at, dir);
  if (to === at) {
    return state;
  }
  const [lo, hi] = to < at ? [to, at] : [at, to];
  return {
    value: state.value.slice(0, lo) + state.value.slice(hi),
    cursor: lo,
    anchor: null,
    desiredCol: null,
  };
}

/** 0-based index of the logical line containing offset `at`. */
function lineIndex(value: string, at: number): number {
  let n = 0;
  for (let i = 0; i < at; i++) {
    if (value[i] === "\n") n++;
  }
  return n;
}

/** Absolute offset of the start of logical line `line` (0-based). */
function lineStart(value: string, line: number): number {
  let off = 0;
  for (let r = 0; r < line; r++) {
    const nl = value.indexOf("\n", off);
    if (nl === -1) {
      return value.length;
    }
    off = nl + 1;
  }
  return off;
}

/** Number of characters on logical line `line` (0-based), excluding its `\n`. */
function lineLen(value: string, line: number): number {
  const start = lineStart(value, line);
  const nl = value.indexOf("\n", start);
  return nl === -1 ? value.length - start : nl - start;
}

/** Total number of logical lines in `value`. */
function totalLines(value: string): number {
  let n = 1;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "\n") n++;
  }
  return n;
}

/** Absolute offset of `col` on logical line `line`, clamped to the line. */
function lineCol(value: string, line: number, col: number): number {
  const start = lineStart(value, line);
  return start + Math.min(col, lineLen(value, line));
}

/** Home/End: move to the start or end of the cursor's logical line. */
export function moveLine(state: EditorState, edge: "start" | "end", extend = false): EditorState {
  const v = state.value;
  const at = clampCursor(v, state.cursor);
  const li = lineIndex(v, at);
  const target = edge === "start" ? lineStart(v, li) : lineStart(v, li) + lineLen(v, li);
  return {
    ...applyMove(state, target, extend, edge === "start" ? "min" : "max"),
    desiredCol: null,
  };
}

/**
 * Move one logical line up (`-1`) or down (`+1`), preserving the column. The
 * requested column is remembered in `desiredCol` so it survives a clamped
 * landing on a shorter line. At the buffer's first/last line this is a no-op
 * (the App turns a plain Up/Down there into a history recall).
 */
export function moveVertical(state: EditorState, dir: -1 | 1, extend = false): EditorState {
  const v = state.value;
  const at = clampCursor(v, state.cursor);
  const li = lineIndex(v, at);
  const targetLi = li + dir;
  if (targetLi < 0 || targetLi >= totalLines(v)) {
    if (!extend) {
      return state; // at the buffer edge: no vertical move (plain Up/Down → history in the App)
    }
    // Shift at the edge: extend the selection to the buffer's boundary.
    const t = dir === -1 ? 0 : v.length;
    return { ...state, cursor: t, anchor: state.anchor ?? state.cursor };
  }
  const col = at - lineStart(v, li);
  const desired = state.desiredCol ?? col;
  return {
    ...applyMove(state, lineCol(v, targetLi, desired), extend, dir === -1 ? "min" : "max"),
    desiredCol: desired,
  };
}

/** Replace the whole value, placing the cursor at `cursor` (default: the end). */
export function setValue(value: string, cursor: number = value.length): EditorState {
  return { value, cursor: clampCursor(value, cursor), anchor: null, desiredCol: null };
}
