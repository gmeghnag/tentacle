/**
 * A model reply that stopped early, and a turn that produced nothing
 * (docs/fix/truncated-reply-silent.md).
 *
 * Two different facts with two different remedies, so two sentences:
 * - `truncated_reply` — the model's answer was cut at its output limit
 *   (`finish_reason: "length"`, `max_tokens`). The text is real work, just
 *   unfinished; the loop re-asks once, and this says so.
 * - `empty_turn` — the model returned nothing at all, repeatedly, and the
 *   loop's bounded nudges ran out. Before this notice the turn ended in
 *   silence and the TUI looked hung.
 *
 * The wording is built here, once, so the TUI and the plain CLI cannot drift:
 * presentation is the components' job, wording is not (AGENTS §7). No React,
 * no I/O — the error type for a cut stream lives here too, beside its wording.
 */

/** Why a reply was cut, as the wire carries it. */
export type TruncationReason = "length" | "cut";

/** What is known about the cut reply when its notice is written. */
export interface TruncationContext {
  /** Whether any of the reply's text reached the user. */
  readonly answered: boolean;
  /** Whether the loop is re-asking the model once, from where it stopped. */
  readonly retrying: boolean;
}

/**
 * The one user-facing line for a cut reply. Names the limit (the owner's
 * incident was a server slot `n_ctx` far below the configured window) and says
 * what happens NEXT, because a silent partial answer is the bug being fixed.
 */
export function describeTruncation(reason: TruncationReason, context: TruncationContext): string {
  if (reason === "cut") {
    return context.answered
      ? "the model's stream was cut before it finished — this answer is incomplete"
      : "the model's stream was cut before it produced anything";
  }
  const what = context.answered
    ? "the reply was cut at the model's output limit — this answer is incomplete"
    : "the model returned nothing: it hit its output limit before writing anything";
  return context.retrying ? `${what}; asking it to continue` : what;
}

/** The one user-facing line for a turn that ended with the model saying nothing. */
export function describeEmptyTurn(): string {
  return (
    "the model returned an empty reply and did not continue when asked — " +
    "nothing was produced for this turn (check the model's context window and the server's logs)"
  );
}

/** What a cut tool call looked like, for the error's message (never the args). */
export interface CutToolCallInfo {
  readonly toolCalls: number;
  readonly argumentBytes: number;
}

/**
 * Thrown by the agent loop when a reply was CUT, so the turn fails loudly
 * instead of presenting partial data as an answer:
 *
 * - `no-stop-reason` — the provider's stream carried NO stop reason, so the
 *   body ended mid-reply (owner Q2a). Text already streamed is kept in the
 *   history; the turn is an error.
 * - `cut-tool-call` — the reply was cut at the output limit WHILE emitting a
 *   tool call, so its arguments may be partial JSON (measured: 17 rounds on
 *   one cut call). The call is never run. Same refusal `AnthropicProvider`
 *   already makes for its own wire (`TRUNCATING_STOP_REASONS`), now both ways.
 *
 * A `length` reply carrying only text is NOT this error: it is real, unfinished
 * work, so the loop keeps the text, shows the notice and re-asks once.
 */
export class ModelStreamCutError extends Error {
  constructor(
    /** Which cut this is. */
    readonly kind: "no-stop-reason" | "cut-tool-call",
    /** Whether text had been streamed (it is kept), for the message. */
    readonly answered: boolean,
    /** For `cut-tool-call`: what was refused. */
    readonly toolCall?: CutToolCallInfo,
  ) {
    super(ModelStreamCutError.message(kind, answered, toolCall));
    this.name = "ModelStreamCutError";
  }

  private static message(
    kind: "no-stop-reason" | "cut-tool-call",
    answered: boolean,
    toolCall: CutToolCallInfo | undefined,
  ): string {
    if (kind === "cut-tool-call" && toolCall) {
      const n = toolCall.toolCalls === 1 ? "a tool call" : `${toolCall.toolCalls} tool calls`;
      return (
        `the reply was cut at the model's output limit while emitting ${n}: ` +
        `${toolCall.argumentBytes} bytes of arguments, possibly partial JSON — the call was not run`
      );
    }
    return answered
      ? "the model's stream was cut before the reply finished (no stop reason) — the answer is incomplete"
      : "the model's stream was cut before it produced a reply (no stop reason)";
  }
}
