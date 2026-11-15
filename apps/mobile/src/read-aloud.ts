/**
 * Read-aloud as a pure state machine (docs/feat/mobile-voice.md Design §3):
 * `idle | speaking{rowKey, index, total}`. The reducer returns EFFECTS
 * (`speak`, `stopSpeaking`); `voice-controller.ts` performs them on the native
 * port. Every branch is a test in `test/read-aloud.test.ts`.
 *
 * Each `speak` carries a fresh `id`, and the native module tags every `speech`
 * event with it: a late `stopped` for the row we just switched AWAY from is
 * ignored instead of idling the new one (drift from the plan's interface,
 * recorded in Execution).
 */
import { parse } from "./markdown.ts";
import type { SpeechLang } from "./speakable.ts";
import { clean, speakable } from "./speakable.ts";
import { type VoiceInfo, detectLanguage, pickVoice } from "./speech-language.ts";

export type SpeechRate = "normal" | "fast";

export type ReadAloudState =
  | { readonly kind: "idle"; readonly nextId: number }
  | {
      readonly kind: "speaking";
      readonly nextId: number;
      readonly id: number;
      readonly rowKey: string;
      readonly index: number;
      readonly total: number;
    };

/** What to say, as built by `speechRequest` (pure: text + settings + voices). */
export interface SpeechRequest {
  readonly utterances: readonly string[];
  readonly voiceId: string | undefined;
  readonly lang: SpeechLang;
  readonly rate: SpeechRate;
}

export type SpeechEventState = "started" | "utterance" | "finished" | "stopped" | "interrupted";

export type ReadAloudEvent =
  /** The speaker button of `rowKey` was tapped (or auto-read chose it). */
  | { readonly type: "tap"; readonly rowKey: string; readonly request: SpeechRequest }
  | {
      readonly type: "speech";
      readonly id: number;
      readonly state: SpeechEventState;
      readonly index?: number;
    }
  | { readonly type: "appState"; readonly state: "active" | "inactive" | "background" }
  /** Dictation is about to listen: the app must never transcribe its own voice (F11). */
  | { readonly type: "dictationStarting" }
  /** The screen goes away (F13). */
  | { readonly type: "dispose" };

export type ReadAloudEffect =
  | { readonly type: "stopSpeaking" }
  | {
      readonly type: "speak";
      readonly id: number;
      readonly utterances: readonly string[];
      readonly voiceId: string | undefined;
      /** The system default voice for this language is used when `voiceId` is undefined (F10). */
      readonly lang: SpeechLang;
      readonly rate: SpeechRate;
    };

export interface ReadAloudStep {
  readonly state: ReadAloudState;
  readonly effects: readonly ReadAloudEffect[];
}

export const READ_ALOUD_IDLE: ReadAloudState = { kind: "idle", nextId: 1 };

function idle(state: ReadAloudState): ReadAloudState {
  return { kind: "idle", nextId: state.nextId };
}

function stop(state: ReadAloudState): ReadAloudStep {
  return state.kind === "speaking"
    ? { state: idle(state), effects: [{ type: "stopSpeaking" }] }
    : { state, effects: [] };
}

export function readAloudReduce(state: ReadAloudState, event: ReadAloudEvent): ReadAloudStep {
  switch (event.type) {
    case "tap": {
      if (state.kind === "speaking" && state.rowKey === event.rowKey) {
        return stop(state);
      }
      const effects: ReadAloudEffect[] =
        state.kind === "speaking" ? [{ type: "stopSpeaking" }] : [];
      const { utterances, voiceId, lang, rate } = event.request;
      if (utterances.length === 0) {
        // Nothing speakable (F10): stop whatever spoke, start nothing.
        return { state: idle(state), effects };
      }
      const id = state.nextId;
      effects.push({ type: "speak", id, utterances, voiceId, lang, rate });
      return {
        state: {
          kind: "speaking",
          nextId: id + 1,
          id,
          rowKey: event.rowKey,
          index: 0,
          total: utterances.length,
        },
        effects,
      };
    }
    case "speech": {
      if (state.kind !== "speaking" || event.id !== state.id) {
        // A late event for a speech we already left: not ours any more.
        return { state, effects: [] };
      }
      if (event.state === "utterance") {
        return { state: { ...state, index: event.index ?? state.index }, effects: [] };
      }
      if (event.state === "started") {
        return { state, effects: [] };
      }
      return { state: idle(state), effects: [] };
    }
    case "appState":
      return event.state === "active" ? { state, effects: [] } : stop(state);
    case "dictationStarting":
    case "dispose":
      return stop(state);
  }
}

