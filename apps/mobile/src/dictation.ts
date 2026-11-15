/**
 * Dictation as a pure state machine (docs/feat/mobile-voice.md Design §2):
 *
 *   idle → asking → preparing(reserve | download | start) → listening
 *        → finalizing{after: idle | send} → idle            (+ failed{card})
 *
 * The reducer returns EFFECTS and never performs them; `voice-controller.ts`
 * runs them on the native port and the compose controller. The clock is
 * injected (every event that needs time carries `now`). Every rule is a test in
 * `test/dictation.test.ts`.
 *
 * The draft is written ONLY through the `setDraft` effect (→
 * `controller.setDraft`, P3), so drafts, the outbox and restore-after-failure
 * see dictated text exactly like typed text.
 */
import { chooseEngine } from "./speech-engine.ts";
import type { Capabilities, EndedReason, Engine, Permissions } from "./speech-native.ts";
import { type MicView, localeName, micViewFor } from "./voice-permission.ts";

/** No new text for this long while listening → auto-stop (the mic was forgotten on). */
export const SILENCE_STOP_MS = 20_000;
/** A dictation never runs longer than this (F7). */
export const HARD_CAP_MS = 10 * 60_000;
/** After `stop`, wait this long for the native `ended` before finalizing anyway. */
export const FINALIZE_TIMEOUT_MS = 1_500;

export const SILENCE_NOTICE = "dictation stopped after 20 s of silence";
export const CAP_NOTICE = "dictation stopped at 10 minutes";
export const INTERRUPTED_NOTICE = "dictation stopped (call or another app took the audio)";
export const ROUTE_NOTICE = "dictation stopped (audio route changed)";

export type SendVia = "return" | "press";

interface Text {
  /** The draft when dictation started: dictated text is appended to it. */
  readonly base: string;
  readonly finals: string;
  readonly volatile: string;
}

export type DictationState =
  | { readonly kind: "idle"; readonly notice?: string }
  | {
      readonly kind: "asking";
      readonly base: string;
      readonly locale: string;
      readonly caps?: Capabilities;
      /** The OS prompt was already shown in this attempt. */
      readonly asked: boolean;
    }
  | {
      readonly kind: "preparing";
      readonly base: string;
      readonly locale: string;
      readonly caps: Capabilities;
      readonly engine: Engine;
      readonly phase: "reserving" | "downloading" | "starting";
      /** What a granted reservation leads to. */
      readonly next: "start" | "download";
      /** Download progress 0..1 (phase `downloading`). */
      readonly download?: number;
    }
  | (Text & {
      readonly kind: "listening";
      readonly startedAt: number;
      readonly lastTextAt: number;
    })
  | (Text & {
      readonly kind: "finalizing";
      readonly after: "idle" | "send";
      readonly via?: SendVia;
      readonly since: number;
      readonly notice?: string;
    })
  | { readonly kind: "failed"; readonly view: MicView };

export const DICTATION_IDLE: DictationState = { kind: "idle" };

export type DictationEvent =
  | { readonly type: "tap"; readonly draft: string; readonly locale: string; readonly now: number }
  | { readonly type: "probed"; readonly caps: Capabilities }
  | { readonly type: "permissions"; readonly permissions: Permissions }
  | { readonly type: "reserved"; readonly ok: boolean }
  | { readonly type: "assetProgress"; readonly fraction: number }
  | { readonly type: "assetInstalled" }
  | { readonly type: "assetFailed" }
  | { readonly type: "started"; readonly now: number }
  | { readonly type: "startFailed"; readonly code?: string }
  | {
      readonly type: "dictation";
      readonly finalDelta: string;
      readonly volatile: string;
      readonly now: number;
    }
  | { readonly type: "ended"; readonly reason: EndedReason; readonly code?: string }
  | { readonly type: "userEdit"; readonly text: string }
  | { readonly type: "send"; readonly via: SendVia; readonly now: number }
  | { readonly type: "appState"; readonly state: "active" | "inactive" | "background" }
  | { readonly type: "tick"; readonly now: number }
  /** Read-aloud is about to speak (F11): stop listening first. */
  | { readonly type: "ttsStarting"; readonly now: number }
  | { readonly type: "dispose" };

