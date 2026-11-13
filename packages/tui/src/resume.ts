/**
 * Turn a resumed conversation (the model's `ChatMessage[]`) back into the
 * display transcript, so `--resume` shows the prior turns, not a blank screen.
 * The agent history remains the source of truth; this is a presentation view.
 */
import { restartPromptOf } from "@tentacle/agent";
import type { ChatMessage } from "@tentacle/core";
import { imageRowText } from "./attach-draft.ts";
import type { DisplayItem, ToolItem } from "./state.ts";

/** The separator before a context reset's restart prompt (decision 9, docs/eval/context-reset.md). */
export const CONTEXT_RESET_SEPARATOR = "↻ context reset by the model";

/**
 * A tentacle-written note (a job's exit, a sub-agent's report/loss) as a
 * NOTICE, never as a row the person typed: the first line is the notice's
 * text, the rest is its `body` (shown only when expanded). An unknown kind is a
 * plain notice of the first line, so a newer `note.kind` never breaks a resume.
 */
function noteItem(m: ChatMessage): DisplayItem {
  const [first = "", ...rest] = m.content.split("\n");
  const body = rest.join("\n").trim();
  return {
    kind: "notice",
    text: first,
    ...(body !== "" ? { body } : {}),
    ...(m.note !== undefined ? { noteKind: m.note.kind } : {}),
  };
}

/**
 * A restart message (a context reset's first user message) is shown as the
 * separator, then the model's prompt alone — tentacle's appended notes
 * (jobs, skills) are the model's, not the user's.
 */
export function messagesToItems(messages: readonly ChatMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const toolAt = new Map<string, number>(); // toolCallId → index in `items`

  for (const m of messages) {
    if (m.role === "system") {
      continue; // the system prompt is not part of the visible transcript
    }
    if (m.role === "user") {
      const restart = restartPromptOf(m.content);
      if (restart !== null) {
        items.push({ kind: "notice", text: CONTEXT_RESET_SEPARATOR, separator: true });
        items.push({ kind: "user", text: restart, restart: true });
      } else if (m.note !== undefined) {
        items.push(noteItem(m));
      } else {
        // A resumed image prompt says so: `[image: name]` under the text, and
        // the ONLY rows of an image-only prompt (docs/feat/attachments-tui.md D7).
        const images = (m.attachments ?? []).map(imageRowText);
        items.push({
          kind: "user",
          text: m.content,
          ...(images.length > 0 ? { images } : {}),
        });
      }
    } else if (m.role === "assistant") {
      if (m.content.trim() !== "") {
        items.push({ kind: "assistant", text: m.content });
      }
      for (const call of m.toolCalls ?? []) {
        toolAt.set(call.id, items.length);
        items.push({
          kind: "tool",
          id: call.id,
          name: call.name,
          args: call.arguments,
          status: "ok", // historical: the call already ran
        });
      }
    } else if (m.role === "tool") {
      const idx = m.toolCallId !== undefined ? toolAt.get(m.toolCallId) : undefined;
      const tool = idx !== undefined ? (items[idx] as ToolItem) : undefined;
      if (tool) {
        items[idx as number] = {
          ...tool,
          resultText: m.content,
          // A refused call is known from its reply; any other result's error flag is not stored.
          status: m.denialReply !== undefined ? "error" : "ok",
          // A spilled result shows the same note as live (docs/feat/tui-spill-note.md).
          ...(m.spill ? { spill: m.spill } : {}),
          // So does a refusal with a reply (docs/feat/permission-reply.md).
          ...(m.denialReply !== undefined ? { denialReply: m.denialReply } : {}),
          // The stored measurement, or none: never a fake 0.0s (docs/fix/tool-duration.md).
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        };
      } else {
        // A tool result with no matching call (truncated history): show it plainly.
        items.push({ kind: "notice", text: m.content });
      }
    }
  }
  return items;
}
