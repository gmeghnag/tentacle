/**
 * `conversation.ts` — REVIEW ROUND 2 regressions
 * (docs/feat/voice-conversation.md, "Round 2", findings 1–2).
 *
 * Round 1 fixed the cross-state ENTRY points one by one (a link flap or an ask
 * while `off` must not open the mic). The property behind them — *an off or
 * paused mode produces no audio* — was applied to the events that were named,
 * not to the pipeline that produces `speak`, so `textDelta` and `turnEnded`
 * kept speaking the reply through a pause (finding 1). And a `speak` the edge
 * is playing must be clearable by its `spoken{seq}`, or the reducer returns to
 * `listening` over its own audio; the tail flushed at turn end and every system
 * line never joined `inFlight` (finding 2).
 *
 * One `describe` per finding, so a failure names the finding:
 *   1 → no `speak` while the mode is off or paused          [J, K, L]
 *   2 → every `speak`'s seq is in `inFlight` until `spoken` [M, N]
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

function only(commands: readonly ConversationCommand[], kind: string) {
  return commands.filter((c) => c.cmd === kind);
}

function spoken(commands: readonly ConversationCommand[]): string {
  return only(commands, "speak")
    .map((c) => ("text" in c ? c.text : ""))
    .join(" ");
}

const speakSeqs = (commands: readonly ConversationCommand[]): number[] =>
  only(commands, "speak").map((c) => ("seq" in c ? c.seq : -1));

const ownTurn = (turnId: string) => ({ type: "turnStarted", turnId, own: true }) as const;
const speaking = (seq: number) => ({ type: "speaking", seq }) as const;
const spokenEv = (seq: number) => ({ type: "spoken", seq }) as const;
const callBegan = {
  type: "interrupted",
  phase: "began",
  source: "call",
  shouldResume: false,
} as const;

// The reply the daemon keeps streaming while the mode is paused: several
// sentences, so the pipeline has both a chunk to speak and a tail to hold.
const LONG = "This is a sentence that goes on. ".repeat(3);

// ─── Finding 1: the reply is not spoken while the mode is paused ─────────────

describe("fix 1 (round 2): a paused mode produces no audio", () => {
  test("J: a phone-call pause silences the reply that keeps streaming", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      callBegan,
      { type: "textDelta", turnId: "t1", text: LONG },
      { type: "turnEnded", turnId: "t1" },
    ]);
    expect(model.state).toBe("paused");
    expect(only(commands, "speak")).toHaveLength(0);
  });

  test("K: a lock-screen (Now Playing) pause silences it too", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "remote", command: "pause" },
      { type: "textDelta", turnId: "t1", text: LONG },
      { type: "turnEnded", turnId: "t1" },
    ]);
    expect(model.state).toBe("paused");
    expect(only(commands, "speak")).toHaveLength(0);
  });

  test("L: after resumeFailed, the tail is not spoken at turn end (P-F10)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there my good friend and" },
      { type: "resumeFailed", code: "cannotStartRecording" },
      { type: "turnEnded", turnId: "t1" },
    ]);
    expect(model.state).toBe("paused");
    // The line that was spoken before the refusal is fine; what follows it is not.
    expect(spoken(commands)).not.toContain("friend and");
    // The pipeline is reset, so no later turn end can flush a stale tail.
    expect(model.speech.turnId).toBeNull();
  });

  test("the PROPERTY, not the list: every event is silent while paused or off", () => {
    // Round 1 fixed the events the review named; round 2 found `textDelta`
    // outside that list. This drives EVERY event at a paused mode (and at an
    // off one) and asserts the property behind them: no `speak`, ever.
    const paused = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "A sentence so far. " },
      callBegan,
    ]).model;
    expect(paused.state).toBe("paused");
    const events: ConversationEvent[] = [
      { type: "textDelta", turnId: "t1", text: LONG },
      { type: "toolCall", tool: "shell", atMs: 5000 },
      { type: "turnEnded", turnId: "t1" },
      { type: "askPending", ask: ASK, turnId: "t1" },
      { type: "askCleared" },
      { type: "linkDown" },
      { type: "linkUp" },
      { type: "resumeFailed", code: "x" },
      { type: "recognitionFailed", atMs: 1000 },
      { type: "thermal", state: "serious" },
      { type: "bargein", atMs: 2000 },
    ];
    for (const state of [paused, conversationStart()]) {
      let model = state;
      for (const event of events) {
        const step = conversationReducer(model, event);
        model = step.model;
        expect({ event: event.type, speaks: only(step.commands, "speak") }).toEqual({
          event: event.type,
          speaks: [],
        });
      }
      // `thermal: critical` pauses without speaking (a notice, never audio).
      expect(
        only(
          conversationReducer(conversationStart(), { type: "thermal", state: "critical" }).commands,
          "speak",
        ),
      ).toHaveLength(0);
    }
  });

  test("L2: resumeFailed drops the LIVE pipeline (a hushed chunk is not still 'in flight')", () => {
    // The reset is a fact of its own, independent of turn end: the chunk the
    // edge was playing (seq 0) was hushed, so after the refusal only the line
    // the person is told may be in flight — otherwise a late `spoken{0}` clears
    // nothing and the mode's in-flight bookkeeping drifts.
    const before = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there. And a tail" },
      { type: "speaking", seq: 0 },
    ]);
    expect(before.model.speech.inFlight).toEqual([0]);
    const after = conversationReducer(before.model, { type: "resumeFailed", code: "x" });
    expect(after.model.speech.inFlight).toEqual([1]);
    expect(after.model.speech.turnId).toBeNull();
  });

  test("L3: turnEnded refuses the tail on a paused model, whoever paused it", () => {
    // The second line of defence, and the one round 2 asked for: the tail flush
    // checks the STATE, not an edge's promise. Constructed directly because
    // every pause path in the reducer today also resets the pipeline — this
    // pins that a future pause path cannot reintroduce the bug by forgetting to.
    const on = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there. And then a tail" },
    ]);
    expect(on.model.speech.turnId).toBe("t1");
    const pausedWithTail: ConversationModel = {
      ...on.model,
      state: "paused",
      pausedBy: "user",
    };
    const step = conversationReducer(pausedWithTail, { type: "turnEnded", turnId: "t1" });
    expect(only(step.commands, "speak")).toHaveLength(0);
  });

  test("a pause does not poison the NEXT turn: resuming speaks again", () => {
    // The guard refuses audio, it does not disable the mode: once the person
    // resumes, the next reply is spoken normally.
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      callBegan,
      { type: "textDelta", turnId: "t1", text: LONG },
      { type: "remote", command: "playPause" },
      ownTurn("t2"),
      { type: "textDelta", turnId: "t2", text: "Back again, hello. " },
      { type: "turnEnded", turnId: "t2" },
    ]);
    expect(spoken(commands)).toContain("Back again, hello.");
    expect(spoken(commands)).not.toContain("sentence that goes on");
  });
});

// ─── Finding 2: every spoken seq is tracked until the edge reports it ────────

describe("fix 2 (round 2): inFlight holds every seq the edge is playing", () => {
  test("M: the tail flushed at turn end stays in flight", () => {
    const run = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there. And then a tail" },
      speaking(0),
      { type: "turnEnded", turnId: "t1" },
    ]);
    const seqs = speakSeqs(run.commands);
    expect(seqs).toEqual([0, 1]);
    // The edge finishes the chunk it was playing: the tail (seq 1) still is, so
    // the mode must not go back to listening — that is an open mic over its own
    // audio, and `canListen` would accept an `utter`.
    const afterChunk = conversationReducer(run.model, spokenEv(0)).model;
    expect(afterChunk.state).not.toBe("listening");
    expect(afterChunk.speech.inFlight).toContain(1);
    // The tail reported done: now the mode listens again.
    const afterTail = conversationReducer(
      conversationReducer(afterChunk, speaking(1)).model,
      spokenEv(1),
    ).model;
    expect(afterTail.state).toBe("listening");
  });

  test("M2: the flushed tail alone keeps the mic shut, with no `speaking` report", () => {
    // The edge may not have reported `speaking` for the chunk before the turn
    // ends, so the state cannot be the only guard: `canListen` must be false
    // because the tail is in flight.
    const run = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there. And then a tail" },
      { type: "turnEnded", turnId: "t1" },
    ]);
    expect(run.model.state).not.toBe("listening");
    const heard = conversationReducer(run.model, { type: "utter", atMs: 10 });
    expect(heard.model.state).not.toBe("capturing");
  });

  test("N: a system line stays in flight across a late report of hushed audio", () => {
    // The reply's chunk (seq 0) is playing; the link drops (hush, "Connection
    // lost." seq 1, pipeline reset) and comes back ("Reconnected." seq 2). The
    // edge then reports the HUSHED chunk's seq 0 late: it must not clear the
    // line it is playing, or the mode goes to `listening` over its own audio.
    const run = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there. And then a tail" },
      { type: "linkDown" },
      { type: "linkUp" },
    ]);
    const reconnected = speakSeqs(run.commands).at(-1) ?? -1;
    expect(reconnected).toBeGreaterThan(0);
    expect(run.model.speech.inFlight).toContain(reconnected);
    const playing = conversationReducer(run.model, speaking(reconnected)).model;
    const afterLate = conversationReducer(playing, spokenEv(0)).model;
    expect(afterLate.state).not.toBe("listening");
    const done = conversationReducer(afterLate, spokenEv(reconnected)).model;
    expect(done.state).toBe("listening");
  });

  test("the ask line and the narration line are tracked the same way", () => {
    const askRun = drive([{ type: "toggle" }, { type: "askPending", ask: ASK }]);
    expect(askRun.model.speech.inFlight).toEqual(speakSeqs(askRun.commands));
    const toolRun = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "toolCall", tool: "shell", atMs: 1000 },
    ]);
    expect(toolRun.model.speech.inFlight).toEqual(speakSeqs(toolRun.commands));
  });
});

const ASK = { tool: "shell", title: "ls" } as const;
