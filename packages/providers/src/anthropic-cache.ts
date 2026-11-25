/**
 * Anthropic prompt-caching breakpoints (docs/fix/anthropic-prompt-caching.md).
 *
 * The API caches the request prefix in the order tools → system → messages,
 * up to each `cache_control` breakpoint (max 4). Two are placed:
 *  1. the end of `system` — covers the stable prefix (all tool definitions +
 *     the system prompt, ~20k tokens);
 *  2. the last block of the last message, and 3. of the previous user message
 *     (the previous request's last) — round N+1 reads round N's prefix even
 *     when a wide parallel round exceeds the API's ~20-block lookback.
 * A single-message request (one-shot summary/title) gets no message breakpoint.
 * A prefix under the model's minimum cacheable size is silently not cached
 * by the server (harmless: no error, no surcharge).
 * Compaction / context_reset rewrite the history: the message breakpoint
 * misses once (a cache write of the new, shorter history), the tools+system
 * breakpoint still hits.
 */
const EPHEMERAL = { type: "ephemeral" } as const;

type Json = Record<string, unknown>;

/** Mutates `payload` (built by `buildPayload`): adds the breakpoints. */
export function applyCacheControl(payload: Json): void {
  const system = payload.system;
  if (typeof system === "string" && system !== "") {
    payload.system = [{ type: "text", text: system, cache_control: EPHEMERAL }];
  } else if (system === undefined && Array.isArray(payload.tools) && payload.tools.length > 0) {
    // No system prompt: the tools themselves are the stable prefix.
    const tools = payload.tools as Json[];
    const last = tools.at(-1);
    if (last) {
      tools[tools.length - 1] = { ...last, cache_control: EPHEMERAL };
    }
  }
  const messages = payload.messages;
  // A single message is a one-shot call (compaction summary, title, tool-output
  // summary): nothing re-reads it, so a breakpoint would only pay the 1.25x write.
  if (!Array.isArray(messages) || messages.length < 2) {
    return;
  }
  const lastIndex = messages.length - 1;
  mark(messages[lastIndex] as Json);
  // Also the previous user message = the last message of the previous round's
  // request. The API only looks back ~20 CONTENT blocks from a breakpoint, and a
  // round with many parallel calls adds more than that (text + N tool_use + N
  // tool_result), so the last-message breakpoint alone would miss the history.
  for (let i = lastIndex - 1; i >= 0; i--) {
    const m = messages[i] as Json;
    if (m.role === "user") {
      mark(m);
      break;
    }
  }
}

/** Put a breakpoint on the last block of a message (a string becomes one text block). */
function mark(message: Json): void {
  const content = message.content;
  if (typeof content === "string") {
    if (content !== "") {
      message.content = [{ type: "text", text: content, cache_control: EPHEMERAL }];
    }
  } else if (Array.isArray(content) && content.length > 0) {
    const i = content.length - 1;
    content[i] = { ...(content[i] as Json), cache_control: EPHEMERAL };
  }
}
