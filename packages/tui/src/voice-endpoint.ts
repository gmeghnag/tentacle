/**
 * Auto-stop endpointing, as a PURE fold over the helper's `vad`/`turnp` lines
 * (docs/feat/voice-dictation.md §4). No clocks, no React, no I/O: every input
 * carries its own duration in AUDIO time, so the same trace always yields the
 * same verdict and the comma regression is testable in `bun test`.
 *
 * Why it lives here and not in Swift: this is where the repo's gate runs, this is
 * where the comma regression lives (`voice-endpoint.test.ts` T3), and V2's
 * hands-free loop and a later phone app reuse it unchanged.
 *
 * The one finding it encodes (V0 `:718-735`, re-measured in this task's S1): a
 * pause after a comma is 96–224 ms and Smart Turn rates the cut half as complete
 * as a whole sentence (0.86–0.98 vs 0.977–0.987). **A threshold cannot separate
 * them; only a silence FLOOR above the comma pause can.** With dictation's
 * manual stop this fold is an optional convenience, so the floor defaults high
 * (500 ms, over the longest measured comma pause of 224 ms).
 */

/** The shipped defaults. `autoStopSilenceMs` is the measured comma-safe floor. */
export const ENDPOINT_DEFAULTS = {
  /** Off: the user ends the dictation with the key, so a pause can never cut it. */
  autoStop: false,
  /**
   * 500 ms: above the longest comma pause measured on the V0 set (224 ms) with
   * one 32 ms window of margin, and comfortably above the 300 ms minimum the
   * config refuses to go under. The plan's provisional 1000 ms was safe but
   * doubled the wait for no measured benefit.
   */
  autoStopSilenceMs: 500,
  /** Smart Turn's own cut-off: a segment it rates this complete ends the turn. */
  threshold: 0.5,
  /** Continuous silence that ends a forgotten dictation, whatever the above say. */
  hardStopMs: 3000,
} as const;

/** The fold's state: what has been heard so far. */
export interface EndpointState {
  /** Still no speech-positive window: the candidate has not begun. */
  readonly speaking: boolean;
  /** Silence accumulated since the last speech, in ms. */
  readonly silentMs: number;
  /** Total silence since the last speech, for the hard stop (never reset by a candidate). */
  readonly unbrokenSilentMs: number;
  /** A candidate was raised and its Smart Turn answer is still awaited. */
  readonly awaitingTurnp: boolean;
  /** The verdict already taken (a fold is one dictation; `stop` is terminal). */
  readonly stopped: boolean;
}

/** What the App does next: nothing, ask Smart Turn, or finish the dictation. */
export type EndpointAction = "none" | "askTurn" | "stop";

export interface EndpointStep {
  readonly state: EndpointState;
  readonly action: EndpointAction;
}

/** One input to the fold: a VAD window (with its duration) or a Smart Turn answer. */
export type EndpointInput =
  | {
      readonly kind: "window";
      /** The window's duration in AUDIO ms (32 for the shipped model). */
      readonly ms: number;
      /** Silero's speech probability for this window. */
      readonly p: number;
      readonly autoStop: boolean;
      readonly floorMs: number;
      readonly threshold: number;
      readonly hardStopMs?: number;
    }
  | { readonly kind: "turnp"; readonly p: number; readonly threshold: number };

/** Above this Silero probability a window counts as speech (V0's `vad.thresh`). */
const SPEECH_P = 0.5;

function initState(): EndpointState {
  return {
    speaking: false,
    silentMs: 0,
    unbrokenSilentMs: 0,
    awaitingTurnp: false,
    stopped: false,
  };
}

function step(state: EndpointState, input: EndpointInput): EndpointStep {
  if (state.stopped) return { state, action: "none" };

  if (input.kind === "turnp") {
    if (!state.awaitingTurnp) return { state, action: "none" };
    const answered: EndpointState = { ...state, awaitingTurnp: false };
    return input.p >= input.threshold
      ? { state: { ...answered, stopped: true }, action: "stop" }
      : { state: answered, action: "none" };
  }

  if (input.p >= SPEECH_P) {
    // Speech: the candidate continues and every silence counter restarts.
    return {
      state: {
        speaking: true,
        silentMs: 0,
        unbrokenSilentMs: 0,
        awaitingTurnp: false,
        stopped: false,
      },
      action: "none",
    };
  }

  if (!state.speaking) return { state, action: "none" };

  const silentMs = state.silentMs + input.ms;
  const unbrokenSilentMs = state.unbrokenSilentMs + input.ms;
  const heard: EndpointState = { ...state, silentMs, unbrokenSilentMs };

  // The hard stop first: a forgotten dictation must end even when the floor is
  // unreachable (or auto-stop is off but the caller asked for a cap).
  if (input.hardStopMs !== undefined && unbrokenSilentMs >= input.hardStopMs) {
    return { state: { ...heard, stopped: true }, action: "stop" };
  }

  if (!input.autoStop) return { state: heard, action: "none" };
  if (silentMs < input.floorMs) return { state: heard, action: "none" };
  if (state.awaitingTurnp) return { state: heard, action: "none" };

  // The floor is reached: ask Smart Turn whether the turn actually ended. Its
  // answer arrives as the next input, so the silence keeps accumulating until it
  // does (a "not finished" verdict resumes after the next speech).
  return { state: { ...heard, awaitingTurnp: true }, action: "askTurn" };
}

export const foldEndpoint = { init: initState, step };
