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
  editingCleared,
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
  sendNowAccepted,
  take,
  unqueueFor,
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

describe("a row the daemon LISTED leaves when it stops listing it (docs/fix/mobile-queued-stuck.md)", () => {
  const ids = (state: ComposeState): readonly string[] => queueRows(state).map((r) => r.id);

  test("the device capture: a send-now's minted row, listed n=1, then n=0 → gone", () => {
    // capture-1: `act=send-now row=9cbd2fa8` (minted, no enqueue ack ever comes:
    // the send-now's promise is the whole new turn) → `queued n=1 id0=9cbd2fa8`
    // → turn-end → `queued n=0` → the phone still showed `rows n=1`.
    // Mutation: drop the listed ⇒ acked rule in `onQueued` → red.
    let state = enqueueStarted(initialCompose, "9cbd2fa8", "now please");
    state = onQueued(state, queue({ entries: [{ id: "9cbd2fa8", text: "now please" }] })).state;
    expect(ids(state)).toEqual(["9cbd2fa8"]);
    state = onQueued(state, queue()).state;
    expect(ids(state)).toEqual([]);
    expect(state.local).toEqual([]);
  });

  test("a plain steer consumed at the next step BEFORE its enqueue ack resolves → gone", () => {
    // The daemon can list and drain a steer before its `session/enqueue` answer
    // lands; the late ack then finds no row and changes nothing.
    let state = enqueueStarted(initialCompose, "e1", "steer");
    state = onQueued(state, queue({ entries: [{ id: "e1", text: "steer" }] })).state;
    state = onQueued(state, queue()).state;
    expect(ids(state)).toEqual([]);
    expect(ids(enqueueAcked(state, "e1"))).toEqual([]);
  });

  test("a row never listed and never acked stays: it is still in flight", () => {
    const state = onQueued(enqueueStarted(initialCompose, "e1", "steer"), queue()).state;
    expect(ids(state)).toEqual(["e1"]);
  });

  test("an in-flight row stays MINE across a report that does not list it yet", () => {
    // A `queued` broadcast between the mint and the daemon's enqueue (a drain, a
    // turn end, another device's enqueue) used to drop the id from `own` — the
    // row then showed as "from another device" for ever, even once listed, since
    // `mine` is `own.has(id)`. Feeds D2/D3: Send now and Edit/Cancel are hidden.
    // Mutation: drop the `inflight` clause of `onQueued`'s `keep` → red.
    let state = enqueueStarted(initialCompose, "e1", "my steer");
    state = onQueued(state, queue()).state;
    expect(queueRows(state).map((r) => `${r.id}:${r.mine}`)).toEqual(["e1:true"]);
    expect(state.own.get("e1")).toBe("my steer");
    // …and it is still mine once the daemon lists it.
    state = onQueued(state, queue({ entries: [{ id: "e1", text: "my steer" }] })).state;
    expect(queueRows(state).map((r) => `${r.id}:${r.mine}`)).toEqual(["e1:true"]);
  });

  test("send-now accepted with NO report ever listing its row → hidden at once, dropped next", () => {
    // The fallback when the daemon carried the text straight into the new turn.
    // Mutation: `sendNowAccepted` returns the state unchanged → red.
    let state = enqueueStarted(initialCompose, "s1", "now");
    state = onQueued(state, queue()).state;
    expect(ids(state)).toEqual(["s1"]);
    state = sendNowAccepted(state, ["s1"]);
    expect(ids(state)).toEqual([]);
    state = onQueued(state, queue()).state;
    expect(state.local).toEqual([]);
  });

  test("two queued (mine + another device's), send-now carries mine → only the other stays", () => {
    let state = enqueueAcked(enqueueStarted(initialCompose, "e1", "mine"), "e1");
    state = onQueued(
      state,
      queue({
        entries: [
          { id: "o1", text: "theirs" },
          { id: "e1", text: "mine" },
        ],
      }),
    ).state;
    state = enqueueStarted(state, "s1", "field");
    state = onQueued(
      state,
      queue({
        entries: [
          { id: "o1", text: "theirs" },
          { id: "e1", text: "mine" },
          { id: "s1", text: "field" },
        ],
      }),
    ).state;
    state = onQueued(state, queue({ entries: [{ id: "o1", text: "theirs" }] })).state;
    expect(queueRows(state).map((r) => `${r.id}:${r.mine}`)).toEqual(["o1:false"]);
  });

  test("cancel: the listed row comes back RETURNED → given back once, not left as a row", () => {
    let state = enqueueStarted(initialCompose, "e1", "my steer");
    state = onQueued(state, queue({ entries: [{ id: "e1", text: "my steer" }] })).state;
    const step = onQueued(state, queue({ returned: [returnedRow("e1")] }), { stoppedHere: true });
    expect(ids(step.state)).toEqual([]);
    expect(step.give).toBe("my steer");
    expect(step.reclaim).toEqual(["e1"]);
  });

  test("re-attach with the row STILL queued on the daemon → it stays", () => {
    let state = enqueueStarted(initialCompose, "e1", "my steer");
    state = onQueued(state, queue({ entries: [{ id: "e1", text: "my steer" }] })).state;
    // The link dropped; the re-attach's replay lists it again.
    state = onQueued(state, queue({ entries: [{ id: "e1", text: "my steer" }] })).state;
    expect(queueRows(state).map((r) => `${r.id}:${r.text}:${r.mine}`)).toEqual([
      "e1:my steer:true",
    ]);
  });

  test("re-attach AFTER it was consumed while away → the replay drops it", () => {
    let state = enqueueStarted(initialCompose, "e1", "my steer");
    state = onQueued(state, queue({ entries: [{ id: "e1", text: "my steer" }] })).state;
    state = onQueued(state, queue()).state; // the replay: drained meanwhile
    expect(ids(state)).toEqual([]);
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

describe("Edit and Cancel on a pending message (D6)", () => {
  /** My queued row, listed by the daemon (so `shownRows` shows it). */
  const queuedMine = (id = "e1", text = "my words"): ComposeState =>
    onQueued(enqueueStarted(withOwn([[id, text]]), id, text), queue({ entries: [{ id, text }] }))
      .state;

  test("Cancel removed: the row is gone at once, its id too, nothing to the field", () => {
    const before = queuedMine();
    expect(queueRows(before).map((r) => r.id)).toEqual(["e1"]);
    const step = unqueueFor(before, {
      what: "cancel",
      id: "e1",
      field: "typed",
      reply: { removed: ["e1"] },
    });
    // Mutation: keep the row (drop `dropPending`) → red: a cancelled message
    // would sit in the transcript until the daemon's next report.
    expect(queueRows(step.state)).toEqual([]);
    expect(step.state.own.has("e1")).toBe(false);
    expect(step.draft).toBe("typed");
    expect(step.notice).toBe("");
    expect(step.state.editing).toBeNull();
  });

  test("Cancel removed, of a row I minted that no report lists yet: it goes too", () => {
    // Mutation: filter the daemon's entries only → red (a local row would stay).
    const local = enqueueStarted(withOwn([["e9", "in flight"]]), "e9", "in flight");
    const step = unqueueFor(local, {
      what: "cancel",
      id: "e9",
      field: "",
      reply: { removed: ["e9"] },
    });
    expect(queueRows(step.state)).toEqual([]);
    expect(step.state.local).toEqual([]);
  });

  test("Cancel not removed: the row stays and the person is told the agent has it", () => {
    const before = queuedMine();
    const step = unqueueFor(before, {
      what: "cancel",
      id: "e1",
      field: "",
      reply: { removed: [] },
    });
    expect(step.state).toBe(before);
    expect(queueRows(step.state).map((r) => r.id)).toEqual(["e1"]);
    expect(step.notice).toContain("already read by the agent");
  });

  test("Edit removed: MY text into the field, the row gone, the edit banner remembers the field", () => {
    const before = queuedMine();
    const step = unqueueFor(before, {
      what: "edit",
      id: "e1",
      field: "",
      reply: { removed: ["e1"] },
    });
    expect(step.draft).toBe("my words");
    expect(queueRows(step.state)).toEqual([]);
    expect(step.state.editing).toEqual({ id: "e1", text: "my words", prior: "" });
    expect(step.notice).toBe("");
  });

  test("Edit never overwrites text typed since, and puts mine after it", () => {
    const step = unqueueFor(queuedMine(), {
      what: "edit",
      id: "e1",
      field: "typed meanwhile",
      reply: { removed: ["e1"] },
    });
    expect(step.draft).toBe("typed meanwhile\nmy words");
    expect(step.state.editing?.prior).toBe("typed meanwhile");
  });

  test("the field never holds a DAEMON-supplied text (a pod is not trusted)", () => {
    // The daemon lists the row with different words: the field must show what I
    // typed, from `own`. Mutation: read the entry's text → red.
    const state = onQueued(
      enqueueStarted(withOwn([["e1", "my words"]]), "e1", "my words"),
      queue({ entries: [{ id: "e1", text: "not what I typed" }] }),
    ).state;
    const step = unqueueFor(state, {
      what: "edit",
      id: "e1",
      field: "",
      reply: { removed: ["e1"] },
    });
    expect(step.draft).toBe("my words");
  });

  test("Edit not removed: the row stays and nothing goes into the field", () => {
    const step = unqueueFor(queuedMine(), {
      what: "edit",
      id: "e1",
      field: "typed",
      reply: { removed: [] },
    });
    expect(step.draft).toBe("typed");
    expect(step.state.editing).toBeNull();
    expect(step.notice).toContain("already read by the agent");
  });

  test("an older daemon: unsupported once, the row stays, Edit/Cancel are then hidden", () => {
    const before = queuedMine();
    expect(before.unqueueOff).toBe(false);
    const step = unqueueFor(before, {
      what: "edit",
      id: "e1",
      field: "",
      reply: "unsupported",
    });
    expect(step.state.unqueueOff).toBe(true);
    expect(queueRows(step.state).map((r) => r.id)).toEqual(["e1"]);
    expect(step.notice).not.toBe("");
    // Once is enough: a second answer does not change the flag again.
    const again = unqueueFor(step.state, {
      what: "cancel",
      id: "e1",
      field: "",
      reply: "unsupported",
    });
    expect(again.state.unqueueOff).toBe(true);
  });

  test("a dropped answer: a notice and the row kept — never a half-done cancel", () => {
    const before = queuedMine();
    const step = unqueueFor(before, {
      what: "cancel",
      id: "e1",
      field: "",
      reply: "failed",
    });
    expect(step.state).toBe(before);
    expect(queueRows(step.state).map((r) => r.id)).toEqual(["e1"]);
    expect(step.notice).not.toBe("");
  });

  test("the edit ends (× or ↑): the banner goes, the edit's own words are what returns", () => {
    const edited = unqueueFor(queuedMine(), {
      what: "edit",
      id: "e1",
      field: "",
      reply: { removed: ["e1"] },
    }).state;
    const ended = editingCleared(edited);
    // Mutation: keep `editing` → red (the banner would stay over an empty edit).
    expect(ended.editing).toBeNull();
    expect(ended.unqueueOff).toBe(false);
  });
});
