/**
 * The live notice for a running background child's message to the agent
 * (docs/feat/agent-message-two-way.md, Design 7): one line, the first line of
 * the text, bounded. Pure — the component paints the string this returns, and
 * a `.tsx` render path is what the TUI harness cannot test (§7).
 *
 * The input is what the client already bounded (control characters stripped,
 * 8 000 characters): this only picks the first line and cuts it for a row.
 */

/** What this module reads of a notice (mirrors the client's, like a row's). */
export interface SubagentNotifyView {
  readonly agentId: string;
  readonly text: string;
  readonly wake: boolean;
}

/** How much of the first line a notice shows. */
export const SUBAGENT_NOTIFY_MAX = 200;

/** What a message with no visible text reads as (an honest placeholder). */
const NO_TEXT = "(no text)";

/** `sa-1 → agent: <first line, cut to 200 characters with an ellipsis>`. */
export function subagentNotifyNotice(notify: SubagentNotifyView): string {
  // The FIRST line, then the control characters (a newline inside it would be
  // one of them): a terminal must never receive an escape, and a row shows one line.
  const first = notify.text.split("\n")[0] ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a terminal must never receive one
  const clean = first.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  const body = clean === "" ? NO_TEXT : clean;
  const cut =
    body.length > SUBAGENT_NOTIFY_MAX ? `${body.slice(0, SUBAGENT_NOTIFY_MAX - 1)}…` : body;
  return `${notify.agentId} → agent: ${cut}`;
}
