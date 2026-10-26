/**
 * Context awareness (docs/feat/context-awareness.md): the model is told how
 * full its context is by a short `[context: 82k / 128k tokens (64%)]` line,
 * once per new step of fill, appended to the message that crosses it.
 *
 * The line lives in the history as DATA (`ChatMessage.contextUsage`), never in
 * `content`: the agent loop renders it into the model's copy of the message on
 * every request (`renderForModel`), so a line the model once saw stays in its
 * prompt byte for byte (a stable cache prefix), while every reader of `content`
 * (the TUI, titles, hooks' prompt, steer matching) keeps the clean text.
 *
 * Pure and React-free: the loop decides WHEN with these functions.
 */
import type { ChatMessage, ContextUsage, TokenCounter, ToolDefinition } from "@tentacle/core";

/**
 * What the provider measured: request `len` messages long, whose last one is
 * `ref`, cost `promptTokens`. Valid while `history[len - 1] === ref` (a
 * compaction or a reload replaces the objects, so it lapses on its own).
 */
export interface ContextAnchor {
  readonly promptTokens: number;
  readonly len: number;
  readonly ref: ChatMessage;
}

/** `950`, `82k`, `1.0M`. */
function formatTokens(n: number): string {
  if (n < 1000) {
    return String(n);
  }
  const k = Math.round(n / 1000);
  return k < 1000 ? `${k}k` : `${(n / 1_000_000).toFixed(1)}M`;
}

/** Floored, never capped: a count past a too-small window reads over 100. */
function percent(u: ContextUsage): number {
  return Math.floor((u.used * 100) / u.window);
}

/** The line the model sees, e.g. `[context: 82k / 128k tokens (64%)]`. */
export function contextLine(u: ContextUsage): string {
  return `[context: ${formatTokens(u.used)} / ${formatTokens(u.window)} tokens (${percent(u)}%)]`;
}

/**
 * The model's copy of `m`: its line appended to `content`, `contextUsage`
 * dropped. A message without one is returned as is.
 */
export function renderForModel(m: ChatMessage): ChatMessage {
  if (m.contextUsage === undefined) {
    return m;
  }
  const { contextUsage, ...rest } = m;
  return { ...rest, content: `${m.content}\n\n${contextLine(contextUsage)}` };
}

/** The latest line in `history`, if any — the counting state, never stored apart. */
export function lastEmitted(history: readonly ChatMessage[]): ContextUsage | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const usage = history[i]?.contextUsage;
    if (usage !== undefined) {
      return usage;
    }
  }
  return undefined;
}

/** A new line is due: none yet, or `current` is in a HIGHER step than `last`. */
export function shouldEmit(
  current: ContextUsage,
  last: ContextUsage | undefined,
  stepPercent: number,
): boolean {
  return (
    last === undefined ||
    Math.floor(percent(current) / stepPercent) > Math.floor(percent(last) / stepPercent)
  );
}

/**
 * The size of the request `history` is about to become: the provider's
 * measure of the anchored prefix plus an estimate of what came after it, or,
 * with no valid anchor, an estimate of everything (the tool definitions too:
 * the provider counts them). Counted rendered, as the model will see it.
 */
export function estimateUsed(
  history: readonly ChatMessage[],
  tools: readonly ToolDefinition[],
  anchor: ContextAnchor | undefined,
  counter: TokenCounter,
): number {
  if (anchor !== undefined && history[anchor.len - 1] === anchor.ref) {
    return (
      anchor.promptTokens + counter.countMessages(history.slice(anchor.len).map(renderForModel))
    );
  }
  return (
    counter.countMessages(history.map(renderForModel)) + counter.countText(JSON.stringify(tools))
  );
}
