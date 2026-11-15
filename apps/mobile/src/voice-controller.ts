/**
 * The voice driver (docs/feat/mobile-voice.md Design §4): the `compose-controller`
 * shape — it feeds native port events and the app state into the two pure
 * reducers (`dictation.ts`, `read-aloud.ts`) and PERFORMS their effects on the
 * port and the compose seam. It decides nothing itself.
 *
 * One per mounted session screen; `dispose()` removes the port listener FIRST,
 * then cancels dictation and stops speech, so a late native event is ignored
 * (F13).
 */
import type { AppStateName } from "./app-lock.ts";
import {
  DICTATION_IDLE,
  type DictationEffect,
  type DictationEvent,
  type DictationState,
  type SendVia,
  capturesSend,
  dictationReduce,
} from "./dictation.ts";
import {
  type AutoReadGates,
  READ_ALOUD_IDLE,
  type ReadAloudEffect,
  type ReadAloudEvent,
  type ReadAloudState,
  autoReadRow,
  readAloudReduce,
  speechRequest,
  spokenAsk,
} from "./read-aloud.ts";
import type { VoiceInfo } from "./speech-language.ts";
import { dictationLocale, langOf, speechLocaleCandidates } from "./speech-locale.ts";
import type { SpeechPort, SpeechPortEvent } from "./speech-native.ts";
import type { VoiceSettings } from "./voice-settings-store.ts";

/** How often a running dictation is ticked (silence / cap / finalize timeout). */
export const TICK_MS = 250;

export interface VoiceState {
  readonly dictation: DictationState;
  readonly readAloud: ReadAloudState;
  /** The mic level 0..1 while listening (render only). */
  readonly level: number;
}

export interface VoiceControllerDeps {
  readonly port: SpeechPort;
  readonly now: () => number;
  /** The compose controller's draft seam (P3): the ONLY writer of dictated text. */
  readonly draft: () => string;
  readonly setDraft: (text: string) => void;
  /** The compose controller's Return / Send (its `composerAction` blockers still decide). */
  readonly send: (via: SendVia) => void;
  readonly settings: () => VoiceSettings;
  readonly deviceLocales: () => readonly string[];
  /** A repeating timer (injected: tests drive it). */
  readonly every: (fn: () => void, ms: number) => { cancel(): void };
}

export interface VoiceController {
  state(): VoiceState;
  subscribe(listener: (state: VoiceState) => void): () => void;
  tapMic(): void;
  /** The field changed by the person's typing (call BEFORE the compose `setDraft`). */
  userEdit(text: string): void;
  /** Return / Send: true when dictation took it (it finalizes, then sends itself). */
  send(via: SendVia): boolean;
  tapSpeak(row: { readonly key: string; readonly text: string }): Promise<void>;
  /** A turn ended: auto-read its last reply when every gate holds (F12). */
  turnEnded(input: {
    readonly ownTurn: boolean;
    readonly focused: boolean;
    readonly rows: readonly {
      readonly kind: string;
      readonly key: string;
      readonly text?: string;
    }[];
  }): Promise<void>;
  /** A permission sheet appeared: the templated spoken ask, when auto-read is on. */
  permissionAsked(request: { readonly title: string }, seq: number, focused: boolean): void;
  appState(state: AppStateName): void;
  dispose(): void;
}

