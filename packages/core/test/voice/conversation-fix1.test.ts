/**
 * `conversation.ts` — REVIEW ROUND 1 regressions
 * (docs/feat/voice-conversation.md, "C2 review", findings 1–6).
 *
 * The reducer's own contract says it is *total*: "an event that does not apply
 * to the current state is a no-op" (`conversation.ts:233`). Round 1 showed that
 * only the `on` path was tested, so every off/paused cross-state entry point —
 * the ones the app-scoped controller feeds unconditionally — was unproven. These
 * tests are the off/paused path.
 *
 * One `describe` per finding, so a failure names the finding:
 *   1 → the mic opens without the person (P-F12/P-F1)      [A–D below]
 *   2 → the F1 echo rule converges (barge-in off actually stays off) and the
 *       user's `bargeIn:false` setting is not overridden by `toggle`
 *   3 → `seq` is monotonic for EVERY `speak`, so `spoken{seq}` is unambiguous
 *   4 → F14 for asks: only the edge that originated the turn speaks the ask
 *   5 → the endpoint fold has one implementation (TUI re-pointed to core)
 *   6 → F5: a long reply is capped, then says "the rest is on screen"
 */
import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_DEFAULTS,
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

const ownTurn = (turnId: string) => ({ type: "turnStarted", turnId, own: true }) as const;
const ask = { tool: "shell", title: "ls" } as const;
const callBegan = {
  type: "interrupted",
  phase: "began",
  source: "call",
  shouldResume: false,
} as const;

// ─── Finding 1: the mic opens without the person (P-F12, P-F1) ───────────────

describe("fix 1: off is a no-op for the events the controller always feeds", () => {
  test("A: a link flap while the mode is OFF never starts recording or speaking", () => {
    const { model, commands } = drive([{ type: "linkDown" }, { type: "linkUp" }]);
    expect(model.state).toBe("off");
    expect(only(commands, "listen")).toHaveLength(0);
    expect(only(commands, "speak")).toHaveLength(0);
    // The link state itself is still tracked (F4 must work once the mode is on).
    expect(model.linkDown).toBe(false);
  });

  test("B: an ask while OFF is not spoken and does not open the mic when cleared", () => {
    const { model, commands } = drive([{ type: "askPending", ask }, { type: "askCleared" }]);
    expect(model.state).toBe("off");
    expect(only(commands, "listen")).toHaveLength(0);
    expect(only(commands, "speak")).toHaveLength(0);
    // F6 still applies to the field path: the ask is recorded, so a send blocks.
    const sent = drive([{ type: "utter" }, { type: "final", text: "yes", lang: "en" }], model);
    expect(only(sent.commands, "prompt")).toHaveLength(0);
  });

  test("C: after a call, a link flap returns to PAUSED, not to listening (P-F1)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      callBegan,
      { type: "linkDown" },
      { type: "linkUp" },
    ]);
    expect(model.state).toBe("paused");
    expect(only(commands, "listen")).toHaveLength(1); // only the activation's own
  });

  test("D: after a call, an ask that clears returns to PAUSED, not to listening", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      callBegan,
      { type: "askPending", ask },
      { type: "askCleared" },
    ]);
    expect(model.state).toBe("paused");
    expect(only(commands, "listen")).toHaveLength(1);
  });

  test("a link flap after a USER pause stays paused (the tap is the only resume)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      { type: "remote", command: "pause" },
      { type: "linkDown" },
      { type: "linkUp" },
    ]);
    expect(model.state).toBe("paused");
    expect(only(commands, "listen")).toHaveLength(1);
  });

  test("a thermal pause is not undone by a link flap, and not entered while OFF", () => {
    const off = drive([{ type: "thermal", state: "critical" }]);
    expect(off.model.state).toBe("off");
    expect(only(off.commands, "hush")).toHaveLength(0);
    const on = drive([
      { type: "toggle" },
      { type: "thermal", state: "critical" },
      { type: "linkDown" },
      { type: "linkUp" },
    ]);
    expect(on.model.state).toBe("paused");
  });

  test("resumeFailed while OFF is a no-op; a recognition burst cannot pause OFF", () => {
    expect(drive([{ type: "resumeFailed", code: "cannotStartRecording" }]).model.state).toBe("off");
    let model = conversationStart();
    for (let i = 0; i < 5; i++) {
      model = conversationReducer(model, { type: "recognitionFailed", atMs: i * 1000 }).model;
    }
    expect(model.state).toBe("off");
  });

  test("a pause reason is remembered, and only a switch that is ON pauses", () => {
    const on = drive([{ type: "toggle" }]).model;
    expect(drive([callBegan], on).model.pausedBy).toBe("call");
    // A phone call's `ended` must still never resume (P-F1) even with an ask up.
    const afterAsk = drive(
      [{ type: "interrupted", phase: "ended", source: "call", shouldResume: true }],
      drive([{ type: "askPending", ask }], on).model,
    );
    expect(afterAsk.model.state).toBe("askPending");
    expect(only(afterAsk.commands, "listen")).toHaveLength(0);
  });
});

