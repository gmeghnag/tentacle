/**
 * The CONVERSATION REDUCER, shared by both edges
 * (docs/feat/voice-conversation.md §3, C2).
 *
 * It lives in `@tentacle/core`, not in `packages/tui` (where rev 1 had it),
 * because the Mac and the iPhone must run ONE loop: the edges differ only in
 * audio I/O and in the names they give their own signals, and this normalised
 * vocabulary absorbs that. The parity test in `conversation.test.ts` is the
 * contract — the same logical conversation, in either edge's words, yields
 * byte-identical commands.
 *
 * Everything here is a VALUE: a model in, a model plus COMMANDS out. Nothing
 * reads a clock or touches a socket, so both edges' controllers are thin effect
 * runners (`listen`/`unlisten` → native, `speak`/`hush` → the engine,
 * `prompt`/`enqueue` → the session client, `fieldInsert` → the input row).
 *
 * The rules that are NOT negotiable (each pinned by T9):
 * - **F6:** an ask pending suspends every send. A spoken "yes" is never an
 *   approval, so the transcript goes to the field with a notice.
 * - **F14:** only a turn this client started OR voice-steered is spoken. Two
 *   devices in one room must never talk over each other (owner Q7).
 * - **P-F1:** a phone call never re-opens the mic by itself, whatever
 *   `shouldResume` says; any other interruption may (P-F1b).
 * - **F4:** a link drop hushes, says so, and pauses the mode; a reconnect
 *   resumes listening and NEVER re-speaks the missed remainder.
 * - **Owner Q4:** barge-in stops the speech and steers. It never cancels a turn.
 */
import { askSpeech } from "./ask-speech.ts";
import { chunkFilter } from "./chunker.ts";
import { narrate } from "./narration.ts";
import { speakableFilter } from "./speakable.ts";
import { type SpeechLang, spokenLang } from "./voice-lang.ts";

/** The conversation tunables (§3, §5b). */
export const CONVERSATION_DEFAULTS = {
  /** F15: 10 min with no speech turns the mode off, foreground or locked. */
  idleOffMinutes: 10,
  /** F1: more than 3 barge-ins in 30 s with an empty transcript = echo. */
  echoBargeIns: 3,
  echoWindowMs: 30_000,
  /** P-F9: 5 recognition failures in 60 s → paused. */
  failuresBurst: 5,
  failureWindowMs: 60_000,
  /**
   * F5: at most this many characters of ONE reply are spoken, then "the rest is
   * on screen". A per-edge config value (both shipped edges use this default).
   */
  maxSpokenChars: 1200,
} as const;

/** F5's one line, said once per capped reply (it is already on screen). */
const REST_ON_SCREEN = "The rest is on screen.";

/** The mode's states (§3). */
export type ConversationState =
  | "off"
  | "listening"
  | "capturing"
  | "transcribing"
  | "speaking"
  | "askPending"
  | "paused";

/** What the mode remembers between events. */
export interface ConversationModel {
  readonly state: ConversationState;
  /**
   * This edge's own "reasoning off for spoken replies" setting (§4). Read at
   * SEND time, so flipping it mid-conversation affects the next turn.
   */
  readonly reasoningOff: boolean;
  /**
   * F1's LIVE flag: barge-in is on until the echo rule turns it off for this
   * mode, and a person's own switch-on re-arms it. Never `toggle`d back on from
   * this flag — that is `bargeInSetting`'s job (review round 1, finding 2).
   */
  readonly bargeIn: boolean;
  /**
   * The person's own setting (§6 Settings row, both edges): what every switch-on
   * starts from, so `bargeIn: false` is never overridden by turning the mode on.
   */
  readonly bargeInSetting: boolean;
  /**
   * F5, per edge: characters of ONE reply that may be spoken before the mode
   * says "the rest is on screen". Only what is HEARD is capped — the reply text
   * on screen is the session transcript's and is never shortened here.
   */
  readonly maxSpokenChars: number;
  /** The spoken language: the last utterance's, then the setting, then `en`. */
  readonly lang: SpeechLang | null;
  /** The edge's configured language, for `spokenLang`'s fallback. */
  readonly langSetting: string | null;
  /** The turn currently running, and whether this client owns (or steered) it. */
  readonly turnId: string | null;
  readonly ownTurnId: string | null;
  /** Turns this client voice-steered: they are spoken when they come back. */
  readonly steeredTurns: readonly string[];
  /** Link state: no sends, and the mode pauses, while it is down. */
  readonly linkDown: boolean;
  /** The pending ask, if one is up (F6). */
  readonly ask: { readonly tool: string; readonly title: string } | null;
  /** Media time of the last speech, for the idle-off rule. */
  readonly lastSpeechAtMs: number;
  /** `bargein` times inside the echo window, with whether each was empty. */
  readonly bargeIns: readonly { readonly atMs: number; readonly empty: boolean }[];
  /** `recognitionFailed` times, for the P-F9 burst rule. */
  readonly failures: readonly number[];
  /** Which interruption source paused the mode (P-F1's "never after a call"). */
  readonly pausedBy: "call" | "other" | "link" | "thermal" | "recognition" | "user" | null;
  /** The speaking pipeline state: the reply's text as it streams in. */
  readonly speech: SpeechOutput;
  /** When narration last spoke (`null`: never), for its throttle. */
  readonly narratedAtMs: number | null;
}

