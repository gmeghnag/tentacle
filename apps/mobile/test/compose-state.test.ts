/**
 * The compose half's state machine (docs/feat/mobile-compose.md 13d): my queue
 * rows, the hand-back that gives my returned rows back ONCE (also across an app
 * kill), and another device's rows with their explicit Take.
 *
 * Every decision is 13a's (`compose-queue.ts`); this file only threads the state
 * through it, so these tests read as the plan's failure modes.
 */
import { describe, expect, test } from "bun:test";
import type { QueueState, ReturnCause } from "@tentacle/protocol";
import {
  type ComposeState,
  enqueueAcked,
  enqueueRejected,
  enqueueStarted,
  initialCompose,
  noticeCleared,
  onQueued,
  othersReturned,
  ownFrom,
  ownIdList,
  queueRows,
  reclaimed,
  take,
} from "../src/compose-state.ts";

const queue = (over: Partial<QueueState> = {}): QueueState => ({
  entries: [],
  returned: [],
  ...over,
});

const returnedRow = (id: string, text = "", cause: ReturnCause = "cancelled") => ({
  id,
  text,
  cause,
});

const withOwn = (pairs: readonly (readonly [string, string])[]): ComposeState => ({
  ...initialCompose,
  own: new Map(pairs),
});

describe("rows above the input (D2)", () => {
  test("my local row shows before the daemon lists it, and it is MINE", () => {
    // Mutation: `enqueueStarted` adds the row without adding it to `own` → it
    // shows as "from another device" (13a's review nit) → red.
    const state = enqueueStarted(initialCompose, "e1", "my steer");
    expect(queueRows(state).map((r) => `${r.id}:${r.mine}`)).toEqual(["e1:true"]);
    expect(state.own.get("e1")).toBe("my steer");
  });

  test("the daemon's list wins once it arrives, and my row keeps my text", () => {
    const state = enqueueAcked(enqueueStarted(initialCompose, "e1", "my steer"), "e1");
    const step = onQueued(state, queue({ entries: [{ id: "e1", text: "my steer" }] }));
    expect(queueRows(step.state).map((r) => r.id)).toEqual(["e1"]);
    expect(queueRows(step.state)[0]?.mine).toBe(true);
  });

  test("a delivered row leaves the list (it is in the transcript as the steer)", () => {
    const state = enqueueAcked(enqueueStarted(initialCompose, "e1", "my steer"), "e1");
    const step = onQueued(state, queue({ entries: [] }));
    expect(queueRows(step.state)).toEqual([]);
    // Its own id goes too: the daemon no longer lists it anywhere (D4's bound).
    expect(step.state.own.has("e1")).toBe(false);
  });

  test("a refused enqueue drops its row and says so, unless a send-now owns it", () => {
    const state = enqueueStarted(initialCompose, "e1", "text");
    const refused = enqueueRejected(state, "e1", new Set());
    expect(refused.notify).toBe(true);
    expect(queueRows(refused.state)).toEqual([]);
    expect(refused.state.own.has("e1")).toBe(false);
    const owned = enqueueRejected(state, "e1", new Set(["e1"]));
    expect(owned.notify).toBe(false);
    expect(owned.state.own.get("e1")).toBe("text"); // the send-now carries it
  });
});