/** The row key that is speaking, for the row renderer (`assistant-speak-stop`). */
export function speakingRowKey(state: ReadAloudState): string | undefined {
  return state.kind === "speaking" ? state.rowKey : undefined;
}

/**
 * Is the speaker button offered on this row? Not on an empty reply, and not on
 * the row still streaming — v1 reads finished replies only (Notes: streaming
 * read-aloud is debt).
 */
export function readAloudOffered(
  row: { readonly key: string; readonly text: string },
  streamingKey: string | undefined,
): boolean {
  return row.key !== streamingKey && row.text.trim() !== "";
}

/**
 * Which assistant row is still streaming: while a turn runs, the LAST row when it
 * is an assistant row (a tool row after it means its text is done).
 */
export function streamingRowKey(
  rows: readonly { readonly kind: string; readonly key: string }[],
  running: boolean,
): string | undefined {
  const last = rows.at(-1);
  return running && last?.kind === "assistant" ? last.key : undefined;
}

/** Build what to say for one reply: utterances in its detected language, the best voice. */
export function speechRequest(
  text: string,
  options: {
    readonly fallback: SpeechLang;
    readonly voices: readonly VoiceInfo[];
    readonly rate: SpeechRate;
  },
): SpeechRequest {
  const lang = detectLanguage(text, options.fallback);
  return {
    utterances: speakable(parse(text), lang),
    voiceId: pickVoice(options.voices, lang),
    lang,
    rate: options.rate,
  };
}

/** Every condition auto-read needs (Design §3, F12). All must hold. */
export interface AutoReadGates {
  /** The "Read replies aloud" setting (default off). */
  readonly enabled: boolean;
  /** This session screen is the focused one. */
  readonly focused: boolean;
  readonly appActive: boolean;
  readonly dictationIdle: boolean;
  /** The turn that just ended was started on THIS phone (`TurnRow.own`). */
  readonly ownTurn: boolean;
}

/** A turn ended: the row to read aloud, or undefined (silent). */
export function autoReadRow(
  gates: AutoReadGates,
  rows: readonly { readonly kind: string; readonly key: string; readonly text?: string }[],
): string | undefined {
  if (!gates.enabled || !gates.focused || !gates.appActive || !gates.dictationIdle) {
    return undefined;
  }
  if (!gates.ownTurn) {
    return undefined;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "user") {
      // The ended turn produced no assistant text after the prompt.
      return undefined;
    }
    if (row?.kind === "assistant" && (row.text ?? "").trim() !== "") {
      return row.key;
    }
  }
  return undefined;
}

/** Characters of a permission title a spoken ask carries (it is a short action label). */
export const SPOKEN_TITLE_MAX = 80;

/**
 * The spoken permission ask (eval Q4): a fixed template around the request's
 * human-readable `title` ONLY — never its `detail` / `input` (pod-supplied
 * arguments), never model text. Approval stays a tap.
 */
export function spokenAsk(request: { readonly title: string }, lang: SpeechLang): string {
  let t = clean(request.title);
  if (t.length > SPOKEN_TITLE_MAX) {
    t = `${t.slice(0, SPOKEN_TITLE_MAX).trimEnd()}…`;
  }
  t = t.replace(/[.!?:;]+$/, "");
  return lang === "it"
    ? `Serve un permesso: ${t}. Rispondi sullo schermo.`
    : `Permission needed: ${t}. Answer on screen.`;
}