/**
 * The text→speech pipeline's state: `speakableFilter` hides what must not be
 * heard (fences, tables, hrefs), `chunkFilter` decides when it may be spoken.
 */
export interface SpeechOutput {
  readonly speakable: ReturnType<typeof speakableFilter.init>;
  readonly chunks: ReturnType<typeof chunkFilter.init>;
  /**
   * The seq of the NEXT `speak` — ONE monotonic counter for the whole mode, not
   * per turn and not per producer: reply chunks, narration and every system line
   * take from it, because the edge reports `spoken{seq}` and two producers
   * sharing a number would clear each other's playback (review round 1, finding
   * 3). It survives a turn's end on purpose.
   */
  readonly seq: number;
  /** Which turn's text is being spoken. */
  readonly turnId: string | null;
  /** Chunks spoken and not yet reported done: `speak` after these is ordered. */
  readonly inFlight: readonly number[];
  /** F5: characters spoken for the current reply, and whether the cap was hit. */
  readonly spokenChars: number;
  readonly capped: boolean;
  /** F5: "the rest is on screen" has been said for this reply (say it once). */
  readonly restNoticed: boolean;
  /** F5, per edge: the cap this reply is spoken under (the model's setting). */
  readonly maxSpokenChars: number;
}

/** What the edge must DO. Data, never an effect. */
export type ConversationCommand =
  | {
      readonly cmd: "prompt";
      readonly text: string;
      readonly voice: { readonly reasoning: "off" | "keep" };
    }
  | {
      readonly cmd: "enqueue";
      readonly text: string;
      readonly voice: { readonly reasoning: "off" | "keep" };
    }
  | { readonly cmd: "fieldInsert"; readonly text: string }
  | { readonly cmd: "notice"; readonly text: string }
  | { readonly cmd: "speak"; readonly text: string; readonly seq: number }
  /**
   * F1, finding 2: the edge's own barge-in gate follows the model's flag. Without
   * this the controller acts on `bargein` the reducer has already ruled out, and
   * its "echo detected" speech is itself echo — the loop F1 exists to break.
   */
  | { readonly cmd: "bargeIn"; readonly enabled: boolean }
  | { readonly cmd: "hush" }
  | { readonly cmd: "listen" }
  | { readonly cmd: "unlisten" };

/**
 * The NORMALISED input vocabulary (§3): both edges translate their platform's
 * events into these, so no rule below is edge-specific except the two the design
 * names explicitly (the turn model and the interruption source).
 */
export type ConversationEvent =
  | { readonly type: "toggle" }
  | { readonly type: "utter"; readonly atMs?: number }
  | { readonly type: "final"; readonly text: string; readonly lang?: string | null }
  | {
      readonly type: "bargein";
      /** Media time, for the echo window; absent → the last known speech time. */
      readonly atMs?: number;
      readonly transcriptEmpty?: boolean;
    }
  | { readonly type: "speaking"; readonly seq: number }
  | { readonly type: "spoken"; readonly seq: number }
  | { readonly type: "turnStarted"; readonly turnId: string; readonly own: boolean }
  | { readonly type: "textDelta"; readonly turnId: string; readonly text: string }
  | { readonly type: "toolCall"; readonly tool: string; readonly atMs: number }
  | { readonly type: "turnEnded"; readonly turnId: string }
  | {
      readonly type: "askPending";
      readonly ask: { readonly tool: string; readonly title: string };
      /** The turn it blocks. Absent → the daemon did not say, so it is spoken. */
      readonly turnId?: string;
    }
  | { readonly type: "askCleared" }
  | { readonly type: "linkDown" }
  | { readonly type: "linkUp" }
  | {
      readonly type: "interrupted";
      readonly phase: "began" | "ended";
      readonly source: "call" | "other";
      readonly shouldResume: boolean;
    }
  | { readonly type: "resumeFailed"; readonly code: string }
  | { readonly type: "remote"; readonly command: "playPause" | "pause" | "stop" }
  | { readonly type: "recognitionFailed"; readonly atMs: number }
  | { readonly type: "thermal"; readonly state: "nominal" | "serious" | "critical" }
  | { readonly type: "tick"; readonly atMs: number };

