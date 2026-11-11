/**
 * DeepSeek's DSML tool-call markup leaking into an answer
 * (`docs/fix/deepseek-dsml-leak.md`).
 *
 * DeepSeek's chat template renders a tool call in its own DSML tags. A server
 * that fails to parse them back into `tool_calls` hands the raw markup to the
 * client as ordinary `content` text, so the turn "ends" with a final answer
 * that is really an unexecuted tool call: the model is refused and asked once
 * more, never accepted and never retried without bound.
 *
 * Deliberately narrow: ONLY the DSML tool-call block is recognised. Other
 * markup families (Hermes `<tool_call>`, Anthropic XML, …) are not guessed at;
 * adding one is a separate decision with its own evidence.
 */
const BAR = "\uFF5C";

/** The opening `<｜DSML｜invoke>` and the closing tag, spelled as the template does. */
const INVOKE_OPEN = `<${BAR}DSML${BAR} invoke>`;
const INVOKE_CLOSE = `</${BAR}DSML${BAR} invoke>`;
/** The tag that opens each argument of the call. */
const PARAMETER_OPEN = `${BAR}DSML${BAR} parameter`;

/**
 * True when `text` carries a whole DSML tool-call block: an opening invoke tag,
 * at least one parameter tag, and the closing invoke tag. Requiring the full
 * shape — never a bare `DSML` mention or one orphan tag — keeps ordinary prose
 * (and a truncated block, which the next round replaces) from being refused.
 */
export function hasDsmlToolCallMarkup(text: string): boolean {
  const invoke = text.indexOf(INVOKE_OPEN);
  if (invoke < 0) {
    return false;
  }
  const close = text.indexOf(INVOKE_CLOSE, invoke + INVOKE_OPEN.length);
  if (close < 0) {
    return false;
  }
  return text.slice(invoke, close).includes(PARAMETER_OPEN);
}

/**
 * The model-facing note for the one re-ask: it names what went wrong and the
 * mechanism to use, so the next round can emit a real tool call.
 */
export const DSML_REASK_NOTE =
  "Your reply was not an answer: it contained a tool call written as DSML text, which cannot be executed. Use the tool-calling mechanism, or answer in prose.";

/**
 * Thrown by a provider when a completed reply is a DSML tool call in text form
 * and no real tool call was streamed (`openai-provider.ts`). The agent loop
 * catches it, re-asks ONCE, and fails the turn if it happens again — the text
 * is never stored as the assistant's answer.
 */
export class DsmlToolCallLeakError extends Error {
  constructor(
    /** Bytes of the leaked text, for the log; the text itself is not carried. */
    readonly bytes: number,
  ) {
    super(
      `the model emitted a tool call as DSML text instead of calling the tool (${bytes} bytes) — not accepted as an answer`,
    );
    this.name = "DsmlToolCallLeakError";
  }
}
