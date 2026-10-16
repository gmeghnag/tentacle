/**
 * Shell-style prompt history for the input line. Pure, so it unit-tests without
 * Ink; the App keeps the state in refs (history is session-local, in-memory).
 *
 * `index === items.length` means "on the live draft" (not in history). Up
 * (dir -1) walks towards the oldest entry; Down (dir +1) walks back and, past
 * the newest entry, restores the draft that was live when history was first
 * entered. Only consecutive duplicates are dropped (like bash).
 */
export interface HistoryState {
  readonly items: readonly string[];
  /** Position in `items`; `items.length` = on the draft. */
  readonly index: number;
}

export interface RecallResult {
  readonly index: number;
  /** The text the input should show. */
  readonly value: string;
  /** The live draft to restore once the walk is over (may be ""). */
  readonly draft: string;
}

/** Append `text` unless it is empty or repeats the last entry. */
export function pushHistory(items: readonly string[], text: string): string[] {
  const t = text.trim();
  if (t === "" || items[items.length - 1] === t) {
    return [...items];
  }
  return [...items, t];
}

/**
 * Step the history by `dir` (-1 up/older, +1 down/newer). Entering history
 * (the first Up from the draft slot) saves `draft`; reaching the draft slot
 * again restores it. No-ops at the two ends.
 */
export function recall(state: HistoryState, dir: -1 | 1, draft: string): RecallResult {
  const n = state.items.length;
  if (state.index >= n) {
    // On the draft slot. Up enters history (if there is any); Down is a no-op.
    if (dir === -1 && n > 0) {
      return { index: n - 1, value: state.items[n - 1] ?? "", draft };
    }
    return { index: state.index, value: draft, draft };
  }
  if (dir === -1) {
    const next = state.index - 1;
    if (next < 0) {
      // Oldest entry: stay put.
      return { index: state.index, value: state.items[state.index] ?? "", draft };
    }
    return { index: next, value: state.items[next] ?? "", draft };
  }
  const next = state.index + 1;
  if (next >= n) {
    // Past the newest entry: back to the live draft.
    return { index: n, value: draft, draft };
  }
  return { index: next, value: state.items[next] ?? "", draft };
}