export function createVoiceController(deps: VoiceControllerDeps): VoiceController {
  let state: VoiceState = { dictation: DICTATION_IDLE, readAloud: READ_ALOUD_IDLE, level: 0 };
  let app: AppStateName = "active";
  let disposed = false;
  let ticker: { cancel(): void } | undefined;
  let voices: Promise<readonly VoiceInfo[]> | undefined;
  /** A fresh id per mic tap (an id source, like `now`); the reducer matches events to it. */
  let attempts = 0;
  const listeners = new Set<(state: VoiceState) => void>();

  const emit = () => {
    for (const l of listeners) {
      l(state);
    }
  };

  const locale = () => dictationLocale(deps.settings().language, deps.deviceLocales());

  const syncTicker = () => {
    const k = state.dictation.kind;
    const wants = !disposed && (k === "listening" || k === "finalizing");
    if (wants && ticker === undefined) {
      ticker = deps.every(() => dictate({ type: "tick", now: deps.now() }), TICK_MS);
    } else if (!wants && ticker !== undefined) {
      ticker.cancel();
      ticker = undefined;
    }
  };

  function dictate(event: DictationEvent): void {
    if (disposed && event.type !== "dispose") {
      return;
    }
    const step = dictationReduce(state.dictation, event);
    state = {
      ...state,
      dictation: step.state,
      level: step.state.kind === "listening" ? state.level : 0,
    };
    syncTicker();
    emit();
    for (const effect of step.effects) {
      performDictation(effect);
    }
  }

  function read(event: ReadAloudEvent): void {
    if (disposed && event.type !== "dispose") {
      return;
    }
    const step = readAloudReduce(state.readAloud, event);
    state = { ...state, readAloud: step.state };
    emit();
    for (const effect of step.effects) {
      performRead(effect);
    }
  }

  function performDictation(effect: DictationEffect): void {
    const { port } = deps;
    const fail = (error: unknown) => {
      const code = (error as { code?: unknown } | null)?.code;
      dictate(typeof code === "string" ? { type: "startFailed", code } : { type: "startFailed" });
    };
    switch (effect.type) {
      case "probe":
        port
          .capabilities(speechLocaleCandidates(locale()))
          .then((caps) => dictate({ type: "probed", caps }), fail);
        return;
      case "requestPermissions":
        port
          .requestPermissions()
          .then((permissions) => dictate({ type: "permissions", permissions }), fail);
        return;
      case "reserve":
        port.reserveLocale(effect.locale).then(
          (ok) => dictate({ type: "reserved", ok }),
          () => dictate({ type: "reserved", ok: false }),
        );
        return;
      case "installAsset":
        port.installAsset(effect.engine, effect.locale).then(
          () => dictate({ type: "assetInstalled" }),
          () => dictate({ type: "assetFailed" }),
        );
        return;
      case "start": {
        const { attempt } = effect;
        port.startDictation({ engine: effect.engine, locale: effect.locale, attempt }).then(
          () => dictate({ type: "started", now: deps.now(), attempt }),
          (error: unknown) => {
            const code = (error as { code?: unknown } | null)?.code;
            dictate(
              typeof code === "string"
                ? { type: "startFailed", code, attempt }
                : { type: "startFailed", attempt },
            );
          },
        );
        return;
      }
      case "stop":
        port.stopDictation();
        return;
      case "cancel":
        port.cancelDictation(effect.attempt);
        return;
      case "setDraft":
        deps.setDraft(effect.text);
        return;
      case "haptic":
        port.haptic(effect.kind);
        return;
      case "send":
        deps.send(effect.via);
        return;
      case "stopSpeaking":
        read({ type: "dictationStarting" });
        return;
    }
  }

  function performRead(effect: ReadAloudEffect): void {
    if (effect.type === "stopSpeaking") {
      deps.port.stopSpeaking();
      return;
    }
    deps.port.speak({
      id: effect.id,
      utterances: effect.utterances,
      voiceId: effect.voiceId,
      language: effect.lang === "it" ? "it-IT" : "en-US",
      rate: effect.rate,
    });
  }

  const onPort = (event: SpeechPortEvent) => {
    switch (event.type) {
      case "dictation":
        dictate({ ...event, now: deps.now() });
        return;
      case "ended":
        dictate({
          type: "ended",
          reason: event.reason,
          ...(event.code === undefined ? {} : { code: event.code }),
          ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
        });
        return;
      case "assetProgress":
        dictate(event);
        return;
      case "level":
        if (state.dictation.kind === "listening") {
          state = { ...state, level: Math.max(0, Math.min(1, event.rms)) };
          emit();
        }
        return;
      case "speech":
        read(event);
        return;
    }
  };
  const unsubscribePort = deps.port.addListener(onPort);

  const loadVoices = () => {
    voices ??= deps.port.voices().catch(() => []);
    return voices;
  };

  const speakRow = async (key: string, text: string) => {
    if (state.readAloud.kind === "speaking" && state.readAloud.rowKey === key) {
      read({ type: "tap", rowKey: key, request: emptyRequest(deps.settings().rate) });
      return;
    }
    const list = await loadVoices();
    if (disposed) {
      return;
    }
    const fallback = langOf(locale());
    const request = speechRequest(text, { fallback, voices: list, rate: deps.settings().rate });
    // Read-aloud starting stops a running dictation first (F11).
    dictate({ type: "ttsStarting", now: deps.now() });
    read({ type: "tap", rowKey: key, request });
  };

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tapMic() {
      attempts += 1;
      dictate({
        type: "tap",
        draft: deps.draft(),
        locale: locale(),
        now: deps.now(),
        attempt: attempts,
      });
    },
    userEdit(text) {
      dictate({ type: "userEdit", text });
    },
    send(via) {
      if (!capturesSend(state.dictation)) {
        return false;
      }
      dictate({ type: "send", via, now: deps.now() });
      return true;
    },
    tapSpeak: (row) => speakRow(row.key, row.text),
    async turnEnded(input) {
      const gates: AutoReadGates = {
        enabled: deps.settings().readAloud,
        focused: input.focused,
        appActive: app === "active",
        dictationIdle: state.dictation.kind === "idle" || state.dictation.kind === "failed",
        ownTurn: input.ownTurn,
      };
      const key = autoReadRow(gates, input.rows);
      const row = key === undefined ? undefined : input.rows.find((r) => r.key === key);
      if (row !== undefined && state.readAloud.kind === "idle") {
        await speakRow(row.key, row.text ?? "");
      }
    },
    permissionAsked(request, seq, focused) {
      const idleDictation = state.dictation.kind === "idle" || state.dictation.kind === "failed";
      if (!deps.settings().readAloud || !focused || app !== "active" || !idleDictation) {
        return;
      }
      const lang = langOf(locale());
      read({
        type: "tap",
        rowKey: `ask:${seq}`,
        request: {
          utterances: [spokenAsk(request, lang)],
          voiceId: undefined,
          lang,
          rate: deps.settings().rate,
        },
      });
    },
    appState(next) {
      app = next;
      dictate({ type: "appState", state: next });
      read({ type: "appState", state: next });
    },
    dispose() {
      if (disposed) {
        return;
      }
      // Listener off FIRST: nothing native reaches the reducers after this (F13).
      unsubscribePort();
      disposed = true;
      dictate({ type: "dispose" });
      read({ type: "dispose" });
      syncTicker();
      listeners.clear();
    },
  };
}

function emptyRequest(rate: VoiceSettings["rate"]) {
  return { utterances: [], voiceId: undefined, lang: "en" as const, rate };
}