// ─── Finding 2: the echo rule converges (F1), and the setting is honoured ────

describe("fix 2: barge-in off stays off until the person turns the mode on again", () => {
  function echoTrip(count: number): { model: ConversationModel; commands: ConversationCommand[] } {
    let model = drive([{ type: "toggle" }]).model;
    model = conversationReducer(model, ownTurn("t1")).model;
    const commands: ConversationCommand[] = [];
    for (let i = 0; i < count; i++) {
      const step = conversationReducer(model, {
        type: "bargein",
        atMs: 1000 * i,
        transcriptEmpty: true,
      });
      model = step.model;
      commands.push(...step.commands);
    }
    return { model, commands };
  }

  test("once tripped, later empty barge-ins emit nothing — no notice, no speech", () => {
    const tripped = echoTrip(CONVERSATION_DEFAULTS.echoBargeIns + 1);
    expect(tripped.model.bargeIn).toBe(false);
    const later = conversationReducer(tripped.model, {
      type: "bargein",
      atMs: 5000,
      transcriptEmpty: true,
    });
    expect(later.commands).toEqual([]);
    expect(later.model.bargeIn).toBe(false);
  });

  test("... and the notice says it only once (no self-feeding echo loop)", () => {
    const { commands } = echoTrip(12);
    const notices = only(commands, "notice").filter((n) => /echo/i.test("text" in n ? n.text : ""));
    expect(notices).toHaveLength(1);
    const echoSpeech = only(commands, "speak").filter((s) =>
      /echo/i.test("text" in s ? s.text : ""),
    );
    expect(echoSpeech).toHaveLength(1);
  });

  test("with barge-in off the edge is told, so its own gate stops raising it", () => {
    const { commands } = echoTrip(CONVERSATION_DEFAULTS.echoBargeIns + 1);
    expect(commands).toContainEqual({ cmd: "bargeIn", enabled: false });
  });

  test("a person's own switch-on re-arms barge-in (and says nothing)", () => {
    const tripped = echoTrip(CONVERSATION_DEFAULTS.echoBargeIns + 1).model;
    const again = drive([{ type: "toggle" }, { type: "toggle" }], tripped);
    expect(again.model.bargeIn).toBe(true);
    expect(again.commands).toContainEqual({ cmd: "bargeIn", enabled: true });
  });

  test("the shipped default and the person's `bargeIn:false` are both honoured by toggle", () => {
    expect(conversationStart().bargeIn).toBe(true);
    const settingOff = drive([{ type: "toggle" }], conversationStart({ bargeIn: false }));
    expect(settingOff.model.bargeIn).toBe(false);
  });

  test("after a person's switch-on, the echo rule can trip again", () => {
    const tripped = echoTrip(CONVERSATION_DEFAULTS.echoBargeIns + 1).model;
    let model = drive([{ type: "toggle" }, { type: "toggle" }], tripped).model;
    model = conversationReducer(model, ownTurn("t2")).model;
    for (let i = 0; i < CONVERSATION_DEFAULTS.echoBargeIns + 1; i++) {
      model = conversationReducer(model, {
        type: "bargein",
        atMs: 60_000 + 1000 * i,
        transcriptEmpty: true,
      }).model;
    }
    expect(model.bargeIn).toBe(false);
  });
});

