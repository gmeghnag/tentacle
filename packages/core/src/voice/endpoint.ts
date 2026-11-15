/**
 * The EDGE-NEUTRAL end-of-turn fold (docs/feat/voice-conversation.md §3, C2).
 *
 * One fold, two edges, because both must reach the same verdict from the signals
 * their platform actually gives:
 *
 * - **Mac** (`turnModel: true`): at the floor, ask Smart Turn about the candidate
 *   segment. `turnP ≥ threshold` ends the turn; a "not finished" verdict keeps
 *   listening (and the silence keeps accumulating, so the next window asks again).
 * - **Phone** (`turnModel: false`): `SFSpeechRecognizer` exposes no turn model,
 *   so the rule is "**no new recognised text** for the floor". A slow recogniser
 *   that is still producing words is still producing the utterance, so a
 *   `textGrew` window restarts the silence clock — that is the phone's whole
 *   comma protection (F2), and dropping it cuts at every pause.
 *
 * Everything is in AUDIO time, injected by the caller: no clock is read, so the
 * same trace always yields the same verdict and the comma regression is a `bun
 * test` rather than a recording session.
 *
 * The comma finding this encodes is V1's (`feat/voice-dictation` S1, V0
 * `realtime-media.md:718-735`): a pause after a comma is 96–224 ms, and Smart
 * Turn rates the cut half as complete as a whole sentence — so **a threshold
 * cannot separate them and only a silence floor above the pause can**. Default
 * 500 ms = 224 + one 32 ms window of margin.
 */

/** The per-edge defaults (§3: "Defaults are per edge"). */
export const ENDPOINT_EDGE_DEFAULTS = {
  /** The Mac: V1's helper, with Smart Turn and the shipped comma-safe floor. */
  mac: {
    /** Conversation mode sends on its own (owner Q3); dictation is V1's own fold. */
    autoStop: true,
    floorMs: 500,
    threshold: 0.5,
    hardStopMs: 3000,
    turnModel: true,
  },
  /**
   * The phone: `SFSpeechRecognizer`, no turn model. The floor is P1-pinned on the
   * device; 500 ms is the comma-safe base V1 measured, so the shipped default can
   * only be raised by the spike, never silently lowered under the commas.
   */
  phone: {
    autoStop: true,
    floorMs: 500,
    threshold: 0.5,
    hardStopMs: 3000,
    turnModel: false,
  },
} as const satisfies Record<string, EndpointConfig>;

export interface EndpointConfig {
  /** Off: nothing on silence ends the turn, not the floor and not the hard stop. */
  readonly autoStop: boolean;
  /** Silence required before a candidate is raised. */
  readonly floorMs: number;
  /** Smart Turn's cut-off (only read when `turnModel` is true). */
  readonly threshold: number;
  /** Continuous silence that ends a forgotten turn (auto-stop branch only). */
  readonly hardStopMs: number;
  /** True: ask Smart Turn (`turnp`). False: the `textGrew` rule. */
  readonly turnModel: boolean;
}

/** What the edge does next: nothing, ask Smart Turn, or close the utterance. */
export type EndpointAction = "none" | "askTurn" | "stop";

/** The fold's state: what has been heard so far. */
export interface EndpointState {
  /** No speech-positive window yet: no candidate can be raised. */
  readonly speaking: boolean;
  /** Silence accumulated since the last speech (or the last fresh text). */
  readonly silentMs: number;
  /** Total silence since the last speech, for the hard stop (never reset by a candidate). */
  readonly unbrokenSilentMs: number;
  /** A candidate was raised and Smart Turn's answer is still awaited. */
  readonly awaitingTurnp: boolean;
  /** The verdict already taken: `stop` is terminal for this utterance. */
  readonly stopped: boolean;
}

/** One input: an audio window, or Smart Turn's answer to a raised candidate. */
export type EndpointInput =
  | {
      readonly kind: "window";
      /** The window's duration in AUDIO ms (32 for the shipped model). */
      readonly ms: number;
      /** Speech positive (the level gate or the recogniser's own verdict). */
      readonly speech: boolean;
      /** The recogniser produced new text in this window (phone rule). */
      readonly textGrew?: boolean;
    }
  | { readonly kind: "turnp"; readonly p: number };

/** The fold's two operations: start, and one step. */
export const foldEndpoint = {
  init(): EndpointState {
    return {
      speaking: false,
      silentMs: 0,
      unbrokenSilentMs: 0,
      awaitingTurnp: false,
      stopped: false,
    };
  },

  step(
    state: EndpointState,
    input: EndpointInput,
    config: EndpointConfig,
  ): { readonly state: EndpointState; readonly action: EndpointAction } {
    if (state.stopped) return { state, action: "none" };

    if (input.kind === "turnp") {
      // Only a raised candidate has an answer to give; a stray verdict is noise.
      if (!state.awaitingTurnp || !config.turnModel) return { state, action: "none" };
      const answered: EndpointState = { ...state, awaitingTurnp: false };
      return input.p >= config.threshold
        ? { state: { ...answered, stopped: true }, action: "stop" }
        : { state: answered, action: "none" };
    }

    if (input.speech) {
      // Speech: the candidate continues, and every silence counter restarts.
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

    // The phone rule: fresh recognised text means the utterance is still being
    // produced, whatever the audio level says. Restarts the candidate's clock.
    const grew = input.textGrew === true && !config.turnModel;
    const silentMs = grew ? 0 : state.silentMs + input.ms;
    const unbrokenSilentMs = state.unbrokenSilentMs + input.ms;
    const heard: EndpointState = {
      ...state,
      silentMs,
      unbrokenSilentMs,
      awaitingTurnp: grew ? false : state.awaitingTurnp,
    };

    // Auto-stop off: NOTHING on silence ends the turn — not the floor, and not
    // the hard stop (V1 review round 2, NEW-1: reading the hard stop first cut a
    // dictation after a 3 s thinking pause).
    if (!config.autoStop) return { state: heard, action: "none" };

    // With auto-stop ON the hard stop comes first: a forgotten turn must end even
    // when the floor is unreachable.
    if (unbrokenSilentMs >= config.hardStopMs) {
      return { state: { ...heard, stopped: true }, action: "stop" };
    }
    if (silentMs < config.floorMs) return { state: heard, action: "none" };

    if (!config.turnModel) {
      // The phone: the floor with no fresh text IS the verdict.
      return { state: { ...heard, stopped: true }, action: "stop" };
    }
    // The Mac: ask Smart Turn; its answer arrives as the next input, and the
    // silence keeps accumulating until it does.
    if (state.awaitingTurnp) return { state: heard, action: "none" };
    return { state: { ...heard, awaitingTurnp: true }, action: "askTurn" };
  },
};