/** The mode's start: off, and the edge's settings in their shipped defaults. */
export function conversationStart(
  settings: {
    readonly reasoningOff?: boolean;
    readonly bargeIn?: boolean;
    readonly lang?: string | null;
    readonly maxSpokenChars?: number;
  } = {},
): ConversationModel {
  const bargeIn = settings.bargeIn ?? true;
  return {
    state: "off",
    reasoningOff: settings.reasoningOff ?? true,
    bargeIn,
    bargeInSetting: bargeIn,
    maxSpokenChars: settings.maxSpokenChars ?? CONVERSATION_DEFAULTS.maxSpokenChars,
    lang: null,
    langSetting: settings.lang ?? null,
    turnId: null,
    ownTurnId: null,
    steeredTurns: [],
    linkDown: false,
    ask: null,
    lastSpeechAtMs: 0,
    bargeIns: [],
    failures: [],
    pausedBy: null,
    speech: emptySpeech(0, settings.maxSpokenChars ?? CONVERSATION_DEFAULTS.maxSpokenChars),
    narratedAtMs: null,
  };
}

/** The empty speech pipeline. `seq` is the caller's: it is one counter per mode. */
function emptySpeech(
  seq = 0,
  maxSpokenChars: number = CONVERSATION_DEFAULTS.maxSpokenChars,
): SpeechOutput {
  return {
    speakable: speakableFilter.init("en"),
    chunks: chunkFilter.init(),
    seq,
    turnId: null,
    inFlight: [],
    spokenChars: 0,
    capped: false,
    restNoticed: false,
    maxSpokenChars,
  };
}

/** Is this client allowed to SPEAK this turn? (F14, owner Q7.) */
function speaksTurn(model: ConversationModel, turnId: string): boolean {
  return model.ownTurnId === turnId || model.steeredTurns.includes(turnId);
}

/** The `voice` field this edge puts on a turn (§4: its own setting, at send time). */
function voiceProfile(model: ConversationModel): { reasoning: "off" | "keep" } {
  return { reasoning: model.reasoningOff ? "off" : "keep" };
}

/** May the mode hear the person right now? */
function canListen(model: ConversationModel): boolean {
  return model.state === "listening" || model.state === "capturing";
}

/** May an utterance be SENT right now? (F6, F4.) */
function canSend(model: ConversationModel): boolean {
  return model.state !== "off" && model.state !== "paused" && !model.linkDown && model.ask === null;
}

/** The language a reply is spoken in, from the model. */
function langOf(model: ConversationModel): SpeechLang {
  return spokenLang({ utterance: model.lang, setting: model.langSetting });
}

/**
 * A SYSTEM line (link, ask, echo, resume-failed, narration): it takes the mode's
 * next seq like everything else, so `spoken{seq}` can never confuse it with a
 * reply chunk (review round 1, finding 3).
 */
function systemSpeak(
  speech: SpeechOutput,
  text: string,
): { readonly command: ConversationCommand; readonly speech: SpeechOutput } {
  const seq = speech.seq;
  return {
    command: { cmd: "speak", text, seq },
    // The line JOINS `inFlight`: the edge will report it with `spoken{seq}` like
    // any chunk, and an untracked seq makes that report clear nothing — the mode
    // then falls back to `listening` over the audio it is still playing
    // (review round 2, finding 2).
    speech: { ...speech, seq: seq + 1, inFlight: [...speech.inFlight, seq] },
  };
}

/**
 * Is the mode on (neither `off` nor `paused`)? The edge's controller is
 * app-scoped and feeds link, ask and interruption events unconditionally, so the
 * cross-state entry points check this instead of trusting the edge to filter
 * (review round 1, finding 1, P-F12).
 */
function isOn(model: ConversationModel): boolean {
  return model.state !== "off" && model.state !== "paused";
}

/**
 * The reducer: one event in, the next model plus the commands it implies.
 * Total and pure — an event that does not apply to the current state is a no-op,
 * never a throw (the edges feed this from native callbacks that can arrive late).
 */
