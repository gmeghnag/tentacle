/**
 * `turn-profile.ts` — what a VOICE turn asks of the model
 * (docs/feat/voice-conversation.md §4, C3; T6's daemon half).
 *
 * The edge that sent the turn is a person who is LISTENING, not reading, so a
 * voice turn gets two things on its outgoing requests, and neither may ever
 * reach the history or the disk (F10):
 *
 *  - **(b) the spoken-style line**, on every round of the voice turn. It is a
 *    `system` line of the REQUEST only: the agent adds it to the model's copy
 *    exactly as it renders a context line, so the stored history, the session
 *    log and the `serve` store never carry it.
 *  - **(a) `reasoning: "off"`**, while the turn has not called a tool yet: a
 *    spoken reply wants an answer NOW, not a long think. The FIRST tool call
 *    ends that window (the work is real, so it reasons as configured) and it
 *    never re-opens — a deterministic rule, not a timer.
 *
 * Pure, React-free, I/O-free: the loop calls `voiceReasoning()` /
 * `withSpokenLine()` and passes the result to the provider; everything testable
 * lives here.
 */
import type { ChatMessage, VoiceReasoning } from "../model.ts";

/**
 * What an edge puts on a turn it sent from voice mode (docs/feat/voice-conversation.md
 * §4, C3): the edge's OWN setting, read at send time. Structurally the protocol's
 * `VoiceTurn` (`packages/protocol/src/session.ts:331`) — core cannot import the
 * schema's type here without a cycle of meaning, and the two are the same shape
 * by contract, like `ChatMessage` and `WireChatMessage`.
 */
export interface VoiceTurn {
  readonly reasoning: VoiceReasoning;
}

/** The transient line a voice turn's requests carry (never stored, F10). */
export const VOICE_SPOKEN_LINE =
  "The user is listening, not reading: short spoken sentences, a short first sentence, " +
  "no code blocks unless asked.";

/**
 * Whether a voice turn is still in its "answer fast" window: no tool call has
 * happened yet. Once one has, the turn reasons as configured.
 */
export interface VoiceTurnState {
  /** The edge's own setting, read at send time (§4). */
  readonly reasoning: VoiceReasoning;
  /** Whether a tool call has already run in this turn. */
  readonly toolCalled: boolean;
}

/**
 * The `reasoning` a request of this voice turn carries: `"off"` while the
 * window is open, absent otherwise (the configured reasoning — there is no
 * field for "keep", so a provider that reasons by default simply does).
 */
export function voiceReasoning(voice: VoiceTurnState): "off" | undefined {
  return voice.reasoning === "off" && !voice.toolCalled ? "off" : undefined;
}

/**
 * The request's message list with the spoken-style line on it: the LINE ONLY on
 * the model's copy — the history it came from is never touched.
 *
 * It goes right AFTER the leading system prompt (or first, with none): an
 * OpenAI-compatible template reads its system block from the head, and the line
 * is identical on every round of the turn, so a provider's prompt cache still
 * holds the whole turn's prefix. Already there → not added twice.
 */
export function withSpokenLine(messages: readonly ChatMessage[]): ChatMessage[] {
  if (messages.some((m) => m.role === "system" && m.content === VOICE_SPOKEN_LINE)) {
    return [...messages];
  }
  const line: ChatMessage = { role: "system", content: VOICE_SPOKEN_LINE };
  const head = messages[0]?.role === "system" ? 1 : 0;
  return [...messages.slice(0, head), line, ...messages.slice(head)];
}
