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

/**
 * The tag that opens one argument of the call. The space after the bar is
 * optional and any attributes are allowed (`parameter name="fs_write"`,
 * `parameter name="content" string="true"`): both are the template's own bytes.
 */
const PARAMETER_OPEN = new RegExp(`<${BAR}DSML${BAR}\\s*parameter(?:\\s[^<>]*)?>`);
/** Any of the block's closing tags: `parameter`, `invoke` or `calls`. */
const BLOCK_CLOSE = new RegExp(`</${BAR}DSML${BAR}\\s*(?:parameter|invoke|calls)\\s*>`);

/**
 * True when `text` carries a DSML tool-call block: an opening parameter tag
 * (with its attributes) and, after it, one of the block's closing tags.
 *
 * Anchored on the PARAMETER tag, not on an opening invoke tag: the incident's
 * reply had no opening invoke at all (only `parameter` tags, then `</ invoke>`
 * and `</ calls>`) and would have slipped through the guard entirely
 * (docs/fix/deepseek-dsml-leak.md, Review HIGH-1). Requiring both an opening
 * parameter tag and a closer — never a bare `DSML` mention or one orphan tag —
 * keeps ordinary prose (and a block truncated mid-write, which the next round
 * replaces) from being refused.
 */
export function hasDsmlToolCallMarkup(text: string): boolean {
  const open = PARAMETER_OPEN.exec(text);
  if (open === null) {
    return false;
  }
  const rest = text.slice(open.index + open[0].length);
  return BLOCK_CLOSE.test(rest);
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
