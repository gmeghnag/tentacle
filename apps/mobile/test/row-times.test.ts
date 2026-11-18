/**
 * A row's arrival time (docs/fix/mobile-open-at-end.md, slice B): the phone
 * shows it on a swipe, so every user/assistant/tool row must know WHEN it
 * arrived — from the daemon's `SnapshotResult.times` for history, from the
 * feed's injected clock for a row CREATED live.
 *
 * Mutations that must turn these red: `times[i] > 0` → `!== undefined` (a `0`
 * becomes a 1970 label); take the tool RESULT's time instead of its call's;
 * restamp a row on upsert (every delta would move its time); stamp a notice or
 * a reasoning row; stamp in `historyRows` from the clock instead of `times`.
 */
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@tentacle/client";
import type { ChatMessage } from "@tentacle/core";
import { createSessionFeed } from "../src/session-feed.ts";
import { historyRows } from "../src/transcript-history.ts";
import { type Row, type ToolRow, type UserRow, apply, initialState } from "../src/transcript.ts";

const kinds = (rows: readonly Row[]) => rows.map((row) => row.kind);
/** The row's time, when the row type carries one at all. */
const ats = (rows: readonly Row[]) =>
  rows.map((row) =>
    row.kind === "user" || row.kind === "assistant" || row.kind === "tool" ? row.at : undefined,
  );
function keyer(): () => string {
  let n = 0;
  return () => `k${++n}`;
}

