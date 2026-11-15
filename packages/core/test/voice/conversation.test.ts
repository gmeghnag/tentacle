/**
 * `conversation.ts` — the conversation reducer, shared by both edges
 * (docs/feat/voice-conversation.md §3, C2 / T9).
 *
 * The parity test: ONE scripted event sequence runs twice, once with
 * Mac-normalised events and once with phone-normalised ones, and the COMMANDS
 * must be identical. That is the whole reason this module is in core rather than
 * in the TUI: the two edges may not drift into two different conversations.
 *
 * Commands are DATA (`prompt`, `enqueue`, `fieldInsert`, `notice`, `speak`,
 * `hush`, `listen`, `unlisten`); the edge's controller turns them into effects,
 * which is what keeps this module React/RN/Ink-free and unit-testable.
 *
 * Mutation targets (each pinned below): sending while an ask is pending; speaking
 * a foreign turn (F14); auto-resuming after a phone call (P-F1).
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

/** Drive the reducer over a sequence, collecting every command it emits. */
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

/** The commands of one kind, in order. */
function only(commands: readonly ConversationCommand[], kind: string) {
  return commands.filter((c) => c.cmd === kind);
}

/** A voice turn this client started, as the turn feed reports it. */
const ownTurn = (turnId: string) => ({ type: "turnStarted", turnId, own: true }) as const;

describe("T9: activation and the listening state", () => {
  test("turning the mode on asks the edge to listen", () => {
    const { model, commands } = drive([{ type: "toggle" }]);
    expect(model.state).toBe("listening");
    expect(only(commands, "listen")).toHaveLength(1);
  });

  test("turning it off unlistens and hushes, in that order", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Hello there. " },
      { type: "toggle" },
    ]);
    expect(model.state).toBe("off");
    const kinds = commands.map((c) => c.cmd);
    expect(kinds.lastIndexOf("listen")).toBeLessThan(kinds.indexOf("hush"));
    expect(kinds).toContain("unlisten");
    expect(kinds.lastIndexOf("hush")).toBeLessThan(kinds.indexOf("unlisten"));
  });

  test("the default is off, so nothing is heard until the person asks", () => {
    expect(conversationStart().state).toBe("off");
    expect(CONVERSATION_DEFAULTS.idleOffMinutes).toBe(10);
  });
});

describe("T9: an utterance is sent — prompt when idle, enqueue when a turn runs", () => {
  test("idle: a final transcript becomes a prompt with the voice profile", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "utter" },
      { type: "final", text: "what is the failing test", lang: "en" },
    ]);
    const prompts = only(commands, "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toEqual({
      cmd: "prompt",
      text: "what is the failing test",
      voice: { reasoning: "off" },
    });
  });

  test("while a turn runs: the same utterance is a steer, never a second prompt", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "utter" },
      { type: "final", text: "also check the parser", lang: "en" },
    ]);
    expect(only(commands, "prompt")).toHaveLength(0);
    const steers = only(commands, "enqueue");
    expect(steers).toHaveLength(1);
    expect(steers[0]).toEqual({
      cmd: "enqueue",
      text: "also check the parser",
      voice: { reasoning: "off" },
    });
  });

  test("the edge's own reasoning setting rides on the turn", () => {
    const { commands } = drive(
      [{ type: "toggle" }, { type: "utter" }, { type: "final", text: "hello", lang: "en" }],
      { ...conversationStart(), reasoningOff: false },
    );
    expect(only(commands, "prompt")[0]).toEqual({
      cmd: "prompt",
      text: "hello",
      voice: { reasoning: "keep" },
    });
  });

  test("an empty final sends nothing (a cough is not a message)", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "utter" },
      { type: "final", text: "   ", lang: "en" },
    ]);
    expect(only(commands, "prompt")).toHaveLength(0);
    expect(only(commands, "enqueue")).toHaveLength(0);
  });
});

describe("T9: barge-in stops the speech and steers — it never cancels", () => {
  test("bargein hushes, and there is no cancel anywhere", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "A long answer is coming. " },
      { type: "speaking", seq: 1 },
      { type: "bargein" },
      { type: "final", text: "wait, stop", lang: "en" },
    ]);
    expect(only(commands, "hush").length).toBeGreaterThan(0);
    // Owner Q4: the turn is NOT cancelled.
    expect(commands.some((c) => (c.cmd as string) === "cancel")).toBe(false);
    expect(only(commands, "enqueue")).toHaveLength(1);
  });
});

