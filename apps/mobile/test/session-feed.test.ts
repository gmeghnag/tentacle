/**
 * The screen's data feed (docs/feat/mobile-session-view.md 12c): the turn
 * bracket's outcome is decided HERE, once — the plan's F8/F9/F10/F19 hinge on
 * an "interrupted" turn being told apart from an ended, cancelled or lost one,
 * and on this phone's own turn folding exactly like another device's.
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import type { ChatMessage } from "@tentacle/core";
import { type ForeignTurn, createSessionFeed, turnOutcome } from "../src/session-feed.ts";
import { type State, initialState } from "../src/transcript.ts";

/** A feed over a mutable state, with a way to await the streams it started. */
function harness() {
  let state: State = initialState;
  let foreign: ForeignTurn | null = null;
  const feed = createSessionFeed({
    state: () => state,
    put: (next) => {
      state = next;
    },
    setForeign: (turn) => {
      foreign = turn;
    },
  });
  return {
    feed,
    states: () => state,
    foreign: () => foreign,
    /** An activity, with the stream it starts awaited (it runs to completion). */
    async activity(a: SessionActivity): Promise<void> {
      feed.activity(a);
      await settle();
    },
    own: (turnId: string, events: readonly SessionEvent[]): Promise<void> =>
      feed.ownTurn(turnId, gen(events)),
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

async function* gen(events: readonly SessionEvent[]): AsyncIterable<SessionEvent> {
  for (const event of events) {
    yield event;
  }
}

const HISTORY: readonly ChatMessage[] = [
  { role: "user", content: "Alpha" },
  { role: "assistant", content: "Hello from the mock model." },
];

function turnActivity(turnId: string, events: readonly SessionEvent[]): SessionActivity {
  return {
    kind: "turn",
    turnId,
    events: gen(events),
    cancel: () => {},
  };
}

describe("turnOutcome (the whole table)", () => {
  test("a stated end: cancelled → cancelled, anything else → ended", () => {
    expect(turnOutcome({ ended: true, reason: "end_turn" })).toBe("ended");
    expect(turnOutcome({ ended: true, reason: "max_iterations" })).toBe("ended");
    expect(turnOutcome({ ended: true, reason: "cancelled" })).toBe("cancelled");
  });

  test("a stream that closed with no end event → interrupted (never a silent stop)", () => {
    expect(turnOutcome({ ended: false })).toBe("interrupted");
    expect(turnOutcome({ ended: false, reason: "end_turn" })).toBe("interrupted");
  });

  test("a stream that threw → lost (even over a stated end that never arrived)", () => {
    expect(turnOutcome({ ended: false, threw: true })).toBe("lost");
    expect(turnOutcome({ ended: true, reason: "end_turn", threw: true })).toBe("lost");
  });
});

describe("createSessionFeed", () => {
  test("a history activity replaces the transcript (a fresh attach)", async () => {
    const h = harness();
    await h.activity({ kind: "history", messages: HISTORY, reason: null });
    expect(h.states().rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
  });

  test("a FOREIGN turn opens a bracket, folds its events, and closes as ended", async () => {
    const h = harness();
    await h.activity(
      turnActivity("t-foreign", [
        { type: "user_message", text: "do it" },
        { type: "text", delta: "done" },
        { type: "turn_end", reason: "end_turn" },
      ]),
    );
    expect(h.states().turn).toBeNull(); // the bracket closed
    expect(h.states().rows.map((r) => r.kind)).toEqual(["user", "assistant"]);
    expect(h.foreign()).toBeNull(); // nothing left to Stop
  });

  test("an OWN turn produces the SAME rows as a foreign one (F10: one fold)", async () => {
    const events: readonly SessionEvent[] = [
      { type: "user_message", text: "same prompt" },
      { type: "text", delta: "same answer" },
      { type: "turn_end", reason: "end_turn" },
    ];
    const foreign = harness();
    await foreign.activity(turnActivity("t1", events));
    const own = harness();
    await own.own("t1", events);
    expect(own.states().rows).toEqual(foreign.states().rows);
    expect(own.states().turn).toBeNull();
  });

  test("a foreign turn's cancel is handed out for Stop, and cleared once it ends (decision 15)", async () => {
    const h = harness();
    const events: readonly SessionEvent[] = [{ type: "text", delta: "streaming" }];
    h.feed.activity(turnActivity("t-foreign", events));
    expect(h.foreign()?.turnId).toBe("t-foreign");
    await settle();
    // Its stream closed with no turn_end: the bracket says interrupted (F19's cousin).
    expect(h.foreign()).toBeNull();
    expect(h.states().rows.some((r) => r.kind === "notice")).toBe(true);
    expect(h.states().turn).toBeNull();
  });

  test("a cancelled turn's end is CANCELLED, with no interrupted notice on top", async () => {
    const h = harness();
    await h.activity(
      turnActivity("t1", [
        { type: "user_message", text: "HOLD" },
        { type: "turn_end", reason: "cancelled" },
      ]),
    );
    // `endTurn` says nothing for cancelled/ended: the transcript speaks for itself.
    expect(h.states().rows.map((r) => r.kind)).toEqual(["user"]);
  });

  test("a stream that throws is LOST, and says so once", async () => {
    const h = harness();
    const broken: AsyncIterable<SessionEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("the link died")),
      }),
    };
    h.feed.activity({ kind: "turn", turnId: "t1", events: broken, cancel: () => {} });
    await settle();
    const notices = h.states().rows.filter((r) => r.kind === "notice");
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ kind: "notice" });
    expect((notices[0] as { text: string }).text).toContain("lost");
    expect(h.foreign()).toBeNull();
  });

  test("an OWN stream that throws folds LOST and REJECTS with its error", async () => {
    // The caller owns this turn: a refusal before the ack (`TurnInProgress`) must
    // reach it, so the person's text can come back (12c F13 / 13d F7). Swallowing
    // it here is what made a refused send vanish (review round 1, finding 1).
    // Mutation: `return` instead of `throw` in `foldStream`'s catch → red.
    const h = harness();
    const refusal = new Error("turn in progress");
    const broken: AsyncIterable<SessionEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(refusal) }),
    };
    await expect(h.feed.ownTurn("t1", broken)).rejects.toBe(refusal);
    // The transcript still says LOST (the fold happened before the rejection).
    expect(h.states().rows.some((r) => r.kind === "notice")).toBe(true);
  });

  test("closed folds the end and clears the stoppable turn (F14)", async () => {
    const h = harness();
    h.feed.activity(turnActivity("t1", [{ type: "text", delta: "x" }]));
    expect(h.foreign()).not.toBeNull();
    await h.activity({ kind: "closed", reason: "deleted" });
    expect(h.states().closed).toBe("deleted");
    expect(h.foreign()).toBeNull();
  });

  test("the link status folds into the transcript state (F8's banner input)", async () => {
    const h = harness();
    h.feed.link(false);
    expect(h.states().link).toBe("down");
    h.feed.link(true);
    expect(h.states().link).toBe("up");
  });
});
