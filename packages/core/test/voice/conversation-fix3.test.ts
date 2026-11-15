/**
 * `conversation.ts` — REVIEW ROUND 3 regression
 * (docs/feat/voice-conversation.md, "Round 3", finding 1).
 *
 * Round 2 made the tail flushed at turn end join `inFlight`, so `spoken{seq}`
 * can always clear what the edge is playing. But the PER-TURN pipeline reset
 * still built an empty `inFlight`: a queued steer (or an auto-sent prompt)
 * starts the next turn at once, and the reset forgot the tail the previous turn
 * had just handed to the edge — `spoken{0}` then returned the mode to
 * `listening` over seqs that were still playing. Round 2's `M`, one event later.
 *
 *   N3 → a turn/pipeline reset keeps the seqs the edge is still playing
 */
import { describe, expect, test } from "bun:test";
import {
  type ConversationCommand,
  type ConversationEvent,
  type ConversationModel,
  conversationReducer,
  conversationStart,
} from "../../src/voice/index.ts";

function drive(
  events: readonly ConversationEvent[],
  from: ConversationModel = conversationStart(),
): { model: ConversationModel; commands: ConversationCommand[] } {
  let model = from;
  const commands: ConversationCommand[] = [];
  for (const event of events) {
    const step = conversationReducer(model, event);
    model = step.model;
    commands.push(...step.commands);
  }
  return { model, commands };
}

const speakSeqs = (commands: readonly ConversationCommand[]): number[] =>
  commands.filter((c) => c.cmd === "speak").map((c) => ("seq" in c ? c.seq : -1));

const ownTurn = (turnId: string) => ({ type: "turnStarted", turnId, own: true }) as const;
const speaking = (seq: number) => ({ type: "speaking", seq }) as const;
const spokenEv = (seq: number) => ({ type: "spoken", seq }) as const;

// A reply with a chunk to speak and a tail held until the turn ends.
const REPLY = "Hello there. And then a tail";

describe("fix round 3, finding 1: a new turn does not drop the tail in flight", () => {
  test("N3: turnStarted keeps the previous turn's tail in flight", () => {
    const run = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: REPLY },
      speaking(0),
      { type: "turnEnded", turnId: "t1" },
    ]);
    // The tail (seq 1) was flushed at the end of t1 and is now the edge's audio.
    expect(speakSeqs(run.commands)).toEqual([0, 1]);
    expect(run.model.speech.inFlight).toEqual([0, 1]);

    // A queued steer (or a prompt the person already sent) starts the next turn
    // AT ONCE, while the tail still plays.
    const next = conversationReducer(run.model, ownTurn("t2")).model;
    expect(next.speech.inFlight).toEqual([0, 1]);
    expect(next.state).not.toBe("listening");

    // The edge finishes the chunk it was playing: the tail still is, so the mode
    // must not fall back to `listening` — that is an open mic over its audio.
    const afterChunk = conversationReducer(next, spokenEv(0)).model;
    expect(afterChunk.state).not.toBe("listening");
    expect(conversationReducer(afterChunk, { type: "utter", atMs: 10 }).model.state).not.toBe(
      "capturing",
    );

    // The tail reported done: now the mode listens again.
    const afterTail = conversationReducer(
      conversationReducer(afterChunk, speaking(1)).model,
      spokenEv(1),
    ).model;
    expect(afterTail.state).toBe("listening");
  });

  test("N3b: the per-turn reset inside a delta keeps the tail too", () => {
    // `textDelta` resets the pipeline on its own whenever `speech.turnId`
    // differs — which is exactly what `turnStarted` leaves behind (it nulls
    // `turnId`). So the carry must hold on that reset as well, or the very first
    // delta of the next turn drops the tail the previous turn just flushed: the
    // bug round 2's `M` was about, from the other side.
    const run = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: REPLY },
      { type: "turnEnded", turnId: "t1" },
    ]);
    expect(run.model.speech.inFlight).toEqual([0, 1]);

    const next = drive(
      [ownTurn("t2"), { type: "textDelta", turnId: "t2", text: "Another reply. Held" }],
      run.model,
    );
    expect(speakSeqs(next.commands)).toEqual([2]);
    expect(next.model.speech.inFlight).toEqual([0, 1, 2]);

    const afterOld = conversationReducer(next.model, spokenEv(0)).model;
    expect(afterOld.state).not.toBe("listening");
    expect(afterOld.speech.inFlight).toEqual([1, 2]);
  });
});