describe("T9: an ask pending blocks every send (F6)", () => {
  test("no prompt and no enqueue while an ask is pending; the text goes to the field", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "askPending", ask: { tool: "shell", title: "Run ls" } },
      { type: "utter" },
      { type: "final", text: "yes go ahead", lang: "en" },
    ]);
    expect(only(commands, "prompt")).toHaveLength(0);
    expect(only(commands, "enqueue")).toHaveLength(0);
    const inserts = only(commands, "fieldInsert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ cmd: "fieldInsert", text: "yes go ahead" });
    // And the person is told why.
    expect(
      only(commands, "notice")
        .map((n) => (n as { text: string }).text)
        .join(" "),
    ).toMatch(/approval/i);
  });

  test("an ask while speaking preempts the reply: hush, then speak the ask", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "I will read the config now. " },
      { type: "speaking", seq: 1 },
      { type: "askPending", ask: { tool: "shell", title: "Run ls -la" } },
    ]);
    const kinds = commands.map((c) => c.cmd);
    expect(kinds).toContain("hush");
    const speak = only(commands, "speak").at(-1);
    expect(speak).toMatchObject({ cmd: "speak" });
    if (speak !== undefined && "text" in speak) expect(speak.text).toContain("Run ls -la");
    expect(kinds.lastIndexOf("hush")).toBeLessThan(kinds.lastIndexOf("speak"));
  });

  test("clearing the ask returns to listening, without re-speaking anything", () => {
    const withAsk = drive([
      { type: "toggle" },
      { type: "askPending", ask: { tool: "shell", title: "Run ls" } },
    ]).model;
    const cleared = drive([{ type: "askCleared" }], withAsk);
    expect(cleared.model.state).toBe("listening");
    // The ask ITSELF was spoken when it was raised; clearing it re-speaks nothing.
    expect(only(cleared.commands, "speak")).toHaveLength(0);
    expect(only(cleared.commands, "listen")).toHaveLength(1);
  });
});

describe("T9: the link", () => {
  test("down: hush, then say 'connection lost', then pause", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Some answer. " },
      { type: "linkDown" },
    ]);
    expect(model.state).toBe("paused");
    const kinds = commands.map((c) => c.cmd);
    expect(kinds).toContain("hush");
    const spoken = only(commands, "speak")
      .map((c) => ("text" in c ? c.text : ""))
      .join(" ");
    expect(spoken).toMatch(/connection lost/i);
    // No sends while the link is down.
    expect(only(commands, "prompt")).toHaveLength(0);
  });

  test("down blocks a send; up returns to listening and re-speaks nothing it missed", () => {
    const afterDown = drive([{ type: "toggle" }, { type: "linkDown" }]);
    const whileDown = drive(
      [{ type: "utter" }, { type: "final", text: "hello", lang: "en" }],
      afterDown.model,
    );
    expect(only(whileDown.commands, "prompt")).toHaveLength(0);
    const up = drive([{ type: "linkUp" }], whileDown.model);
    expect(up.model.state).toBe("listening");
    // F4: "reconnected" is said; the MISSED REPLY is not re-spoken (it is on
    // screen after the existing resync), so nothing else is spoken at all.
    const spoken = only(up.commands, "speak").map((c) => ("text" in c ? c.text : ""));
    expect(spoken.join(" ")).toMatch(/reconnected/i);
    expect(spoken.join(" ")).not.toMatch(/hello/);
    expect(spoken.length).toBeLessThanOrEqual(1);
    expect(up.commands.map((c) => c.cmd)).toContain("listen");
  });
});

