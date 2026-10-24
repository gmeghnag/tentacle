/**
 * Text a container or a remote daemon wrote (an error message, a command's
 * stderr) is untrusted (AGENTS §7): before it reaches the terminal or the
 * transcript it becomes one line, with control and bidi characters removed
 * (the TUI's `oneLine`, as for skill descriptions), capped.
 */
import { oneLine } from "@tentacle/tui";

/** The most characters of one untrusted message shown. */
export const UNTRUSTED_TEXT_MAX = 1000;

export function untrustedText(text: string): string {
  const line = oneLine(text);
  return line.length > UNTRUSTED_TEXT_MAX ? `${line.slice(0, UNTRUSTED_TEXT_MAX - 1)}…` : line;
}
