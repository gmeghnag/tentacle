/**
 * The screen's data feed (docs/feat/mobile-session-view.md 12c): the turn
 * bracket's outcome is decided HERE, once — the plan's F8/F9/F10/F19 hinge on
 * an "interrupted" turn being told apart from an ended, cancelled or lost one,
 * and on this phone's own turn folding exactly like another device's.
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import type { ChatMessage } from "@tentacle/core";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import type { QueueTraceEvent } from "../src/queue-trace.ts";
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

describe("the LOST cause reaches the app log (docs/fix/mobile-stream-lost-repeat.md, slice 2)", () => {
  /** A feed whose trace lines are collected, so the `turn-end` line can be read. */
  function traced() {
    let state: State = initialState;
    const lines: QueueTraceEvent[] = [];
    const feed = createSessionFeed({
      state: () => state,
      put: (next) => {
        state = next;
      },
      setForeign: () => {},
      trace: (event) => lines.push(event),
    });
    return { feed, lines, end: () => lines.filter((line) => line.kind === "turn-end") };
  }

  /** A stream that yields `events`, then throws `error`. */
  async function* throwing(
    events: readonly SessionEvent[],
    error: unknown,
  ): AsyncIterable<SessionEvent> {
    for (const event of events) {
      yield event;
    }
    throw error;
  }

  test("a stream that throws an RpcError → the turn-end line names its CLASS and CODE, never its message", async () => {
    // The app log is a file a person shares (app-log F16): the class and the
    // numeric code are ours and safe, the message is daemon text and must not
    // reach the ring. This line is the whole point of slice 2 — the next
    // occurrence on a device names the trigger that made the stream throw.
    // Mutation: pass the raw `error` through, or log `error.message` → red.
    const t = traced();
    const failure = new RpcError(DomainErrorCode.UnknownSession, "the daemon lost the session");
    t.feed.activity({
      kind: "turn",
      turnId: "t1",
      events: throwing([{ type: "text", delta: "half" }], failure),
      cancel: () => {},
    });
    await settle();
    const [end] = t.end();
    expect(end?.kind === "turn-end" ? end.outcome : undefined).toBe("lost");
    expect(end?.kind === "turn-end" ? end.cause : undefined).toEqual({
      error: "RpcError",
      code: DomainErrorCode.UnknownSession,
    });
    // Non-vacuity: the message really was available to the call site.
    expect(failure.message).toContain("lost the session");
  });

  test("a plain Error carries its class and no code (there is none to name)", async () => {
    const t = traced();
    t.feed.activity({
      kind: "turn",
      turnId: "t1",
      events: throwing([], new TypeError("malformed text update from the daemon")),
      cancel: () => {},
    });
    await settle();
    const [end] = t.end();
    expect(end?.kind === "turn-end" ? end.cause : undefined).toEqual({ error: "TypeError" });
  });

  test("a clean end carries NO cause (nothing threw)", async () => {
    const t = traced();
    t.feed.activity(
      turnActivity("t1", [
        { type: "text", delta: "done" },
        { type: "turn_end", reason: "end_turn" },
      ]),
    );
    await settle();
    const [end] = t.end();
    expect(end?.kind === "turn-end" ? end.outcome : undefined).toBe("ended");
    expect(end?.kind === "turn-end" ? end.cause : undefined).toBeUndefined();
  });
});

