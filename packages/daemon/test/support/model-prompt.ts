/**
 * The date stamp in the MODEL's copy of a message
 * (docs/fix/prompt-current-date.md): `renderForModel` prepends
 * `[Fri 2026-11-20 13:42 CET]\n` to a first user message (and to any later one
 * whose stamp went stale), so a test that dispatches on, or asserts, the prompt
 * text it scripted has to look through that ONE line.
 *
 * Two seams, deliberately: `stripped` / `userLines` are for a test whose subject
 * is NOT the prompt's bytes (a scripted model picking a round, an expected text
 * list); `stampLine` is for a test that DOES pin them — there the stamp is
 * asserted to be there, and the rest is compared exactly, never tolerated.
 * The line's own shape is pinned in `core/test/current-date.test.ts` and
 * `daemon/test/date-stamp.test.ts`; here it is only recognized.
 */
import type { ChatMessage } from "@tentacle/core";

/** `[Fri 2026-11-20 13:42 CET]` and the newline after it. */
export const DATE_STAMP_LINE = /^\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^\]]+\]\n/;

/** `text` without its leading date stamp (a message with none is unchanged). */
export function stripped(text: string): string {
  return text.replace(DATE_STAMP_LINE, "");
}

/** The message's own content, without the leading date stamp. */
export function unstamped(message: ChatMessage): string {
  return stripped(message.content);
}

/** The user messages of `messages`, by content, without any leading date stamp. */
export function userLines(messages: readonly ChatMessage[]): string[] {
  return messages.filter((m) => m.role === "user").map(unstamped);
}

/** The stamp line `text` begins with (`"[Fri …]\n"`), or `undefined` when it has none. */
export function stampLine(text: string): string | undefined {
  return DATE_STAMP_LINE.exec(text)?.[0];
}
