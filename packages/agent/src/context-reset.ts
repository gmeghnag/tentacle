/**
 * The model's context reset (docs/feat/context-reset-barrier.md) — pure.
 *
 * The restart message is the first user message of a reset history: this
 * header, then the model's restart prompt in a `<restart_prompt>` block, then
 * whatever tentacle appends (running jobs, the skills note, a usage line).
 * `restartPromptOf` reads it back for DISPLAY only (a separator and a
 * "restart prompt" row, on every path: live, a resync, `--resume`); no
 * decision is ever taken from it — those stay structural.
 */

export const CONTEXT_RESET_HEADER =
  "[context reset] You renewed your own context with context_reset.\nEverything before it was discarded. Your restart prompt:";

const OPEN = "\n<restart_prompt>\n";
const CLOSE = "\n</restart_prompt>";

/** The restart message's head: the header and the prompt's block (callers append the rest). */
export function restartMessage(prompt: string): string {
  return `${CONTEXT_RESET_HEADER}${OPEN}${prompt}${CLOSE}`;
}

/**
 * The restart prompt a `restartMessage` carries, or null for any other
 * content. The LAST closing tag ends the block: a prompt may quote the tag,
 * what tentacle appends never does.
 */
export function restartPromptOf(content: string): string | null {
  const head = `${CONTEXT_RESET_HEADER}${OPEN}`;
  if (!content.startsWith(head)) {
    return null;
  }
  const end = content.lastIndexOf(CLOSE);
  return end < head.length ? null : content.slice(head.length, end);
}
