/**
 * The header's live context bar (docs/feat/mobile-session-info.md, Owner decision
 * 4): a thin bar under the title, from `agent_usage` — the figure the TUI's own
 * status bar shows, by the same rule (`packages/tui/src/status-view.ts`'s
 * `contextShown`): a MEASURED turn wins and is exact, else the daemon's count at
 * open (`session/context`), an estimate marked `≈`.
 *
 * It lives in the transcript fold's state so the rule has ONE home (AGENTS §7) and
 * a replaced history forgets the figure that described the chat it dropped.
 */
import { describe, expect, test } from "bun:test";
import { headerContext } from "../src/session-info.ts";
import { type State, apply, initialState } from "../src/transcript.ts";

const usage = (promptTokens: number, completionTokens = 10) => ({
  type: "agent_usage" as never,
  usage: { promptTokens, completionTokens },
});

/** Fold one `usage` event (what the client raises from `agent_usage`). */
function measured(prompt: number): State {
  return apply(initialState, {
    type: "usage",
    usage: { promptTokens: prompt, completionTokens: 5 },
  } as never);
}

describe("the fold keeps the last measured fill", () => {
  test("a turn's usage sets `lastTurnTokens.prompt` and accumulates session totals", () => {
    const once = measured(84_000);
    expect(once.lastTurnTokens?.prompt).toBe(84_000);
    expect(once.sessionTokens.prompt).toBe(84_000);
    const twice = apply(once, {
      type: "usage",
      usage: { promptTokens: 90_000, completionTokens: 5 },
    } as never);
    // The FILL is the last turn's prompt, the TOTALS accumulate.
    expect(twice.lastTurnTokens?.prompt).toBe(90_000);
    expect(twice.sessionTokens.prompt).toBe(174_000);
  });

  test("a replaced history forgets the fill (it described the chat it dropped)", () => {
    const before = measured(84_000);
    const after = apply(before, { type: "history_reset", messages: [] });
    expect(after.lastTurnTokens).toBeNull();
    // The SESSION totals are the session's, not this history's: they stay.
    expect(after.sessionTokens.prompt).toBe(84_000);
  });

  test("a resync (a fresh attach / another device's clear) forgets it too", () => {
    const before = measured(84_000);
    const after = apply(before, { type: "history", messages: [], reason: null });
    expect(after.lastTurnTokens).toBeNull();
  });

  test("a context reset mid-turn KEEPS it (the conversation continues)", () => {
    const before = measured(84_000);
    const after = apply(before, { type: "history", messages: [], reason: "context_reset" });
    expect(after.lastTurnTokens?.prompt).toBe(84_000);
  });
});

describe("headerContext (the bar's value)", () => {
  test("a measured turn wins and is exact, whatever the daemon estimated", () => {
    const bar = headerContext({
      measured: 84_000,
      open: { used: 80_000, exact: false },
      window: 200_000,
    });
    expect(bar.percent).toBe(42);
    expect(bar.approx).toBe(false);
  });

  test("before any turn measured, the daemon's count at open shows, `≈` when estimated", () => {
    const bar = headerContext({
      measured: null,
      open: { used: 100_000, exact: false },
      window: 200_000,
    });
    expect(bar.percent).toBe(50);
    expect(bar.approx).toBe(true);
  });

  test("nothing measured and no count yet → NO bar (never a fake 0)", () => {
    expect(headerContext({ measured: null, open: null, window: 200_000 })).toEqual({
      percent: null,
      approx: false,
    });
  });

  test("no window known → no bar (percent needs one)", () => {
    expect(headerContext({ measured: 84_000, open: null, window: undefined }).percent).toBeNull();
  });

  test("the bar is clamped at 100 %", () => {
    expect(headerContext({ measured: 400_000, open: null, window: 200_000 }).percent).toBe(100);
  });

  test("the measured fill is a real signal, so `usage` is no longer a silent drop", () => {
    // The fold's default branch used to swallow it (\"the phone has no meter\").
    expect(measured(1_000)).not.toBe(initialState);
    void usage;
  });
});