export function conversationReducer(
  model: ConversationModel,
  event: ConversationEvent,
): { readonly model: ConversationModel; readonly commands: readonly ConversationCommand[] } {
  switch (event.type) {
    case "toggle":
      return model.state === "off" ? turnOn(model) : turnOff(model);

    case "utter":
      if (!canListen(model) || model.ask !== null) return { model, commands: [] };
      return {
        model: {
          ...model,
          state: "capturing",
          lastSpeechAtMs: event.atMs ?? model.lastSpeechAtMs,
        },
        commands: [],
      };

    case "final":
      return finalTranscript(model, event.text, event.lang ?? null);

    case "bargein":
      // Owner Q4 + F1. With barge-in off — tripped by the echo rule or set off by
      // the person — a raised `bargein` is a no-op: acting on it (hush, notice,
      // speech) is what kept the echo loop alive (finding 2).
      if (!model.bargeIn || !isOn(model)) return { model, commands: [] };
      return bargeIn(model, event.atMs ?? model.lastSpeechAtMs, event.transcriptEmpty === true);

    case "speaking":
      // The edge reports it is actually playing chunk `seq`: the state follows.
      return {
        model:
          model.state === "off" || model.state === "paused"
            ? model
            : { ...model, state: "speaking" },
        commands: [],
      };

    case "spoken": {
      const inFlight = model.speech.inFlight.filter((s) => s !== event.seq);
      return {
        model: {
          ...model,
          speech: { ...model.speech, inFlight },
          // Back to listening once the queue is empty and the mode was speaking.
          state:
            model.state === "speaking" && inFlight.length === 0 && model.ask === null
              ? "listening"
              : model.state,
        },
        commands: [],
      };
    }

    case "turnStarted":
      return {
        model: {
          ...model,
          turnId: event.turnId,
          ownTurnId: event.own ? event.turnId : model.ownTurnId,
          // A new turn resets the PIPELINE and F5's budget — but not `seq`, which
          // is the edge's one counter for the whole mode (finding 3).
          speech: {
            ...emptySpeech(model.speech.seq),
            speakable: speakableFilter.init(langOf(model)),
          },
        },
        commands: [],
      };

    case "textDelta":
      return textDelta(model, event.turnId, event.text);

    case "toolCall":
      return toolCall(model, event.tool, event.atMs);

    case "turnEnded":
      return turnEnded(model, event.turnId);

    case "askPending": {
      // F6: the ask preempts speech (it is the thing that blocks the turn). It is
      // recorded even while the mode is off — the send must block there too — but
      // it is SAID only when the mode is on and the turn is ours (finding 4).
      const asked: ConversationModel = {
        ...model,
        ask: event.ask,
        // `paused` stays `paused` (with its own reason), `off` stays off: an ask
        // must not become the new state after a call (finding 1, P-F1).
        state: isOn(model) ? "askPending" : model.state,
        speech: emptySpeech(model.speech.seq, model.maxSpokenChars),
      };
      if (!isOn(model)) return { model: asked, commands: [] };
      // F14: the ask is spoken by the edge that originated the turn. The daemon
      // may not name it, so the turn the reducer already knows is the fallback.
      const turn = event.turnId ?? model.turnId;
      const ours = turn === null || speaksTurn(model, turn);
      if (!ours) return { model: asked, commands: [{ cmd: "hush" }] };
      const line = askSpeech({ tool: event.ask.tool, title: event.ask.title }, langOf(model));
      const spoken = systemSpeak(asked.speech, line);
      return {
        model: { ...asked, speech: spoken.speech },
        commands: [{ cmd: "hush" }, spoken.command],
      };
    }

    case "askCleared": {
      if (model.ask === null) return { model, commands: [] };
      // Only a mode that was ON resumes; `off` stays off and a `paused` one keeps
      // its pause and its reason, so an ask flap can never undo a call's pause nor
      // open the mic (finding 1, P-F1).
      if (!isOn(model)) {
        return { model: { ...model, ask: null }, commands: [] };
      }
      const resumed: ConversationModel = {
        ...model,
        ask: null,
        speech: emptySpeech(model.speech.seq, model.maxSpokenChars),
        state: "listening",
        pausedBy: null,
      };
      return {
        model: resumed,
        commands: [{ cmd: "listen" }],
      };
    }

    case "linkDown": {
      // The link is TRACKED in every state, but only an ON mode reacts: a drop
      // while `off` must not start recording, and one while `paused` must not
      // overwrite the reason it is paused (finding 1).
      if (model.linkDown) return { model, commands: [] };
      if (!isOn(model)) return { model: { ...model, linkDown: true }, commands: [] };
      const hushed = emptySpeech(model.speech.seq, model.maxSpokenChars);
      const spoken = systemSpeak(hushed, "Connection lost.");
      return {
        model: {
          ...model,
          linkDown: true,
          state: "paused",
          pausedBy: "link",
          speech: spoken.speech,
        },
        commands: [{ cmd: "hush" }, { cmd: "notice", text: "connection lost" }, spoken.command],
      };
    }

    case "linkUp": {
      if (!model.linkDown) return { model, commands: [] };
      // F4: back to listening, and the missed remainder is NOT re-spoken (it is
      // on screen after the existing resync). But only a mode that was paused BY
      // THE LINK resumes: after a call or a user pause the mic stays shut
      // (P-F1/P-F12, finding 1).
      const resumes = model.pausedBy === "link";
      const resumed: ConversationModel = {
        ...model,
        linkDown: false,
        state: resumes ? "listening" : model.state,
        pausedBy: resumes ? null : model.pausedBy,
        speech: emptySpeech(model.speech.seq, model.maxSpokenChars),
      };
      if (!resumes) return { model: resumed, commands: [] };
      const spoken = systemSpeak(resumed.speech, "Reconnected.");
      return {
        model: { ...resumed, speech: spoken.speech },
        commands: [spoken.command, { cmd: "listen" }],
      };
    }

    case "interrupted":
      return interrupted(model, event.phase, event.source, event.shouldResume);

    case "resumeFailed": {
      // P-F10: a resume refused from the background. Off stays off (nothing to
      // resume), and a mode already paused keeps its own reason (finding 1).
      if (!isOn(model)) return { model, commands: [] };
      // P-F10: the refusal drops the LIVE pipeline (a reply may still be
      // streaming in, and nothing of it may be spoken over "open tentacle to
      // resume") — the line the person is told is what stays in flight
      // (review round 2, finding 1: `L`).
      const hushed = emptySpeech(model.speech.seq, model.maxSpokenChars);
      const spoken = systemSpeak(hushed, "Open tentacle to resume.");
      return {
        model: {
          ...model,
          state: "paused",
          pausedBy: "user",
          speech: spoken.speech,
        },
        commands: [
          { cmd: "hush" },
          { cmd: "notice", text: "open tentacle to resume" },
          spoken.command,
        ],
      };
    }

    case "remote":
      return remote(model, event.command);

    case "recognitionFailed":
      return recognitionFailed(model, event.atMs);

    case "thermal":
      // A reading only matters to a mode that is ON: `off` has no engine to
      // throttle away, and a `paused` mode keeps its own reason (finding 1).
      if (!isOn(model)) return { model, commands: [] };
      if (event.state === "critical") {
        return {
          model: {
            ...model,
            state: "paused",
            pausedBy: "thermal",
            speech: emptySpeech(model.speech.seq),
          },
          commands: [
            { cmd: "hush" },
            { cmd: "notice", text: "the phone is too hot, voice mode paused" },
          ],
        };
      }
      if (event.state === "serious") {
        return {
          model,
          commands: [{ cmd: "notice", text: "the phone is getting hot" }],
        };
      }
      return { model, commands: [] };

    case "tick":
      return tick(model, event.atMs);
  }
}

