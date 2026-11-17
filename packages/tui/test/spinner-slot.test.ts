/**
 * S3 of docs/feat/harness-notices.md: the slot's ONE decision (`spinner-slot.ts`).
 * Every case here is the mutation named beside it, so none is decoration — the
 * plan's own table (loading > running > compacting > compacted, and the 3 s
 * boundary) is exactly what it pins.
 */
import { describe, expect, test } from "bun:test";
import { COMPACTED_SHOWN_MS, type SlotFacts, slotView } from "../src/spinner-slot.ts";

const NOW = 1_000_000;
const base = (over: Partial<SlotFacts> = {}): SlotFacts => ({
  loading: null,
  running: false,
  reasoning: false,
  reasoningStartedAt: null,
  turnStartedAt: null,
  compactingSince: null,
  compactedAt: null,
  now: NOW,
  ...over,
});

describe("slotView: the slot's priority", () => {
  test("nothing at rest → no row (the frame keeps its height)", () => {
    // Mutation: return a `thinking` view always → a spinner row on an idle TUI.
    expect(slotView(base())).toBe(null);
  });

  test("loading history outranks everything (it owns the row while a warm runs)", () => {
    // Mutation: check `running` first → a compaction's `Compacting…` while the
    // history is still being warmed, so the person never sees the warm's count.
    expect(
      slotView(
        base({
          loading: { done: 2, total: 9 },
          running: true,
          turnStartedAt: NOW - 5,
          compactingSince: NOW - 4,
          compactedAt: NOW - 1,
        }),
      ),
    ).toEqual({ kind: "loading", done: 2, total: 9 });
  });

  test("a running turn outranks my compaction and `Compacted ✓`", () => {
    // Mutation: swap the `compactingSince` branch above `running` → a turn that
    // streams while a stale compaction latch is up shows `Compacting…`.
    expect(
      slotView(base({ running: true, turnStartedAt: NOW - 7, compactingSince: NOW - 3 })),
    ).toEqual({ kind: "working", since: NOW - 7 });
    expect(slotView(base({ running: true, turnStartedAt: NOW - 7, compactedAt: NOW - 1 }))).toEqual(
      {
        kind: "working",
        since: NOW - 7,
      },
    );
  });

  test("reasoning picks `thinking` and counts from the reasoning's start, not the turn's", () => {
    // Mutation: always count from `turnStartedAt` → the label's elapsed jumps back
    // when the model starts reasoning in a turn that began earlier.
    expect(
      slotView(
        base({
          running: true,
          reasoning: true,
          reasoningStartedAt: NOW - 2,
          turnStartedAt: NOW - 40,
        }),
      ),
    ).toEqual({ kind: "thinking", since: NOW - 2 });
    // No reasoning start recorded → the turn's own start is the honest fallback
    // (never `now`, which would restart the figure at 0s on every frame).
    expect(slotView(base({ running: true, reasoning: true, turnStartedAt: NOW - 40 }))).toEqual({
      kind: "thinking",
      since: NOW - 40,
    });
    // A running turn with no start at all (a hand-built state) still shows a row.
    expect(slotView(base({ running: true }))).toEqual({ kind: "working", since: NOW });
  });

  test("my compaction shows while it runs — with its own start as the elapsed", () => {
    expect(slotView(base({ compactingSince: NOW - 3 }))).toEqual({
      kind: "compacting",
      since: NOW - 3,
    });
  });

  test("`Compacted ✓` at the 3 s boundary: 2999 ms still shown, 3000 ms gone", () => {
    // Mutation: `<=` instead of `<` → 3000 is still shown (one extra frame of the
    // celebration, and the elapsing timer's fire no longer removes it).
    const shown = (ago: number) => slotView(base({ compactedAt: NOW - ago }));
    expect(shown(COMPACTED_SHOWN_MS - 1)).toEqual({ kind: "compacted" });
    expect(shown(COMPACTED_SHOWN_MS)).toBe(null);
    expect(shown(COMPACTED_SHOWN_MS + 1)).toBe(null);
    expect(shown(0)).toEqual({ kind: "compacted" });
  });

  test("a compaction that runs again replaces a lingering `Compacted ✓`", () => {
    expect(slotView(base({ compactingSince: NOW - 1, compactedAt: NOW - 500 }))).toEqual({
      kind: "compacting",
      since: NOW - 1,
    });
  });
});