export type DictationEffect =
  | { readonly type: "probe"; readonly locale: string }
  | { readonly type: "requestPermissions" }
  | { readonly type: "reserve"; readonly locale: string }
  | { readonly type: "installAsset"; readonly engine: Engine; readonly locale: string }
  | { readonly type: "start"; readonly engine: Engine; readonly locale: string }
  | { readonly type: "stop" }
  | { readonly type: "cancel" }
  | { readonly type: "setDraft"; readonly text: string }
  | { readonly type: "haptic"; readonly kind: "start" | "stop" | "error" }
  | { readonly type: "send"; readonly via: SendVia }
  | { readonly type: "stopSpeaking" };

export interface DictationStep {
  readonly state: DictationState;
  readonly effects: readonly DictationEffect[];
}

/**
 * Join two pieces of text: a single space between them, only when both are
 * non-empty and neither side already has whitespace at the seam.
 */
export function join(left: string, right: string): string {
  if (left === "" || right === "" || /\s$/.test(left) || /^\s/.test(right)) {
    return left + right;
  }
  return `${left} ${right}`;
}

/** What the field shows while listening: base + finals + volatile. */
export function draftOf(text: Text): string {
  return join(join(text.base, text.finals), text.volatile);
}

/** The text kept when volatile is dropped (an error keeps the finals only). */
function finalsOnly(text: Text): string {
  return join(text.base, text.finals);
}

/** A Send / Return goes to dictation (finalize first) instead of straight to the composer. */
export function capturesSend(state: DictationState): boolean {
  return state.kind === "listening" || state.kind === "finalizing" || state.kind === "preparing";
}

/** What the composer's mic button shows. */
export type MicButton = "idle" | "listening" | "preparing" | "hidden";

export function micButtonOf(state: DictationState, supported: boolean): MicButton {
  if (!supported) {
    return "hidden";
  }
  switch (state.kind) {
    case "listening":
    case "finalizing":
      return "listening";
    case "asking":
    case "preparing":
      return "preparing";
    default:
      return "idle";
  }
}

/** The line under the field while a model downloads ("…42 %"), else undefined. */
export function downloadLine(state: DictationState): string | undefined {
  if (state.kind !== "preparing" || state.phase !== "downloading") {
    return undefined;
  }
  const lang = localeName(state.locale) === "Italiano" ? "Italian" : "English";
  return `Downloading ${lang} speech model… ${Math.round((state.download ?? 0) * 100)} %`;
}

/** The card above the composer (failed), or the transient notice (idle). */
export function dictationCard(state: DictationState): MicView | undefined {
  return state.kind === "failed" ? state.view : undefined;
}

export function dictationNotice(state: DictationState): string | undefined {
  return state.kind === "idle" ? state.notice : undefined;
}
const DOWNLOAD_FAILED = (locale: string): MicView => ({
  action: "none",
  card: "unavailable",
  settings: false,
  message: `Couldn't download the ${localeName(locale)} speech model — tap the mic to retry`,
});

const START_FAILED: MicView = {
  action: "none",
  card: "unavailable",
  settings: false,
  message: "Dictation couldn't start — tap the mic to retry",
};

function failed(view: MicView, extra: DictationEffect[] = []): DictationStep {
  return {
    state: { kind: "failed", view },
    effects: [...extra, { type: "haptic", kind: "error" }],
  };
}

/** Permissions + capabilities known: ask, explain, or pick an engine. */
function decide(
  base: string,
  locale: string,
  caps: Capabilities,
  asked: boolean,
  reserveRefused = false,
): DictationStep {
  const view = micViewFor({ permissions: caps.permissions, tapped: true });
  if (view.action === "ask") {
    return asked
      ? // Asked once and still undetermined: the OS will not decide now. Back to idle.
        { state: DICTATION_IDLE, effects: [] }
      : {
          state: { kind: "asking", base, locale, caps, asked: true },
          effects: [{ type: "requestPermissions" }],
        };
  }
  if (view.action !== "start") {
    return failed(view);
  }
  const choice = chooseEngine(caps, locale, { reserveRefused });
  switch (choice.kind) {
    case "unavailable":
      return failed(
        micViewFor({
          permissions: caps.permissions,
          tapped: true,
          unavailable: { reason: choice.reason, locale },
        }),
      );
    case "needsDownload":
      return {
        state: {
          kind: "preparing",
          base,
          locale,
          caps,
          engine: choice.engine,
          phase: "reserving",
          next: "download",
        },
        effects: [{ type: "reserve", locale }],
      };
    case "engine":
      if (choice.engine === "recognizer") {
        return startNow(base, locale, caps, "recognizer");
      }
      return {
        state: {
          kind: "preparing",
          base,
          locale,
          caps,
          engine: choice.engine,
          phase: "reserving",
          next: "start",
        },
        effects: [{ type: "reserve", locale }],
      };
  }
}