describe("owner B4: this phone's OWN prompt is a user row", () => {
  // The real client never re-delivers the sender's own prompt (`remote-session.ts`:
  // "Our own prompt is already on screen"), so the feed shows it — at the FIRST
  // event, i.e. once the daemon took the prompt: a refusal before the ack gives
  // the words back to the field and must leave no row behind.
  const userTexts = (state: State): readonly string[] =>
    state.rows.flatMap((r) => (r.kind === "user" ? [(r as { text: string }).text] : []));

  test("an own turn that streams shows the prompt as a user row, before the answer", async () => {
    const h = harness();
    await h.feed.ownTurn(
      "t1",
      gen([
        { type: "text", delta: "hi back" },
        { type: "turn_end", reason: "end_turn" },
      ] as SessionEvent[]),
      { text: "hello from the phone" },
    );
    expect(userTexts(h.states())).toEqual(["hello from the phone"]);
    expect(h.states().rows[0]?.kind).toBe("user");
  });

  test("a refusal before any event leaves NO user row (the words go back to the field)", async () => {
    const h = harness();
    const refusal = new Error("turn in progress");
    const broken: AsyncIterable<SessionEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(refusal) }),
    };
    await expect(h.feed.ownTurn("t1", broken, { text: "hello" })).rejects.toBe(refusal);
    expect(userTexts(h.states())).toEqual([]);
  });

  test("a stream that re-delivers the prompt itself is not doubled", async () => {
    const h = harness();
    await h.feed.ownTurn(
      "t1",
      gen([
        { type: "user_message", text: "same" },
        { type: "turn_end", reason: "end_turn" },
      ] as SessionEvent[]),
      { text: "same" },
    );
    expect(userTexts(h.states())).toEqual(["same"]);
  });

  test("an image-only prompt still shows its row (the refs say what was asked)", async () => {
    const h = harness();
    await h.feed.ownTurn("t1", gen([{ type: "turn_end", reason: "end_turn" }] as SessionEvent[]), {
      text: "",
      attachments: [{ id: "b", mimeType: "image/png", size: 3 }],
    });
    expect(h.states().rows.filter((r) => r.kind === "user")).toHaveLength(1);
  });

  /**
   * Item 2 (fix/mobile-media-live): the bubble for a photo the phone JUST sent
   * shows that photo. The daemon has no read-back method
   * (`thumbnails.ts:19-25`), so an image's bytes cannot be fetched; the ONE
   * copy the phone has is the local one it uploaded. It rides the send path as
   * `OwnPrompt.photos` (ref id → local file URI) and lands on the row.
   *
   * Mutation: drop the mapping → the row keeps only the id and the bubble shows
   * the placeholder for a photo the person is looking at.
   */
  test("the sent photo's row carries its LOCAL copy (item 2: the bubble shows what was sent)", async () => {
    const h = harness();
    await h.feed.ownTurn("t1", gen([{ type: "turn_end", reason: "end_turn" }] as SessionEvent[]), {
      text: "Cosa vedi?",
      attachments: [{ id: "blob-1", mimeType: "image/jpeg", size: 3, name: "IMG_4876.jpg" }],
      photos: [{ id: "blob-1", uri: "file:///photos/1-1-IMG_4876.jpg", width: 2048, height: 1536 }],
    });
    const user = h.states().rows.find((r) => r.kind === "user");
    if (user?.kind !== "user") {
      throw new Error("no user row");
    }
    // The ref's own fields are unchanged (the wire's `ImageRef`)…
    expect(user.images[0]).toMatchObject({ id: "blob-1", mimeType: "image/jpeg" });
    // …and the local copy rides along, so the bubble can draw the photo.
    expect(user.images[0]?.localUri).toBe("file:///photos/1-1-IMG_4876.jpg");
    expect(user.images[0]?.aspectRatio).toBeCloseTo(4 / 3);
  });

  test("a ref with no local copy (a replay, another device's message) keeps today's placeholder", async () => {
    const h = harness();
    await h.feed.ownTurn("t1", gen([{ type: "turn_end", reason: "end_turn" }] as SessionEvent[]), {
      text: "from the TUI",
      attachments: [{ id: "blob-2", mimeType: "image/png", size: 3 }],
    });
    const user = h.states().rows.find((r) => r.kind === "user");
    if (user?.kind !== "user") {
      throw new Error("no user row");
    }
    expect(user.images[0]?.localUri).toBeUndefined();
  });
});

describe("the own prompt is drawn at the daemon's ACK (docs/fix/mobile-chat-glitches.md, bug 2)", () => {
  const userTexts = (state: State): readonly string[] =>
    state.rows.flatMap((r) => (r.kind === "user" ? [(r as { text: string }).text] : []));

  /** A stream that yields nothing until `release`, then `events`. */
  function held(events: readonly SessionEvent[]) {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    async function* stream(): AsyncIterable<SessionEvent> {
      await gate;
      yield* events;
    }
    return { stream: stream(), release };
  }

  test("accepted while the stream has yielded nothing → the user row is already there", async () => {
    const h = harness();
    const s = held([{ type: "turn_end", reason: "end_turn" }] as SessionEvent[]);
    const done = h.feed.ownTurn("t1", s.stream, { text: "Scrivi qualcosa" }, Promise.resolve());
    await settle();
    expect(userTexts(h.states())).toEqual(["Scrivi qualcosa"]);
    s.release();
    await done;
    expect(userTexts(h.states())).toEqual(["Scrivi qualcosa"]);
  });

  test("no acceptance, then a refusal → no user row", async () => {
    const h = harness();
    const refusal = new Error("turn in progress");
    const broken: AsyncIterable<SessionEvent> = {
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(refusal) }),
    };
    const never = new Promise<void>(() => {});
    await expect(h.feed.ownTurn("t1", broken, { text: "hello" }, never)).rejects.toBe(refusal);
    await settle();
    expect(userTexts(h.states())).toEqual([]);
  });

  test("a reset replay AFTER acceptance → exactly one user row", async () => {
    const h = harness();
    const s = held([
      { type: "history_reset", messages: HISTORY },
      { type: "user_message", text: "same" },
      { type: "turn_end", reason: "end_turn" },
    ] as SessionEvent[]);
    const done = h.feed.ownTurn("t1", s.stream, { text: "same" }, Promise.resolve());
    await settle();
    expect(userTexts(h.states())).toEqual(["same"]);
    s.release();
    await done;
    // The reset replaced the rows with HISTORY ("Alpha"), then the replay once.
    expect(userTexts(h.states())).toEqual(["Alpha", "same"]);
  });

  test("an acceptance that lands after the stream already ended draws nothing late", async () => {
    const h = harness();
    let accept: () => void = () => {};
    const accepted = new Promise<void>((r) => {
      accept = r;
    });
    await h.feed.ownTurn("t1", gen([] as SessionEvent[]), { text: "late" }, accepted);
    accept();
    await settle();
    expect(userTexts(h.states())).toEqual([]);
  });
});