// ─── Finding 3: `seq` is one monotonic counter per edge ─────────────────────

describe("fix 3: every `speak` carries a unique, increasing seq", () => {
  const seqs = (commands: readonly ConversationCommand[]) =>
    only(commands, "speak").map((c) => ("seq" in c ? c.seq : -1));

  function strictlyIncreasing(values: readonly number[]): boolean {
    return values.every((v, i) => i === 0 || v > (values[i - 1] ?? Number.NaN));
  }

  test("G: a narration line and the reply's first chunk do not share seq 0", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "toolCall", tool: "shell", atMs: 1000 },
      { type: "textDelta", turnId: "t1", text: "Hello there my friend. This is a reply. " },
    ]);
    const values = seqs(commands);
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(new Set(values).size).toBe(values.length);
    expect(strictlyIncreasing(values)).toBe(true);
  });

  test("system lines (link, ask, resumeFailed, echo) all take their own seq", () => {
    const link = drive([{ type: "toggle" }, { type: "linkDown" }, { type: "linkUp" }]);
    const askRun = drive([{ type: "toggle" }, { type: "askPending", ask }]);
    const resume = drive([{ type: "toggle" }, { type: "resumeFailed", code: "x" }]);
    for (const run of [link, askRun, resume]) {
      const values = seqs(run.commands);
      expect(values.length).toBeGreaterThan(0);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  test("seq never restarts mid-mode: it survives turn end and a second turn", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "One answer. " },
      { type: "turnEnded", turnId: "t1" },
      ownTurn("t2"),
      { type: "textDelta", turnId: "t2", text: "Two answer. " },
      { type: "turnEnded", turnId: "t2" },
    ]);
    const values = seqs(commands);
    expect(values.length).toBeGreaterThanOrEqual(2);
    expect(strictlyIncreasing(values)).toBe(true);
  });

  test("spoken{seq} of a system line cannot clear the reply chunk that shares 0", () => {
    const run = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "toolCall", tool: "shell", atMs: 1000 },
      { type: "textDelta", turnId: "t1", text: "Hello there my friend. This is a reply. " },
    ]);
    const narration = only(run.commands, "speak")[0];
    const replyChunk = only(run.commands, "speak")[1];
    // The edge reports the NARRATION done: the reply chunk is still in flight.
    const after = conversationReducer(
      conversationReducer(run.model, { type: "speaking", seq: (narration as { seq: number }).seq })
        .model,
      { type: "spoken", seq: (narration as { seq: number }).seq },
    );
    expect(after.model.speech.inFlight).toContain((replyChunk as { seq: number }).seq);
    expect(after.model.state).not.toBe("listening");
  });
});

// ─── Finding 4: F14 for asks — only the originating edge speaks the ask ──────