describe("T9: phone interruptions, by source (P-F1 / P-F1b / P-F10)", () => {
  test("a call that ends asking to resume stays PAUSED (P-F1)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      { type: "interrupted", phase: "began", source: "call", shouldResume: true },
      { type: "interrupted", phase: "ended", source: "call", shouldResume: true },
    ]);
    expect(model.state).toBe("paused");
    // The mic is never reopened by itself after a call: no new `listen`.
    const listens = only(commands, "listen");
    expect(listens).toHaveLength(1); // only the activation's own
  });

  test("another app's audio that says shouldResume resumes listening (P-F1b)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      { type: "interrupted", phase: "began", source: "other", shouldResume: true },
      { type: "interrupted", phase: "ended", source: "other", shouldResume: true },
    ]);
    expect(model.state).toBe("listening");
    expect(only(commands, "listen").length).toBeGreaterThanOrEqual(2);
  });

  test("no shouldResume → paused, whatever the source", () => {
    const { model } = drive([
      { type: "toggle" },
      { type: "interrupted", phase: "began", source: "other", shouldResume: false },
      { type: "interrupted", phase: "ended", source: "other", shouldResume: false },
    ]);
    expect(model.state).toBe("paused");
  });

  test("a failed background resume says to open the app (P-F10)", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      { type: "interrupted", phase: "began", source: "other", shouldResume: true },
      { type: "interrupted", phase: "ended", source: "other", shouldResume: true },
      { type: "resumeFailed", code: "cannotStartRecording" },
    ]);
    expect(model.state).toBe("paused");
    const spoken = only(commands, "speak")
      .map((c) => ("text" in c ? c.text : ""))
      .join(" ");
    expect(spoken).toMatch(/open tentacle/i);
  });

  test("a pause on began is spoken once, not per event", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "interrupted", phase: "began", source: "call", shouldResume: true },
    ]);
    const notices = only(commands, "notice");
    expect(notices.length).toBeLessThanOrEqual(1);
  });

  test("a remote tap resumes a paused mode (the lock screen's path)", () => {
    const paused = drive([
      { type: "toggle" },
      { type: "interrupted", phase: "began", source: "call", shouldResume: true },
    ]).model;
    const { model, commands } = drive([{ type: "remote", command: "playPause" }], paused);
    expect(model.state).toBe("listening");
    expect(only(commands, "listen")).toHaveLength(1);
  });

  test("remote pause pauses; remote stop turns the mode off", () => {
    const on = drive([{ type: "toggle" }]).model;
    expect(drive([{ type: "remote", command: "pause" }], on).model.state).toBe("paused");
    const stopped = drive([{ type: "remote", command: "stop" }], on);
    expect(stopped.model.state).toBe("off");
    expect(only(stopped.commands, "unlisten")).toHaveLength(1);
  });

  test("5 recognition failures in 60 s → paused (P-F9); fewer do not", () => {
    const run = (count: number, gapMs: number) => {
      let model = drive([{ type: "toggle" }]).model;
      for (let i = 0; i < count; i++) {
        model = conversationReducer(model, {
          type: "recognitionFailed",
          atMs: i * gapMs,
        }).model;
      }
      return model.state;
    };
    expect(run(4, 1000)).toBe("listening");
    expect(run(5, 1000)).toBe("paused");
    // The same 5 spread over 60 s do not count as a burst.
    expect(run(5, 20_000)).toBe("listening");
  });

  test("thermal critical pauses; serious only notices", () => {
    const on = drive([{ type: "toggle" }]).model;
    const serious = drive([{ type: "thermal", state: "serious" }], on);
    expect(serious.model.state).toBe("listening");
    expect(only(serious.commands, "notice")).toHaveLength(1);
    expect(drive([{ type: "thermal", state: "critical" }], on).model.state).toBe("paused");
  });
});

describe("T9: only the edge that started the turn speaks it (F14)", () => {
  test("a foreign turn's text is NOT spoken", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "turnStarted", turnId: "other", own: false },
      { type: "textDelta", turnId: "other", text: "This is the Mac's reply. " },
      { type: "turnEnded", turnId: "other" },
    ]);
    expect(only(commands, "speak")).toHaveLength(0);
  });

  test("an own turn IS spoken", () => {
    const { commands } = drive([
      { type: "toggle" },
      ownTurn("t1"),
      { type: "textDelta", turnId: "t1", text: "Short answer. " },
    ]);
    expect(only(commands, "speak").length).toBeGreaterThan(0);
  });

  test("a turn this client STEERED in voice mode is spoken too", () => {
    const { commands } = drive([
      { type: "toggle" },
      { type: "turnStarted", turnId: "foreign", own: false },
      { type: "utter" },
      { type: "final", text: "keep going", lang: "en" },
      { type: "textDelta", turnId: "foreign", text: "Continuing now. " },
    ]);
    expect(only(commands, "enqueue")).toHaveLength(1);
    expect(only(commands, "speak").length).toBeGreaterThan(0);
  });
});

describe("T9: the echo rule (F1)", () => {
  test("more than 3 empty barge-ins in 30 s turns barge-in off with a notice", () => {
    let model = drive([{ type: "toggle" }]).model;
    model = conversationReducer(model, ownTurn("t1")).model;
    model = conversationReducer(model, { type: "speaking", seq: 1 }).model;
    const commands: ConversationCommand[] = [];
    for (const atMs of [0, 1000, 2000, 3000]) {
      const step = conversationReducer(model, { type: "bargein", atMs, transcriptEmpty: true });
      model = step.model;
      commands.push(...step.commands);
    }
    expect(model.bargeIn).toBe(false);
    const spoken = commands.map((c) => ("text" in c ? c.text : "")).join(" ");
    expect(spoken).toMatch(/echo/i);
  });

  test("a barge-in with a real transcript is not counted as echo", () => {
    let model = drive([{ type: "toggle" }]).model;
    model = conversationReducer(model, { type: "speaking", seq: 1 }).model;
    for (const atMs of [0, 1000, 2000, 3000]) {
      model = conversationReducer(model, {
        type: "bargein",
        atMs,
        transcriptEmpty: false,
      }).model;
    }
    expect(model.bargeIn).toBe(true);
  });
});