function startNow(base: string, locale: string, caps: Capabilities, engine: Engine): DictationStep {
  return {
    state: { kind: "preparing", base, locale, caps, engine, phase: "starting", next: "start" },
    // Never transcribe our own voice: read-aloud stops BEFORE the mic opens (F11).
    effects: [{ type: "stopSpeaking" }, { type: "start", engine, locale }],
  };
}

/** Promote everything shown (volatile included) and settle in idle — or send. */
function settle(
  text: Text,
  after: "idle" | "send",
  via: SendVia | undefined,
  notice: string | undefined,
): DictationStep {
  const final = draftOf(text);
  const effects: DictationEffect[] = [
    { type: "setDraft", text: final },
    { type: "haptic", kind: "stop" },
  ];
  if (after === "send") {
    effects.push({ type: "send", via: via ?? "press" });
  }
  return { state: notice === undefined ? DICTATION_IDLE : { kind: "idle", notice }, effects };
}

function finalize(
  state: Text,
  now: number,
  after: "idle" | "send",
  via?: SendVia,
  notice?: string,
): DictationStep {
  const { base, finals, volatile } = state;
  return {
    state: {
      kind: "finalizing",
      base,
      finals,
      volatile,
      after,
      since: now,
      ...(via === undefined ? {} : { via }),
      ...(notice === undefined ? {} : { notice }),
    },
    effects: [{ type: "stop" }],
  };
}

export function dictationReduce(state: DictationState, event: DictationEvent): DictationStep {
  const none: DictationStep = { state, effects: [] };
  switch (state.kind) {
    case "idle":
    case "failed":
      if (event.type === "tap") {
        return {
          state: { kind: "asking", base: event.draft, locale: event.locale, asked: false },
          effects: [{ type: "probe", locale: event.locale }],
        };
      }
      if (event.type === "appState" && event.state === "active" && state.kind === "failed") {
        // A grant in Settings is picked up on return: the card goes; the next tap re-reads (F2).
        return { state: DICTATION_IDLE, effects: [] };
      }
      return none;

    case "asking":
      switch (event.type) {
        case "probed":
          return decide(state.base, state.locale, event.caps, state.asked);
        case "permissions":
          // A denial mid-request never leaves us here: the states re-derive (F2).
          return state.caps === undefined
            ? { state: DICTATION_IDLE, effects: [] }
            : decide(
                state.base,
                state.locale,
                { ...state.caps, permissions: event.permissions },
                true,
              );
        case "startFailed":
          // The capabilities read or the permission request itself threw.
          return failed(START_FAILED);
        case "tap":
        case "dispose":
        case "ttsStarting":
          return { state: DICTATION_IDLE, effects: [] };
        case "appState":
          return event.state === "active" ? none : { state: DICTATION_IDLE, effects: [] };
        case "send":
          return { state: DICTATION_IDLE, effects: [{ type: "send", via: event.via }] };
        default:
          return none;
      }

    case "preparing":
      switch (event.type) {
        case "reserved":
          if (!event.ok) {
            // At the reserved-locale cap (F5): the next engine in order, else unavailable.
            return decide(state.base, state.locale, state.caps, true, true);
          }
          return state.next === "download"
            ? {
                state: { ...state, phase: "downloading", download: 0 },
                effects: [{ type: "installAsset", engine: state.engine, locale: state.locale }],
              }
            : startNow(state.base, state.locale, state.caps, state.engine);
        case "assetProgress":
          return state.phase === "downloading"
            ? { state: { ...state, download: event.fraction }, effects: [] }
            : none;
        case "assetInstalled":
          return state.phase === "downloading"
            ? startNow(state.base, state.locale, state.caps, state.engine)
            : none;
        case "assetFailed":
          return state.phase === "downloading" ? failed(DOWNLOAD_FAILED(state.locale)) : none;
        case "started":
          if (state.phase !== "starting") {
            return none;
          }
          return {
            state: {
              kind: "listening",
              base: state.base,
              finals: "",
              volatile: "",
              startedAt: event.now,
              lastTextAt: event.now,
            },
            effects: [{ type: "haptic", kind: "start" }],
          };
        case "startFailed":
        case "ended":
          if (event.type === "ended" && event.reason === "cancelled") {
            return { state: DICTATION_IDLE, effects: [] };
          }
          return failed(
            event.code === "not-on-device"
              ? micViewFor({
                  permissions: state.caps.permissions,
                  tapped: true,
                  unavailable: { reason: "no-on-device-model", locale: state.locale },
                })
              : START_FAILED,
          );
        case "tap":
        case "dispose":
        case "ttsStarting":
          // A download in progress continues in the system; nothing listens.
          return { state: DICTATION_IDLE, effects: [{ type: "cancel" }] };
        case "appState":
          return event.state === "active"
            ? none
            : { state: DICTATION_IDLE, effects: [{ type: "cancel" }] };
        case "send":
          return {
            state: DICTATION_IDLE,
            effects: [{ type: "cancel" }, { type: "send", via: event.via }],
          };
        default:
          return none;
      }

    case "listening":
    case "finalizing":
      return active(state, event);
  }
}

