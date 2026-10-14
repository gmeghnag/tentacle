/**
 * Heuristic token counter — the fallback used when no model-specific tokenizer
 * is available (ADR-006).
 *
 * Approximates ~4 characters per token (a widely-used rule of thumb) plus a
 * small structural overhead per message. It rounds UP so the budget never
 * *underestimates* real usage, which would risk overflowing the context window.
 */
import type { TokenCounter } from "./context.ts";
import type { ChatMessage } from "./model.ts";

export interface HeuristicOptions {
  readonly charsPerToken?: number;
  readonly perMessageOverhead?: number;
}

export class HeuristicTokenCounter implements TokenCounter {
  readonly id = "heuristic";
  private readonly charsPerToken: number;
  private readonly perMessageOverhead: number;

  constructor(options?: HeuristicOptions) {
    const charsPerToken = options?.charsPerToken ?? 4;
    if (charsPerToken <= 0) {
      throw new RangeError("charsPerToken must be > 0");
    }
    this.charsPerToken = charsPerToken;
    this.perMessageOverhead = options?.perMessageOverhead ?? 4;
  }

  countText(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / this.charsPerToken);
  }

  countMessages(messages: readonly ChatMessage[]): number {
    let total = 0;
    for (const message of messages) {
      total += this.perMessageOverhead + this.countText(message.content);
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          total += this.countText(call.name) + this.countText(call.arguments);
        }
      }
    }
    return total;
  }
}