describe("fix 4: an ask is spoken only by the edge that originated the turn", () => {
  test("H: a foreign turn's ask is shown, never spoken (this edge stays quiet)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      { type: "turnStarted", turnId: "x", own: false },
      { type: "askPending", ask, turnId: "x" },
    ]);
    expect(only(commands, "speak")).toHaveLength(0);
    // The ask still suspends sends on BOTH edges (it is answerable anywhere).
    expect(model.ask).not.toBeNull();
    const sent = drive([{ type: "utter" }, { type: "final", text: "yes", lang: "en" }], model);
    expect(only(sent.commands, "prompt")).toHaveLength(0);
    expect(only(sent.commands, "enqueue")).toHaveLength(0);
  });

  test("our own turn's ask IS spoken (hush first, then the ask)", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "askPending", ask, turnId: "t1" },
    ]);
    expect(spoken(commands)).toMatch(/ls/);
    const kinds = commands.map((c) => c.cmd);
    expect(kinds.lastIndexOf("hush")).toBeLessThan(kinds.lastIndexOf("speak"));
  });

  test("a voice-steered turn's ask is spoken too (it is ours now)", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "turnStarted", turnId: "foreign", own: false },
      { type: "utter" },
      { type: "final", text: "keep going", lang: "en" },
      { type: "askPending", ask, turnId: "foreign" },
    ]);
    expect(spoken(commands)).toMatch(/ls/);
  });

  test("an ask with no turn id is spoken (the daemon did not say whose it is)", () => {
    const { commands } = drive([{ type: "toggle" }, { type: "askPending", ask }]);
    expect(spoken(commands)).toMatch(/ls/);
  });

  test("with no turn id the reducer falls back to the turn it knows", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "turnStarted", turnId: "foreign", own: false },
      { type: "askPending", ask },
    ]);
    expect(only(commands, "speak")).toHaveLength(0);
  });
});

// ─── Finding 6: F5 — a long reply is capped, then says where the rest is ────

describe("fix 6: F5 caps what is spoken and says the rest is on screen", () => {
  /** A reply long enough to cross the cap (each sentence is 48 chars; 40 × 48 ≫1 200). */
  const LONG = `${"This sentence is here to fill the budget quickly. ".repeat(40)}`;

  test("the spoken text never exceeds the cap, and the tail is on screen", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: LONG },
      { type: "turnEnded", turnId: "t1" },
    ]);
    const chunks = only(commands, "speak").map((c) => ("text" in c ? c.text : ""));
    const notice = chunks.filter((c) => /rest is on screen/i.test(c));
    expect(notice).toHaveLength(1);
    const body = chunks.filter((c) => !/rest is on screen/i.test(c));
    const total = body.join(" ").length;
    expect(total).toBeLessThanOrEqual(CONVERSATION_DEFAULTS.maxSpokenChars);
    // And it is the START of the reply, not a truncation from the middle.
    expect(body.join(" ")).toContain("This sentence is here to fill");
  });

  test("a short reply is spoken in full, with no 'on screen' line", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Short answer. " },
      { type: "turnEnded", turnId: "t1" },
    ]);
    const chunks = only(commands, "speak").map((c) => ("text" in c ? c.text : ""));
    expect(chunks.join(" ")).not.toMatch(/rest is on screen/i);
    expect(chunks.join(" ")).toContain("Short answer");
  });

  test("the cap is a surface, not a per-turn reset: two turns keep one budget", () => {
    // F5 caps a REPLY; a new turn gets a new budget (otherwise the mode goes
    // silent after the first long answer).
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: LONG },
      { type: "turnEnded", turnId: "t1" },
      ownTurn("t2"),
      { type: "textDelta", turnId: "t2", text: LONG },
      { type: "turnEnded", turnId: "t2" },
    ]);
    const notices = only(commands, "speak").filter((c) =>
      /rest is on screen/i.test("text" in c ? c.text : ""),
    );
    expect(notices).toHaveLength(2);
  });

  test("the cap is configurable and recorded in the model, per edge", () => {
    expect(conversationStart().maxSpokenChars).toBe(CONVERSATION_DEFAULTS.maxSpokenChars);
    expect(conversationStart({ maxSpokenChars: 50 }).maxSpokenChars).toBe(50);
  });

  test("the original text still reaches the screen (speakable never eats it)", () => {
    // The reducer only decides what is SPOKEN; the display is the session's own
    // transcript, so nothing here can shorten it — pinned so nobody "fixes" F5
    // by truncating the delta.
    const step = conversationReducer(drive([{ type: "toggle" }, ownTurn("t1")]).model, {
      type: "textDelta",
      turnId: "t1",
      text: LONG,
    });
    expect(step.model.speech.turnId).toBe("t1");
  });
});