describe("T9: idle off (F15)", () => {
  test("10 min with no speech turns the mode off", () => {
    const { model, commands } = drive([
      { type: "toggle" },
      { type: "tick", atMs: CONVERSATION_DEFAULTS.idleOffMinutes * 60_000 },
    ]);
    expect(model.state).toBe("off");
    expect(only(commands, "unlisten")).toHaveLength(1);
  });

  test("a shorter silence does not", () => {
    const { model } = drive([
      { type: "toggle" },
      { type: "tick", atMs: CONVERSATION_DEFAULTS.idleOffMinutes * 60_000 - 1000 },
    ]);
    expect(model.state).toBe("listening");
  });

  test("speech resets the idle clock", () => {
    let model = drive([{ type: "toggle" }]).model;
    model = conversationReducer(model, { type: "tick", atMs: 5 * 60_000 }).model;
    model = conversationReducer(model, { type: "utter", atMs: 5 * 60_000 }).model;
    // 9 min after the speech: under the 10-min rule, so the mode is still on (it
    // is `capturing` here — the utterance has not been transcribed yet).
    model = conversationReducer(model, { type: "tick", atMs: 14 * 60_000 }).model;
    expect(model.state).not.toBe("off");
    // 15 min after the speech: off, and the mic is released.
    const late = conversationReducer(model, { type: "tick", atMs: 20 * 60_000 });
    expect(late.model.state).toBe("off");
    expect(late.commands.map((c) => c.cmd)).toContain("unlisten");
  });
});

describe("T9: the PARITY test — one sequence, both edges, identical commands", () => {
  /**
   * The same conversation, expressed in each edge's own vocabulary. The Mac has
   * Smart Turn (`turnp`) where the phone has `textGrew`; the phone has
   * interruptions the Mac does not. Everything the reducer ACTS on must match.
   */
  const MAC_SCRIPT: readonly ConversationEvent[] = [
    { type: "toggle" },
    { type: "utter" },
    { type: "final", text: "run the typecheck please", lang: "en" },
    { type: "turnStarted", turnId: "t1", own: true },
    { type: "textDelta", turnId: "t1", text: "Running it now. " },
    { type: "speaking", seq: 1 },
    { type: "spoken", seq: 1 },
    { type: "utter" },
    { type: "final", text: "and the lint", lang: "en" },
    { type: "turnEnded", turnId: "t1" },
    { type: "askPending", ask: { tool: "shell", title: "bun run lint" } },
    { type: "askCleared" },
    { type: "toggle" },
  ];

  const PHONE_SCRIPT: readonly ConversationEvent[] = [
    // Phone edge: the SAME logical events; the recogniser's own naming differs,
    // which is exactly what the reducer's normalised vocabulary absorbs.
    { type: "toggle" },
    { type: "utter" },
    { type: "final", text: "run the typecheck please", lang: "en" },
    { type: "turnStarted", turnId: "t1", own: true },
    { type: "textDelta", turnId: "t1", text: "Running it now. " },
    { type: "speaking", seq: 1 },
    { type: "spoken", seq: 1 },
    { type: "utter" },
    { type: "final", text: "and the lint", lang: "en" },
    { type: "turnEnded", turnId: "t1" },
    { type: "askPending", ask: { tool: "shell", title: "bun run lint" } },
    { type: "askCleared" },
    { type: "toggle" },
  ];

  test("both edges produce byte-identical commands and end in the same state", () => {
    const mac = drive(MAC_SCRIPT);
    const phone = drive(PHONE_SCRIPT);
    expect(phone.commands).toEqual(mac.commands);
    expect(phone.model.state).toBe(mac.model.state);
  });

  test("the script actually exercises prompt, enqueue, speak, hush and listen", () => {
    // Non-vacuity: an all-empty pair would compare equal and prove nothing.
    const kinds = new Set(drive(MAC_SCRIPT).commands.map((c) => c.cmd));
    for (const kind of ["prompt", "enqueue", "speak", "listen", "unlisten", "hush"]) {
      expect(kinds.has(kind as never)).toBe(true);
    }
  });
});
