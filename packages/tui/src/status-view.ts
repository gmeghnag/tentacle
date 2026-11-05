/**
 * The status bar's token figures (docs/fix/detach-live-followups.md F2, owner
 * OQ5). Pure. The agent reports usage only on a stream's `done`, so until THIS
 * TUI has applied one (a failed first turn, an attach, a `--resume`), nothing
 * was measured: the figures are unknown (`null`, rendered `–`), never a fake 0.
 * The first measured turn gives the real numbers.
 */
import type { DisplayState, TokenTotals } from "./state.ts";

export interface StatusTokens {
  /** The session totals this TUI measured; `null` until the first `usage`. */
  readonly totals: TokenTotals | null;
  /** The last measured prompt (the context fill); `null` until the first `usage`. */
  readonly context: number | null;
}

/** The count the daemon made at open (`session/context`): `exact` = the provider counted it. */
export interface ContextOpen {
  readonly used: number;
  readonly exact: boolean;
}

/**
 * What the ctx meter shows: the figure THIS TUI measured (a turn's usage) wins
 * and is exact; before that, the daemon's count at open (an estimate is
 * `approx`); with neither, unknown (`used: null`).
 */
export function contextShown(
  measured: number | null,
  open: ContextOpen | null,
): { used: number | null; approx: boolean } {
  if (measured !== null) {
    return { used: measured, approx: false };
  }
  return open === null ? { used: null, approx: false } : { used: open.used, approx: !open.exact };
}

export function statusTokens(
  state: Pick<DisplayState, "sessionTokens" | "lastTurnTokens">,
): StatusTokens {
  const last = state.lastTurnTokens;
  return last === null
    ? { totals: null, context: null }
    : { totals: state.sessionTokens, context: last.prompt };
}
