/**
 * Which images to give back to a daemon after a session is (re)opened from a
 * history that already names them (docs/feat/attachments-durable.md D5).
 *
 * Only the ones a provider would actually inline: the newest
 * `RESTORE_IMAGES` distinct refs on USER messages, walked exactly like
 * `selectInlineIds` (`@tentacle/providers`, which this package does not depend
 * on — the T11 test pins the two together). An older ref is never sent to a
 * model again, so restoring it would only cost an upload. Pure.
 */
import type { AttachmentRef, ChatMessage } from "@tentacle/core";

/** = `MAX_INLINE_IMAGES` of `@tentacle/providers` (pinned by test). */
export const RESTORE_IMAGES = 5;

/** The refs to restore, newest first, one per id (the newest ref's type and name). */
export function imagesToRestore(
  history: readonly ChatMessage[],
  keep: number = RESTORE_IMAGES,
): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  const seen = new Set<string>();
  for (let at = history.length - 1; at >= 0 && out.length < keep; at--) {
    const message = history[at];
    if (message?.role !== "user") continue;
    const refs = message.attachments ?? [];
    for (let k = refs.length - 1; k >= 0 && out.length < keep; k--) {
      const ref = refs[k];
      if (ref === undefined || seen.has(ref.id)) continue;
      seen.add(ref.id);
      out.push(ref);
    }
  }
  return out;
}
