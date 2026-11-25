/**
 * Heuristic token counter — the fallback used when no model-specific tokenizer
 * is available (ADR-006).
 *
 * Approximates ~4 characters per token (a widely-used rule of thumb) plus a
 * small structural overhead per message. It rounds UP so the budget never
 * *underestimates* real usage, which would risk overflowing the context window.
 */
import { IMAGE_TOKEN_ESTIMATE } from "./attachments.ts";
import type { TokenCounter } from "./context.ts";
import type { ChatMessage } from "./model.ts";

export interface HeuristicOptions {
  readonly charsPerToken?: number;
  readonly perMessageOverhead?: number;
  /**
   * Tokens charged per image ref (default `IMAGE_TOKEN_ESTIMATE`): the
   * provider's estimate or `model.imageTokens` (docs/feat/image-view.md D7).
   */
  readonly imageTokens?: number;
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
    this.imageTokens = options?.imageTokens ?? IMAGE_TOKEN_ESTIMATE;
  }

  /** What one image ref costs in this counter. */
  readonly imageTokens: number;

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
      // An inline image is not text: it has no characters to divide. Charged per
      // ref, so a budget that ignores images never underestimates the prompt.
      total += (message.attachments?.length ?? 0) * this.imageTokens;
      if (message.toolCalls) {
        for (const call of message.toolCalls) {
          total += this.countText(call.name) + this.countText(call.arguments);
        }
      }
      // The model's own reasoning is echoed on every request (docs/fix/reasoning-echo.md
      // D7): counted, so prune and compaction fire on the real size. Anthropic's
      // signature is opaque transport, not prompt text: not counted.
      total += this.countReasoning(message.reasoning);
    }
    return total;
  }

  private countReasoning(record: ChatMessage["reasoning"]): number {
    if (!record) return 0;
    if (record.body.format === "openai") return this.countText(record.body.text);
    let total = 0;
    for (const block of record.body.blocks) {
      total += this.countText(block.type === "thinking" ? block.thinking : block.data);
    }
    return total;
  }
}
