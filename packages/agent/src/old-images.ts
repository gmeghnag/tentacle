/**
 * Old user images become on-demand (docs/feat/image-old-on-demand.md D1):
 * the pictures the user attached more than `OLD_IMAGE_TURNS` turns ago are
 * replaced, in the REQUEST only, by a line naming them and the ref
 * `image_view` takes. The stored history and the session log are untouched —
 * this is a projection of what the model is sent, like `applyPrune`.
 *
 * Pure and React-free: no store, no provider, no runtime state. The set is
 * computed from the stored history alone, so a resumed session, a rebuilt
 * agent and an uninterrupted one age the same images.
 */
import type { ChatMessage } from "@tentacle/core";
import { TOOL_IMAGE_REF_CHARS, attachmentLabel, formatBytes } from "@tentacle/core";
import { PRUNE_MARKER } from "./prune.ts";

/**
 * How many ANSWERED turns an image stays always-sent (owner answer 2 of
 * `docs/eval/image-on-demand.md`: N = 2). A constant, never a setting.
 */
export const OLD_IMAGE_TURNS = 2;

/**
 * The line that replaces an old image, a pure function of the ref ONLY: an
 * "… 2 turns ago" would change every turn and break the prompt-cache prefix
 * again. It starts with `PRUNE_MARKER`, so the write tools' existing guard
 * refuses it as file content (`tools/src/builtins.ts`, `refusePruned`).
 */
export function oldImagePlaceholder(ref: {
  readonly id: string;
  readonly mimeType: string;
  readonly size: number;
  readonly name?: string;
}): string {
  return `${PRUNE_MARKER}: image ${attachmentLabel(ref)} · ${formatBytes(ref.size)} attached by the user earlier, not resent — image_view ${ref.id.slice(0, TOOL_IMAGE_REF_CHARS)} to see it⟫`;
}

/** An answer: an assistant message with no tool calls (an empty list counts as none). */
function isAnswer(message: ChatMessage | undefined): boolean {
  return message?.role === "assistant" && (message.toolCalls ?? []).length === 0;
}

/**
 * `history` as a request built at the start of the turn beginning at `turnFrom`
 * sends it: every user message older than `OLD_IMAGE_TURNS` answers loses its
 * `attachments` and gains one placeholder line per ref, in ref order (an empty
 * `content` gets the lines only). Indices never shift — one message in, one out
 * — so prune indices and context anchors stay valid; every other message keeps
 * its identity, and a history with nothing old comes back AS ITSELF.
 */
export function projectOldImages(
  history: readonly ChatMessage[],
  turnFrom: number,
): readonly ChatMessage[] {
  const end = Math.max(0, Math.min(turnFrom, history.length));
  let answers = 0;
  // Walked from the turn's first index backwards: the count of answers AFTER a
  // message is what ages it, so this costs one pass and reads only `[from, end)`.
  const aged = new Set<number>();
  for (let i = end - 1; i >= 0; i--) {
    const message = history[i];
    if (isAnswer(message)) {
      answers++;
      continue;
    }
    if (
      message?.role === "user" &&
      answers >= OLD_IMAGE_TURNS &&
      (message.attachments ?? []).length > 0
    ) {
      aged.add(i);
    }
  }
  if (aged.size === 0) {
    return history;
  }
  const out = [...history];
  for (const index of aged) {
    const message = history[index];
    if (message === undefined) {
      continue;
    }
    const lines = (message.attachments ?? []).map(oldImagePlaceholder);
    // The key goes, not the value: a `attachments: undefined` would still be an
    // own property, and the provider switches on the key's presence.
    const { attachments: _dropped, ...rest } = message;
    out[index] = {
      ...rest,
      content:
        message.content === "" ? lines.join("\n") : `${lines.join("\n")}\n${message.content}`,
    };
  }
  return out;
}