describe("historyRows takes the daemon's times, index-aligned", () => {
  const history: readonly ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: "calling",
      toolCalls: [{ id: "c1", name: "fs_read", arguments: "{}" }],
    },
    { role: "tool", toolCallId: "c1", content: "output" },
    { role: "assistant", content: "done" },
  ];

  test("user and assistant rows carry theirs; the tool row keeps its CALL's, not its result's", () => {
    // Index 0 is the system message (no row): the pairing is by MESSAGE index.
    const rows = historyRows(history, keyer(), [11, 22, 33, 44, 55]);
    expect(kinds(rows)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(ats(rows)).toEqual([22, 33, 33, 55]);
    const tool = rows[2] as ToolRow;
    expect(tool.output).toBe("output");
    expect(tool.at).toBe(33);
  });

  test("a 0 time is UNKNOWN: no time at all, never a 1970 label", () => {
    expect(ats(historyRows(history, keyer(), [0, 0, 0, 0, 0]))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("no `times` at all (an older daemon): no row carries one", () => {
    expect(ats(historyRows(history, keyer()))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  test("a notice drawn from a note message carries none", () => {
    const noted: readonly ChatMessage[] = [
      { role: "user", content: "a job exited", note: { kind: "job_exit" } },
    ];
    const rows = historyRows(noted, keyer(), [77]);
    expect(rows[0]?.kind).toBe("notice");
    expect(rows[0] !== undefined && "at" in rows[0]).toBe(false);
  });

  test("the restart prompt after a context reset keeps the reset message's time", () => {
    const reset: readonly ChatMessage[] = [
      {
        role: "user",
        content:
          "[context reset] You renewed your own context with context_reset.\nEverything before it was discarded. Your restart prompt:\n<restart_prompt>\ncarry on\n</restart_prompt>",
      },
    ];
    const rows = historyRows(reset, keyer(), [99]);
    // The separator is a notice (no time); the restart prompt is a user row.
    expect(kinds(rows)).toEqual(["notice", "user"]);
    expect(ats(rows)).toEqual([undefined, 99]);
  });
});

describe("the fold pairs a history's times with its rows", () => {
  test("a `history` with times: every labeled row carries one", () => {
    const state = apply(initialState, {
      type: "history",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
      times: [1_700_000_000_000, 0],
      reason: null,
    });
    expect(ats(state.rows)).toEqual([1_700_000_000_000, undefined]);
    // A `0` is never STORED: the row has no `at` key at all, not `at: undefined`.
    expect(state.rows[1] !== undefined && "at" in state.rows[1]).toBe(false);
  });

  test("a mid-turn `history_reset` with times: same pairing", () => {
    const state = apply(initialState, {
      type: "history_reset",
      messages: [{ role: "user", content: "q" }],
      times: [1_700_000_001_000],
    });
    expect(ats(state.rows)).toEqual([1_700_000_001_000]);
  });

  test("a context reset APPENDS: its own messages pair with its own times", () => {
    const first = apply(initialState, {
      type: "history",
      messages: [{ role: "user", content: "old" }],
      times: [10],
      reason: null,
    });
    const after = apply(first, {
      type: "history",
      messages: [{ role: "user", content: "new" }],
      times: [20],
      reason: "context_reset",
    });
    expect(ats(after.rows)).toEqual([10, 20]);
  });

  test("a re-logged history with no times (a reload): no row carries one, even with a clock wired", () => {
    const state = apply(
      initialState,
      { type: "context_reset", messages: [{ role: "user", content: "relogged" }] },
      5_000,
    );
    expect(ats(state.rows)).toEqual([undefined]);
  });
});

describe("the feed's injected clock stamps the rows it CREATES, once", () => {
  function harness(clock: { now: number }) {
    let state = initialState;
    const feed = createSessionFeed({
      state: () => state,
      put: (next) => {
        state = next;
      },
      setForeign: () => {},
      now: () => clock.now,
    });
    return { feed, state: () => state };
  }

  const stream = (events: readonly SessionEvent[]): AsyncIterable<SessionEvent> =>
    (async function* () {
      for (const event of events) {
        yield event;
      }
    })();

  test("one assistant row from two deltas: the time of its CREATION, not of the last delta", async () => {
    const clock = { now: 1_000 };
    const h = harness(clock);
    await h.feed.ownTurn(
      "t1",
      (async function* () {
        yield { type: "text", delta: "a" } as SessionEvent;
        clock.now = 2_000;
        yield { type: "text", delta: "b" } as SessionEvent;
      })(),
    );
    const row = h.state().rows[0];
    expect(row?.kind === "assistant" && row.text).toBe("ab");
    expect(row?.kind === "assistant" && row.at).toBe(1_000);
  });

  test("the phone's own prompt is stamped at its ack, and a tool row at its call", async () => {
    const clock = { now: 7_000 };
    const h = harness(clock);
    await h.feed.ownTurn(
      "t1",
      (async function* () {
        yield { type: "tool_start", id: "c1", name: "fs_read", arguments: "{}" } as SessionEvent;
        clock.now = 8_000;
        yield {
          type: "tool_result",
          id: "c1",
          name: "fs_read",
          result: { content: "out" },
        } as unknown as SessionEvent;
      })(),
      { text: "hello" },
    );
    const [user, tool] = h.state().rows as [UserRow, ToolRow];
    expect(user.kind).toBe("user");
    expect(user.at).toBe(7_000);
    expect(tool.kind).toBe("tool");
    expect(tool.at).toBe(7_000); // its CALL's, not its result's
  });

  test("a history activity's times reach the rows (a resync REPLACES live stamps)", () => {
    const h = harness({ now: 9_000 });
    h.feed.activity({
      kind: "history",
      messages: [{ role: "user", content: "old" }],
      times: [4_000],
      reason: null,
    });
    const row = h.state().rows[0];
    expect(row?.kind === "user" && row.at).toBe(4_000);
  });

  test("no clock wired (a unit fold): no time is invented", async () => {
    let state = initialState;
    const feed = createSessionFeed({
      state: () => state,
      put: (next) => {
        state = next;
      },
      setForeign: () => {},
    });
    await feed.ownTurn("t1", stream([{ type: "text", delta: "x" } as SessionEvent]));
    const row = state.rows[0];
    expect(row?.kind === "assistant" && row.at).toBeUndefined();
  });
});
