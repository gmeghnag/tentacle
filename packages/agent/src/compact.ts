/**
 * Context compaction: summarise a conversation so the model keeps the thread
 * while shedding token weight. A one-off, tool-free model call turns the
 * transcript into a dense brief; the caller then rebuilds the history as the
 * system prompt + that brief. Pure w.r.t. the provider (injected).
 */
import type { ChatMessage, ChatRequest, ModelProvider } from "@tentacle/core";

const COMPACT_SYSTEM =
  "You compress a coding-assistant conversation into a dense briefing for the " +
  "assistant to continue from. Preserve: the user's goals and constraints, " +
  "decisions made, key facts, file paths and identifiers, what was done, and " +
  "open tasks / next steps. Drop pleasantries and redundant detail. Write it as " +
  "notes, not prose. Do not add anything that was not in the conversation.";

const COMPACT_INSTRUCTION = "Summarise the following conversation as a briefing to continue from:";

/** Render one message as a line of the transcript fed to the summariser. */
function renderMessage(message: ChatMessage): string {
  const role = message.role.toUpperCase();
  const calls =
    message.toolCalls && message.toolCalls.length > 0
      ? ` [called: ${message.toolCalls.map((c) => c.name).join(", ")}]`
      : "";
  return `${role}: ${message.content}${calls}`;
}

/**
 * Thrown when compaction cannot produce a usable summary. An empty summary
 * would irreversibly wipe the conversation (the history is replaced by the
 * system prompt + summary), so it is a hard failure that leaves the history
 * untouched instead.
 */
export class CompactError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactError";
  }
}

/** Produce a compact summary of a conversation using the model (no tools). */
export async function summarizeConversation(
  model: ModelProvider,
  messages: readonly ChatMessage[],
  signal?: AbortSignal,
): Promise<string> {
  const transcript = messages
    .filter((m) => m.role !== "system")
    .map(renderMessage)
    .join("\n\n");
  const request: ChatRequest = {
    messages: [
      { role: "system", content: COMPACT_SYSTEM },
      {
        role: "user",
        content: `${COMPACT_INSTRUCTION}\n\n<transcript>\n${transcript}\n</transcript>`,
      },
    ],
    tools: [],
    ...(signal ? { signal } : {}),
  };
  let summary = "";
  for await (const event of model.stream(request)) {
    if (event.type === "text") {
      summary += event.delta;
    }
  }
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    // A thinking model may emit only `reasoning` events, or the server may
    // have errored in-band — either way there is no visible text. An empty
    // summary would replace the whole history with a blank brief, so fail
    // loudly before any state is mutated (see `Session.compact`).
    throw new CompactError(
      "model returned an empty summary — conversation left intact — retry /compact, or check the model emitted no visible text (a thinking model may have spent its budget on reasoning)",
    );
  }
  return trimmed;
}

const SUMMARIZE_TEXT_SYSTEM =
  "You condense a tool's output for a coding assistant. Keep the facts that matter " +
  "(results, errors, names, paths, numbers, structure) and drop noise and repetition. " +
  "Be terse; the full output remains available on disk. Do not invent anything.";

/** Summarise a block of tool output using the model (no tools). */
export async function summarizeText(
  model: ModelProvider,
  text: string,
  signal?: AbortSignal,
): Promise<string> {
  const request: ChatRequest = {
    messages: [
      { role: "system", content: SUMMARIZE_TEXT_SYSTEM },
      { role: "user", content: `Summarise this output:\n\n<output>\n${text}\n</output>` },
    ],
    tools: [],
    ...(signal ? { signal } : {}),
  };
  let summary = "";
  for await (const event of model.stream(request)) {
    if (event.type === "text") {
      summary += event.delta;
    }
  }
  return summary.trim();
}

export interface CompactResult {
  readonly summary: string;
  readonly before: number;
  readonly after: number;
}

/**
 * Build the post-compaction history: keep the leading system message (if any),
 * then a single user message carrying the summary.
 */
export function compactedHistory(messages: readonly ChatMessage[], summary: string): ChatMessage[] {
  const next: ChatMessage[] = [];
  const system = messages.find((m) => m.role === "system");
  if (system) {
    next.push(system);
  }
  next.push({
    role: "user",
    content: `Summary of the earlier conversation (compacted to save context):\n\n${summary}`,
  });
  return next;
}