describe("my returned rows come back once (D3, F10)", () => {
  test("a returned row of mine is given back with MY text and reclaimed", () => {
    const state = withOwn([["e1", "my queued words"]]);
    const step = onQueued(state, queue({ returned: [returnedRow("e1")] }));
    // The daemon's text is untrusted (a pod chooses it): mine is what lands.
    expect(step.give).toBe("my queued words");
    expect(step.reclaim).toEqual(["e1"]);
    expect(step.notice).toContain("back");
  });

  test("the SAME row at the next state is not given back a second time", () => {
    // Mutation: keep the id in `own` after giving it back → red (twice).
    const state = withOwn([["e1", "words"]]);
    const first = onQueued(state, queue({ returned: [returnedRow("e1")] }));
    expect(first.reclaim).toEqual(["e1"]); // its reclaim is in flight
    const second = onQueued(first.state, queue({ returned: [returnedRow("e1")] }));
    expect(second.give).toBe("");
    // In flight still: nothing is re-sent before it settles (`reclaiming`).
    expect(second.reclaim).toEqual([]);
    // Once it settled, the next state reclaims again — never a second hand-back.
    const settled = reclaimed(second.state, ["e1"]);
    const third = onQueued(settled, queue({ returned: [returnedRow("e1")] }));
    expect(third.give).toBe("");
    expect(third.reclaim).toEqual(["e1"]);
  });

  test("AFTER AN APP KILL the row is not given back again (the id left the persisted set)", () => {
    // This is F10's "once" across a kill. `own` is what the store wrote; a
    // relaunched app reads it and sees no `e1`, so the row is not mine any more.
    const state = withOwn([["e1", "words"]]);
    const step = onQueued(state, queue({ returned: [returnedRow("e1")] }));
    const persisted = ownIdList(step.state); // what `setOwnIds` writes
    expect(persisted).toEqual([]);
    // Relaunch: the store's ids, and the daemon's state again.
    const relaunched: ComposeState = { ...initialCompose, own: ownFrom(persisted, new Map()) };
    const again = onQueued(relaunched, queue({ returned: [returnedRow("e1")] }));
    expect(again.give).toBe("");
    // Its text is the DRAFT's job now (it was put in the field and saved), and
    // the row stays visible as another device's, with its Take.
    expect(othersReturned(again.state).map((r) => r.id)).toEqual(["e1"]);
  });

  test("a reclaim already in flight is not re-sent", () => {
    const state = withOwn([["e1", "words"]]);
    const first = onQueued(state, queue({ returned: [returnedRow("e1")] }));
    const second = onQueued(first.state, queue({ returned: [returnedRow("e1")] }));
    expect(second.reclaim).toEqual([]);
    // Once it settles, the next state reclaims again (a failed reclaim retries).
    const settled = reclaimed(second.state, ["e1"]);
    const third = onQueued(settled, queue({ returned: [returnedRow("e1")] }));
    expect(third.reclaim).toEqual(["e1"]);
  });

  test("a row I never sent is never given back (only an explicit Take)", () => {
    const step = onQueued(initialCompose, queue({ returned: [returnedRow("theirs")] }));
    expect(step.give).toBe("");
    expect(step.reclaim).toEqual([]);
  });

  test("the banner names who stopped the turn (this phone or another device)", () => {
    const state = withOwn([["e1", "words"]]);
    const mine = onQueued(state, queue({ returned: [returnedRow("e1")] }), { stoppedHere: true });
    expect(mine.notice).toContain("Your queued message");
    expect(mine.notice).not.toContain("another device");
    const theirs = onQueued(state, queue({ returned: [returnedRow("e1")] }));
    expect(theirs.notice).toContain("another device");
  });

  test("the banner STAYS through the reclaim's own echo, and an act clears it", () => {
    // The reclaim sends a new queue state a moment later: clearing the banner there
    // hid it a second after it appeared (13d's flow 14 saw no `returned-banner`).
    // Mutation: clear on an empty step → red.
    const state = withOwn([["e1", "words"]]);
    const given = onQueued(state, queue({ returned: [returnedRow("e1")] }));
    expect(given.state.notice).not.toBe("");
    // The echo (nothing returned this time) keeps it.
    const echo = onQueued(given.state, queue());
    expect(echo.state.notice).toBe(given.state.notice);
    expect(echo.notice).toBe("");
    // The person acts (a send, a queue, a Take): now it goes.
    expect(noticeCleared(echo.state).notice).toBe("");
    expect(enqueueStarted(echo.state, "e2", "next").notice).toBe("");
  });
});

describe("another device's returned rows (F11, QR2)", () => {
  test("listed, never claimed by themselves", () => {
    const state = withOwn([["mine", "x"]]);
    const step = onQueued(
      state,
      queue({ returned: [returnedRow("theirs", "their words"), returnedRow("mine", "ignored")] }),
    );
    expect(othersReturned(step.state).map((r) => r.id)).toEqual(["theirs"]);
    expect(step.give).toBe("x"); // only MINE came back
  });

  test("Take puts their text in the field and reclaims it — one tap, one act", () => {
    const state = onQueued(
      initialCompose,
      queue({ returned: [returnedRow("theirs", "their words")] }),
    ).state;
    const taken = take(state, "theirs");
    expect(taken.text).toBe("their words");
    expect(taken.reclaim).toEqual(["theirs"]);
    expect(taken.state.reclaiming.has("theirs")).toBe(true);
  });

  test("Take on a row of mine, or on an id nobody lists, is a no-op", () => {
    const state = onQueued(
      withOwn([["mine", "x"]]),
      queue({ returned: [returnedRow("mine", "theirs?")] }),
    ).state;
    expect(take(state, "mine")).toMatchObject({ text: "", reclaim: [] });
    expect(take(state, "unknown")).toMatchObject({ text: "", reclaim: [] });
  });
});
