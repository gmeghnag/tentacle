/**
 * The spinner slot: ONE row above the input that says what the harness is doing
 * (docs/feat/harness-notices.md S3, owner decision 3).
 *
 * A compaction used to be two transcript lines of its own — `_Compacting the
 * conversation…_` while it ran and `_Context compacted — 97 → 2 messages._` when
 * it settled. Now it takes the slot the spinner already occupies: `Compacting…`
 * with the same shimmer and elapsed figure while it runs, and `Compacted ✓` in
 * grey for `COMPACTED_SHOWN_MS` after it succeeded. The transcript instead gets
 * a separator rule at the compaction point, which survives `--resume`.
 *
 * The DECISION is here, pure and React-free (AGENTS §7), because two callers must
 * agree on it or the frame is one row off: `app-layout.ts` reserves the row from
 * this view, and `AppView.tsx` paints it. A second rule ("a slot row exists while
 * running or loading") is exactly the drift this file exists to prevent.
 */

/** How long `Compacted ✓` stays in the slot before it goes (owner: ~3 s). */
export const COMPACTED_SHOWN_MS = 3_000;

/** Everything the slot decides on: the display state's turn facts plus the compaction's own. */
export interface SlotFacts {
  /** A long history is being warmed before it is committed (`loading history (n/m)…`). */
  readonly loading: { readonly done: number; readonly total: number } | null;
  readonly running: boolean;
  readonly reasoning: boolean;
  readonly reasoningStartedAt: number | null;
  readonly turnStartedAt: number | null;
  /** When this TUI's own `/compact` began; `null` when none runs. */
  readonly compactingSince: number | null;
  /** When it last succeeded; `null` when none, or when a turn/`/clear` cleared it. */
  readonly compactedAt: number | null;
  /** The frame's clock (the App's `Date.now()`; a test's fake clock). */
  readonly now: number;
}

/**
 * What the slot shows, or `null` for no row at all. Priority (owner decision 3):
 * loading > a running turn > my compaction > `Compacted ✓`. So a prompt typed
 * during the 3 s replaces `Compacted ✓` with `Thinking…` at once, and a turn
 * another device runs outranks a compaction of mine.
 */
export type SlotView =
  | { readonly kind: "loading"; readonly done: number; readonly total: number }
  | { readonly kind: "thinking" | "working" | "compacting"; readonly since: number }
  | { readonly kind: "compacted" };

/** The slot's one decision. `since` is what the elapsed figure counts from. */
export function slotView(facts: SlotFacts): SlotView | null {
  if (facts.loading !== null) {
    return { kind: "loading", done: facts.loading.done, total: facts.loading.total };
  }
  if (facts.running) {
    // A reasoning turn counts from when the reasoning began (the old inline rule).
    const since = (facts.reasoning ? facts.reasoningStartedAt : null) ?? facts.turnStartedAt;
    return {
      kind: facts.reasoning ? "thinking" : "working",
      since: since ?? facts.now,
    };
  }
  if (facts.compactingSince !== null) {
    return { kind: "compacting", since: facts.compactingSince };
  }
  // The boundary is exclusive: at exactly `COMPACTED_SHOWN_MS` it is gone.
  if (facts.compactedAt !== null && facts.now - facts.compactedAt < COMPACTED_SHOWN_MS) {
    return { kind: "compacted" };
  }
  return null;
}