type Active = Extract<DictationState, { kind: "listening" | "finalizing" }>;

/** Listening or finalizing: text arrives, the person edits, sends, or it ends. */
function active(state: Active, event: DictationEvent): DictationStep {
  const none: DictationStep = { state, effects: [] };
  const finalizing = state.kind === "finalizing" ? state : undefined;
  switch (event.type) {
    case "dictation": {
      const finals = join(state.finals, event.finalDelta);
      // Volatile REPLACES the previous volatile; it is never appended.
      const next = { ...state, finals, volatile: event.volatile };
      const grew =
        event.finalDelta.trim() !== "" ||
        (event.volatile !== state.volatile && event.volatile.trim() !== "");
      const moved = next.kind === "listening" && grew ? { ...next, lastTextAt: event.now } : next;
      const before = draftOf(state);
      const after = draftOf(moved);
      return { state: moved, effects: after === before ? [] : [{ type: "setDraft", text: after }] };
    }
    case "userEdit":
      if (event.text === draftOf(state)) {
        // Our own `setDraft` echoing back through the field.
        return none;
      }
      // The person typed: their text wins, pending volatile is dropped (F8).
      return { state: DICTATION_IDLE, effects: [{ type: "cancel" }] };
    case "send":
      if (finalizing !== undefined) {
        return { state: { ...finalizing, after: "send", via: event.via }, effects: [] };
      }
      return finalize(state, event.now, "send", event.via);
    case "tap":
    case "ttsStarting":
      return finalizing !== undefined ? none : finalize(state, event.now, "idle");
    case "tick":
      if (finalizing !== undefined) {
        return event.now - finalizing.since >= FINALIZE_TIMEOUT_MS
          ? withCancel(settle(finalizing, finalizing.after, finalizing.via, finalizing.notice))
          : none;
      }
      if (state.kind === "listening" && event.now - state.startedAt >= HARD_CAP_MS) {
        return finalize(state, event.now, "idle", undefined, CAP_NOTICE);
      }
      if (state.kind === "listening" && event.now - state.lastTextAt >= SILENCE_STOP_MS) {
        return finalize(state, event.now, "idle", undefined, SILENCE_NOTICE);
      }
      return none;
    case "ended":
      switch (event.reason) {
        case "cancelled":
          return { state: DICTATION_IDLE, effects: [] };
        case "error":
          // Finals are kept; the unconfirmed volatile is not.
          return failed(START_FAILED, [{ type: "setDraft", text: finalsOnly(state) }]);
        case "interrupted":
        case "route": {
          const notice = event.reason === "route" ? ROUTE_NOTICE : INTERRUPTED_NOTICE;
          // An interruption never sends: the person did not finish.
          return settle(state, "idle", undefined, notice);
        }
        case "stopped":
          return finalizing !== undefined
            ? settle(finalizing, finalizing.after, finalizing.via, finalizing.notice)
            : settle(state, "idle", undefined, undefined);
      }
      return none;
    case "appState":
      if (event.state === "active") {
        return none;
      }
      // Backgrounded / locked (F6): stop and keep everything shown; never send.
      return withStop(settle(state, "idle", undefined, undefined));
    case "dispose":
      return { state: DICTATION_IDLE, effects: [{ type: "cancel" }] };
    default:
      return none;
  }
}

function withCancel(step: DictationStep): DictationStep {
  return { state: step.state, effects: [{ type: "cancel" }, ...step.effects] };
}

function withStop(step: DictationStep): DictationStep {
  return { state: step.state, effects: [{ type: "stop" }, ...step.effects] };
}
