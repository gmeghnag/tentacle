/**
 * Auto-stop endpointing for V1's DICTATION (`feat/voice-dictation` §4), as a
 * THIN ADAPTER over the ONE edge-neutral fold in `@tentacle/core`
 * (`core/src/voice/endpoint.ts`).
 *
 * History: this file used to hold its own copy of the fold. V2's C2 moved the
 * fold to core (`docs/feat/voice-conversation.md` §3) so the Mac's conversation
 * mode and the phone share it, which left TWO implementations of the same rule —
 * review round 1's finding 5. There is now one: this module keeps V1's
 * dictation-flavoured INPUT shape (a Silero probability per window plus the
 * per-call options `voice-session.ts` already passes) and translates it, so the
 * V1 regression suite (`test/voice-endpoint.test.ts`) still pins the comma rule
 * — end to end, against the shared fold.
 *
 * The one finding the shared fold encodes (V0 `:718-735`, re-measured in V1's
 * S1): a pause after a comma is 96–224 ms and Smart Turn rates the cut half as
 * complete as a whole sentence (0.86–0.98 vs 0.977–0.987). **A threshold cannot
 * separate them; only a silence FLOOR above the comma pause can.** With
 * dictation's manual stop this fold is an optional convenience, so the floor
 * defaults high (500 ms, over the longest measured comma pause of 224 ms).
 */
import {
  type EndpointAction,
  type EndpointState,
  foldEndpoint as coreFoldEndpoint,
} from "@tentacle/core";

export type { EndpointAction, EndpointState } from "@tentacle/core";

/** V1's dictation settings. `autoStopSilenceMs` is the measured comma-safe floor. */
export const ENDPOINT_DEFAULTS = {
  /** Off: the user ends the dictation with the key, so a pause can never cut it. */
  autoStop: false,
  /**
   * 500 ms: above the longest comma pause measured on the V0 set (224 ms) with
   * one 32 ms window of margin, and comfortably above the 300 ms minimum the
   * config refuses to go under.
   */
  autoStopSilenceMs: 500,
  /** Smart Turn's own cut-off: a segment it rates this complete ends the turn. */
  threshold: 0.5,
  /**
   * Continuous silence that ends a forgotten dictation — **inside the auto-stop
   * branch only**. With auto-stop off a pause must never end the dictation
   * (Owner decision 2); there `voice.maxSeconds` is the cap that ends it
   * (Review round 2, NEW-1: applying it unconditionally cut every dictation
   * after a 3 s thinking pause).
   */
  hardStopMs: 3000,
} as const;

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
      /** The forgotten-dictation cap; ignored unless `autoStop` is true. */
      readonly hardStopMs?: number;
    }
  | { readonly kind: "turnp"; readonly p: number; readonly threshold: number };

export interface EndpointStep {
  readonly state: EndpointState;
  readonly action: EndpointAction;
}

/** Above this Silero probability a window counts as speech (V0's `vad.thresh`). */
const SPEECH_P = 0.5;

/**
 * Dictation always consults Smart Turn (`turnModel: true`): the phone's
 * "no new text" rule is the conversation mode's, not the dictation key's.
 */
function configOf(input: EndpointInput) {
  return input.kind === "turnp"
    ? {
        autoStop: true,
        floorMs: 0,
        threshold: input.threshold,
        hardStopMs: Number.POSITIVE_INFINITY,
        turnModel: true,
      }
    : {
        autoStop: input.autoStop,
        floorMs: input.floorMs,
        threshold: input.threshold,
        hardStopMs: input.hardStopMs ?? Number.POSITIVE_INFINITY,
        turnModel: true,
      };
}

function step(state: EndpointState, input: EndpointInput): EndpointStep {
  const config = configOf(input);
  const coreInput =
    input.kind === "turnp"
      ? ({ kind: "turnp", p: input.p } as const)
      : ({
          kind: "window",
          ms: input.ms,
          speech: input.p >= SPEECH_P,
          // The phone's text rule does not apply to a dictation (turnModel true).
          textGrew: false,
        } as const);
  return coreFoldEndpoint.step(state, coreInput, config);
}

/** V1's fold, unchanged in behaviour, delegating to the shared one in core. */
export const foldEndpoint = {
  init: (): EndpointState => coreFoldEndpoint.init(),
  step,
};