/** The mode turns on: listen, or say why not. */
function turnOn(model: ConversationModel): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  const on: ConversationModel = {
    ...model,
    state: model.linkDown ? "paused" : "listening",
    pausedBy: model.linkDown ? "link" : null,
    // A person's switch-on re-arms barge-in from THEIR setting, never from the
    // live flag the echo rule lowered (finding 2).
    bargeIn: model.bargeInSetting,
    speech: emptySpeech(model.speech.seq),
  };
  const commands: ConversationCommand[] = [{ cmd: "bargeIn", enabled: on.bargeIn }];
  if (model.linkDown) {
    commands.push({ cmd: "notice", text: "no connection: voice mode is paused" });
  } else {
    commands.push({ cmd: "listen" });
  }
  return { model: on, commands };
}

/** The mode turns off: hush first, then release the mic (F13/F8 ordering). */
function turnOff(model: ConversationModel): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  return {
    model: {
      ...model,
      state: "off",
      ask: null,
      pausedBy: null,
      speech: emptySpeech(model.speech.seq),
    },
    commands: [{ cmd: "hush" }, { cmd: "unlisten" }],
  };
}

/** A finished transcript: a prompt when idle, a steer when a turn runs (F3). */
function finalTranscript(
  model: ConversationModel,
  rawText: string,
  lang: string | null,
): { readonly model: ConversationModel; readonly commands: readonly ConversationCommand[] } {
  const text = rawText.trim();
  const heard: ConversationModel =
    lang === null ? { ...model, state: stateAfterCapture(model) } : withLang(model, lang);
  if (text === "") {
    return { model: { ...heard, state: stateAfterCapture(heard) }, commands: [] };
  }

  // F6 / F4: a send is not allowed, so the text goes to the field with a reason.
  if (!canSend(heard)) {
    const reason =
      heard.ask !== null
        ? "answer the approval first: the text is in the field"
        : heard.linkDown
          ? "no connection: the text is in the field"
          : "voice mode is paused: the text is in the field";
    return {
      model: { ...heard, state: heard.ask !== null ? "askPending" : heard.state },
      commands: [
        { cmd: "fieldInsert", text },
        { cmd: "notice", text: reason },
      ],
    };
  }

  const voice = voiceProfile(heard);
  // F3: ANY running turn takes a steer, never a second prompt — ours is already
  // being spoken, a foreign one becomes ours by steering it (F14, owner Q7).
  const running = heard.turnId !== null;
  if (running) {
    return {
      model: {
        ...heard,
        state: stateAfterCapture(heard),
        steeredTurns: heard.steeredTurns.includes(heard.turnId ?? "")
          ? heard.steeredTurns
          : [...heard.steeredTurns, heard.turnId ?? ""],
      },
      commands: [{ cmd: "enqueue", text, voice }],
    };
  }
  return {
    model: { ...heard, state: stateAfterCapture(heard) },
    commands: [{ cmd: "prompt", text, voice }],
  };
}

