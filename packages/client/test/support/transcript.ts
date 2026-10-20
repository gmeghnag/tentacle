/**
 * The projected transcript (parent `session-reattach` decision C): what a
 * session shows, minus what history does not keep (thoughts, usage, the
 * whitespace-only text of an empty round). A drop anywhere, recovered by
 * replay or by resync, must give the same list as an uninterrupted stream.
 */
import type { ChatMessage } from "@tentacle/core";
import type { SessionUpdate } from "@tentacle/protocol";
import type { SessionEvent } from "../../src/mapping.ts";
import type { StreamOutput } from "../../src/session-reducer.ts";

export type Item =
  | { readonly kind: "user"; readonly text: string }
  | { readonly kind: "assistant"; readonly text: string }
  | { readonly kind: "tool"; readonly id: string; readonly name: string; readonly result?: string };

/** The canonical list a history reflects. */
export function fromMessages(messages: readonly ChatMessage[]): Item[] {
  const items: Item[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ kind: "user", text: m.content });
    } else if (m.role === "assistant") {
      items.push({ kind: "assistant", text: m.content });
      for (const call of m.toolCalls ?? []) {
        items.push({ kind: "tool", id: call.id, name: call.name });
      }
    } else if (m.role === "tool" && m.toolCallId !== undefined) {
      setResult(items, m.toolCallId, m.content);
    }
  }
  return items;
}

function setResult(items: Item[], id: string, result: string): void {
  const at = items.findIndex((i) => i.kind === "tool" && i.id === id);
  const item = items[at];
  if (item?.kind === "tool") {
    items[at] = { ...item, result };
  }
}

function appendText(items: Item[], text: string): void {
  const last = items.at(-1);
  if (last?.kind === "assistant") {
    items[items.length - 1] = { kind: "assistant", text: last.text + text };
  } else {
    items.push({ kind: "assistant", text });
  }
}

/** Fold one update the way a client that keeps a transcript must (tool calls upserted by id). */
function applyUpdate(items: Item[], update: SessionUpdate): void {
  switch (update.type) {
    case "turn_start":
      if (update.prompt !== "") items.push({ kind: "user", text: update.prompt });
      return;
    case "agent_message_chunk":
      appendText(items, update.content.type === "text" ? update.content.text : "");
      return;
    case "tool_call": {
      const at = items.findIndex((i) => i.kind === "tool" && i.id === update.toolCallId);
      if (at < 0) items.push({ kind: "tool", id: update.toolCallId, name: update.title });
      return;
    }
    case "tool_call_update":
      if (update.status === "completed" || update.status === "failed") {
        const texts = (update.content ?? []).flatMap((b) => (b.type === "text" ? [b.text] : []));
        setResult(items, update.toolCallId, texts.join("\n"));
      }
      return;
    case "steer":
    case "context_note":
      items.push({ kind: "user", text: update.text });
      return;
    default:
      return;
  }
}

/** Drop what history does not keep (an assistant item with only whitespace). */
function normalize(items: readonly Item[]): Item[] {
  return items.filter((i) => i.kind !== "assistant" || i.text.trim() !== "");
}

/** The transcript a raw stream consumer (a mobile view) holds after these outputs. */
export function foldOutputs(outputs: readonly StreamOutput[]): Item[] {
  let items: Item[] = [];
  for (const out of outputs) {
    if (out.kind === "reset") items = fromMessages(out.messages);
    else if (out.kind === "update") applyUpdate(items, out.update);
  }
  return normalize(items);
}

/**
 * The transcript a TUI-like consumer of `RemoteSession.send` holds: it shows
 * its own prompt first (the TUI's `startTurn`), and does NOT upsert tool
 * calls — so a duplicate the adapter let through is caught.
 */
export function foldEvents(
  initial: readonly Item[],
  prompt: string,
  events: readonly SessionEvent[],
): Item[] {
  let items: Item[] = [
    ...initial,
    ...(prompt === "" ? [] : [{ kind: "user" as const, text: prompt }]),
  ];
  for (const event of events) {
    switch (event.type) {
      case "history_reset":
        items = fromMessages(event.messages);
        break;
      case "user_message":
      case "steer":
        items.push({ kind: "user", text: event.text });
        break;
      case "context_note":
        items.push({ kind: "user", text: event.text });
        break;
      case "text":
        appendText(items, event.delta);
        break;
      case "tool_start":
        items.push({ kind: "tool", id: event.id, name: event.name });
        break;
      case "tool_result":
        setResult(items, event.id, event.result.content);
        break;
      default:
        break;
    }
  }
  return normalize(items);
}
