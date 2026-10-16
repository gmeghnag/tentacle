/**
 * Turn a resumed conversation (the model's `ChatMessage[]`) back into the
 * display transcript, so `--resume` shows the prior turns, not a blank screen.
 * The agent history remains the source of truth; this is a presentation view.
 */
import type { ChatMessage } from "@tentacle/core";
import type { DisplayItem, ToolItem } from "./state.ts";

export function messagesToItems(messages: readonly ChatMessage[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  const toolAt = new Map<string, number>(); // toolCallId → index in `items`

  for (const m of messages) {
    if (m.role === "system") {
      continue; // the system prompt is not part of the visible transcript
    }
    if (m.role === "user") {
      items.push({ kind: "user", text: m.content });
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
          startedAt: 0,
        });
      }
    } else if (m.role === "tool") {
      const idx = m.toolCallId !== undefined ? toolAt.get(m.toolCallId) : undefined;
      const tool = idx !== undefined ? (items[idx] as ToolItem) : undefined;
      if (tool) {
        items[idx as number] = { ...tool, resultText: m.content, status: "ok", endedAt: 0 };
      } else {
        // A tool result with no matching call (truncated history): show it plainly.
        items.push({ kind: "notice", text: m.content });
      }
    }
  }
  return items;
}