/** The state after a captured utterance is consumed. */
function stateAfterCapture(model: ConversationModel): ConversationState {
  if (model.state === "off" || model.state === "paused" || model.state === "askPending") {
    return model.state;
  }
  return "listening";
}

/** Record the utterance's language (it wins over the setting, §3). */
function withLang(model: ConversationModel, lang: string): ConversationModel {
  return { ...model, lang: spokenLang({ utterance: lang, setting: model.langSetting }) };
}

/** Owner Q4 + F1: stop the speech, steer, and detect an echo loop. */
function bargeIn(
  model: ConversationModel,
  atMs: number,
  transcriptEmpty: boolean,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  const window = model.bargeIns.filter((b) => atMs - b.atMs <= CONVERSATION_DEFAULTS.echoWindowMs);
  const next = [...window, { atMs, empty: transcriptEmpty }];
  const commands: ConversationCommand[] = [{ cmd: "hush" }];
  const emptyCount = next.filter((b) => b.empty).length;

  if (emptyCount > CONVERSATION_DEFAULTS.echoBargeIns) {
    // F1: the mode is hearing itself. Barge-in off for this mode, and say so —
    // ONCE. The guard is the flag itself: without it every later empty barge-in
    // re-emits the notice and the "Echo detected" speech, which is itself echo,
    // so the loop F1 exists to break would continue (finding 2).
    // The hush follows, so the pipeline is dropped as at every other hush — and
    // the line itself is tracked, like every `speak` (review round 2, finding 2).
    const hushed = emptySpeech(model.speech.seq, model.maxSpokenChars);
    const spoken = systemSpeak(hushed, "Echo detected. Barge-in is off.");
    return {
      model: {
        ...model,
        bargeIns: next,
        bargeIn: false,
        speech: spoken.speech,
        state: stateAfterCapture(model),
      },
      commands: [
        ...commands,
        {
          cmd: "notice",
          text: "echo detected: barge-in is off, use Esc (or the stop control) to stop speech",
        },
        spoken.command,
        // The edge's own gate follows the model, or it keeps raising `bargein`.
        { cmd: "bargeIn", enabled: false },
      ],
    };
  }

  return {
    model: {
      ...model,
      bargeIns: next,
      speech: emptySpeech(model.speech.seq),
      // The turn is NOT cancelled (owner Q4): the utterance that follows steers it.
      state: stateAfterCapture(model),
    },
    commands,
  };
}

/** A streamed reply delta → the ordered `speak` commands it makes certain. */
function textDelta(
  model: ConversationModel,
  turnId: string,
  text: string,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  // F14: a turn this client neither started nor steered is shown, never spoken.
  if (!speaksTurn(model, turnId)) return { model, commands: [] };
  // An OFF or PAUSED mode produces no audio (review round 2, finding 1): the
  // turn keeps streaming daemon-side through a call, a lock-screen pause or a
  // refused resume, and none of it may be spoken (P-F1, F4's spirit).
  if (model.ask !== null || model.linkDown || !isOn(model)) return { model, commands: [] };

  // `seq` is the MODE's counter, so it is carried over when the pipeline resets.
  const pipeline =
    model.speech.turnId === turnId
      ? model.speech
      : emptySpeech(model.speech.seq, model.maxSpokenChars);
  const speakable = speakableFilter.step(pipeline.speakable, text);
  const chunked = chunkFilter.step(pipeline.chunks, speakable.text);
  const spoken = speakWithinBudget(
    { ...pipeline, maxSpokenChars: model.maxSpokenChars },
    chunked.chunks,
    { speakable: speakable.state, chunks: chunked.state },
  );
  const inFlight = [...pipeline.inFlight, ...spoken.commands.map((c) => c.seq)];
  return {
    model: {
      ...model,
      // F5: the tail of a capped reply is NOT spoken, but it is still CHEWED —
      // the pipeline holds nothing back, and the text on screen is the session's
      // transcript, never shortened here.
      speech: { ...spoken.state, turnId, inFlight },
    },
    commands: spoken.commands,
  };
}

