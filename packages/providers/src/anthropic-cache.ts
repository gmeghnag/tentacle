/**
 * Anthropic prompt-caching breakpoints (docs/fix/anthropic-prompt-caching.md).
 *
 * The API caches the request prefix in the order tools → system → messages,
 * up to each `cache_control` breakpoint (max 4). Two are placed:
 *  1. the end of `system` — covers the stable prefix (all tool definitions +
 *     the system prompt, ~20k tokens);
 *  2. the last block of the last message — round N+1 reads round N's prefix.
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
  if (!Array.isArray(messages) || messages.length === 0) {
    return;
  }
  const lastMsg = messages.at(-1) as Json;
  const content = lastMsg.content;
  if (typeof content === "string") {
    if (content !== "") {
      lastMsg.content = [{ type: "text", text: content, cache_control: EPHEMERAL }];
    }
  } else if (Array.isArray(content) && content.length > 0) {
    const i = content.length - 1;
    content[i] = { ...(content[i] as Json), cache_control: EPHEMERAL };
  }
}