/**
 * F5: the `speak` commands of ONE chunk batch, honouring `maxSpokenChars` for
 * THIS reply. Past the cap the mode stops speaking and a single "the rest is on
 * screen" line follows (the `capped` flag), so a long reply is not announced
 * chunk after chunk.
 */
function speakWithinBudget(
  pipeline: SpeechOutput,
  chunks: readonly string[],
  state: { readonly speakable: SpeechOutput["speakable"]; readonly chunks: SpeechOutput["chunks"] },
): {
  readonly commands: readonly Extract<ConversationCommand, { cmd: "speak" }>[];
  readonly state: SpeechOutput;
} {
  const commands: Extract<ConversationCommand, { cmd: "speak" }>[] = [];
  let seq = pipeline.seq;
  let spokenChars = pipeline.spokenChars;
  let capped = pipeline.capped;
  for (const chunk of chunks) {
    if (capped) break;
    if (spokenChars + chunk.length > pipeline.maxSpokenChars) {
      capped = true;
      break;
    }
    commands.push({ cmd: "speak", text: chunk, seq: seq++ });
    spokenChars += chunk.length;
  }
  return {
    commands,
    state: { ...pipeline, ...state, seq, spokenChars, capped },
  };
}

/** A tool call: one narrated line, throttled (T3's rules, applied here). */
function toolCall(
  model: ConversationModel,
  tool: string,
  atMs: number,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  if (model.state === "off" || model.state === "paused" || model.ask !== null) {
    return { model, commands: [] };
  }
  const narration = narrate(
    { lastAtMs: model.narratedAtMs, spoken: [] },
    {
      tool,
      atMs,
      // The voice is mid-reply: a tool line would interrupt the answer.
      replyQueued: model.speech.inFlight.length > 0 || model.state === "speaking",
      lang: langOf(model),
    },
  );
  if (narration.line === null) return { model, commands: [] };
  const spoken = systemSpeak(model.speech, narration.line);
  return {
    model: {
      ...model,
      narratedAtMs: narration.state.lastAtMs,
      speech: spoken.speech,
    },
    commands: [spoken.command],
  };
}

/** Turn end: flush the pipeline's held tail, and forget the turn. */
function turnEnded(
  model: ConversationModel,
  turnId: string,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  const spoke = speaksTurn(model, turnId);
  const commands: ConversationCommand[] = [];
  let pipeline = { ...model.speech, maxSpokenChars: model.maxSpokenChars };
  // A paused/off mode speaks nothing: its turn's tail is on screen, and the
  // pipeline is dropped rather than flushed (review round 2, finding 1).
  if (spoke && pipeline.turnId === turnId && isOn(model)) {
    const speakable = speakableFilter.flush(pipeline.speakable);
    const chunked = chunkFilter.step(pipeline.chunks, speakable.text);
    const flushed = chunkFilter.flush(chunked.state);
    const tail = [...chunked.chunks, ...flushed.chunks].filter((c) => c.trim() !== "");
    // F5 applies to the flushed tail too: a reply can cross the cap at turn end.
    const spoken = speakWithinBudget(pipeline, tail, {
      speakable: speakable.state,
      chunks: flushed.state,
    });
    commands.push(...spoken.commands);
    // The tail is AUDIO the edge now plays: its seqs join `inFlight`, or the
    // `spoken{seq}` that reports them clears nothing and the mode returns to
    // `listening` over them (review round 2, finding 2: `M`).
    pipeline = {
      ...spoken.state,
      inFlight: [...pipeline.inFlight, ...spoken.commands.map((c) => c.seq)],
    };
  }
  // F5: past the cap, say ONCE where the rest is — it is already on screen.
  if (pipeline.capped && !pipeline.restNoticed && isOn(model)) {
    const spoken = systemSpeak(pipeline, REST_ON_SCREEN);
    commands.push(spoken.command);
    pipeline = { ...spoken.speech, restNoticed: true };
  }
  const inFlight = pipeline.inFlight;
  return {
    model: {
      ...model,
      turnId: null,
      ownTurnId: model.ownTurnId === turnId ? null : model.ownTurnId,
      steeredTurns: model.steeredTurns.filter((t) => t !== turnId),
      // A new turn's pipeline: `seq` is the MODE's, and so is `inFlight` — a
      // tail flushed here outlives the turn that produced it.
      speech: { ...emptySpeech(pipeline.seq, model.maxSpokenChars), inFlight },
      narratedAtMs: null,
      state:
        isOn(model) && inFlight.length > 0
          ? "speaking"
          : model.state === "speaking" && commands.length === 0
            ? stateAfterCapture(model)
            : model.state,
    },
    commands,
  };
}

/** An iOS interruption, by source (P-F1 / P-F1b / P-F10). */
function interrupted(
  model: ConversationModel,
  phase: "began" | "ended",
  source: "call" | "other",
  shouldResume: boolean,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  if (phase === "began") {
    if (!isOn(model)) return { model, commands: [] };
    return {
      model: {
        ...model,
        state: "paused",
        pausedBy: source,
        speech: emptySpeech(model.speech.seq, model.maxSpokenChars),
      },
      commands: [
        { cmd: "hush" },
        { cmd: "notice", text: source === "call" ? "paused: a call is in progress" : "paused" },
      ],
    };
  }
  // P-F1: a phone call NEVER re-opens the mic by itself — it may end in a pocket.
  if (source === "call") return { model, commands: [] };
  if (!shouldResume) return { model, commands: [] };
  if (model.state !== "paused") return { model, commands: [] };
  // Only the interruption that CAUSED the pause may end it: another app's audio
  // ending must not undo a user pause, a thermal pause or an ask (finding 1).
  if (model.pausedBy !== source) return { model, commands: [] };
  if (model.linkDown) return { model, commands: [] };
  // P-F1b: another app's audio said it may resume: go back to listening.
  return { model: { ...model, state: "listening", pausedBy: null }, commands: [{ cmd: "listen" }] };
}

/** A lock-screen / Now Playing command (the §5b remote commands). */
function remote(
  model: ConversationModel,
  command: "playPause" | "pause" | "stop",
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  switch (command) {
    case "stop":
      return model.state === "off" ? { model, commands: [] } : turnOff(model);
    case "pause":
      if (model.state === "off" || model.state === "paused") return { model, commands: [] };
      return {
        model: {
          ...model,
          state: "paused",
          pausedBy: "user",
          speech: emptySpeech(model.speech.seq, model.maxSpokenChars),
        },
        commands: [{ cmd: "hush" }, { cmd: "notice", text: "paused" }],
      };
    case "playPause":
      if (model.state === "off") return turnOn(model);
      if (model.state !== "paused") return { model, commands: [] };
      if (model.linkDown) {
        return { model, commands: [{ cmd: "notice", text: "no connection" }] };
      }
      return {
        model: { ...model, state: "listening", pausedBy: null },
        commands: [{ cmd: "listen" }],
      };
  }
}

/** P-F9: 5 recognition failures in 60 s means the recogniser is not coming back. */
function recognitionFailed(
  model: ConversationModel,
  atMs: number,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  const burst = [
    ...model.failures.filter((t) => atMs - t <= CONVERSATION_DEFAULTS.failureWindowMs),
    atMs,
  ];
  if (burst.length < CONVERSATION_DEFAULTS.failuresBurst) {
    return { model: { ...model, failures: burst }, commands: [] };
  }
  // P-F9, off-path included: a recogniser that never started cannot stop, so a
  // burst while `off` (or already `paused`) changes nothing the person sees.
  if (!isOn(model)) return { model: { ...model, failures: burst }, commands: [] };
  const hushed = emptySpeech(model.speech.seq, model.maxSpokenChars);
  const spoken = systemSpeak(hushed, "Speech recognition stopped.");
  return {
    model: {
      ...model,
      failures: burst,
      state: "paused",
      pausedBy: "recognition",
      speech: spoken.speech,
    },
    commands: [{ cmd: "notice", text: "speech recognition stopped" }, spoken.command],
  };
}

/** F15 + P-F11: idle off, and a long silence never leaves the mode running. */
function tick(
  model: ConversationModel,
  atMs: number,
): {
  readonly model: ConversationModel;
  readonly commands: readonly ConversationCommand[];
} {
  if (model.state === "off") return { model, commands: [] };
  const idleMs = atMs - model.lastSpeechAtMs;
  if (idleMs < CONVERSATION_DEFAULTS.idleOffMinutes * 60_000) return { model, commands: [] };
  return {
    model: {
      ...model,
      state: "off",
      speech: emptySpeech(model.speech.seq, model.maxSpokenChars),
      pausedBy: null,
    },
    commands: [
      { cmd: "notice", text: "voice mode turned off after 10 minutes of silence" },
      { cmd: "hush" },
      { cmd: "unlisten" },
    ],
  };
}
