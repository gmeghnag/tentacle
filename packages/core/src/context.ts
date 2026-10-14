/**
 * Context-management contracts.
 *
 * `TokenCounter` is pluggable (ADR-006): exact tokenizers per model, with a
 * heuristic fallback. `ContextManager` decides what fits the budget and when
 * compaction is required; `DefaultContextManager` provides the baseline policy.
 */
import type { ChatMessage } from "./model.ts";

export interface TokenCounter {
  readonly id: string;
  countText(text: string): number;
  countMessages(messages: readonly ChatMessage[]): number;
}

export interface ContextBudget {
  /** Total context window of the target model, in tokens. */
  readonly contextWindow: number;
  /** Tokens to keep free for the model's reply. */
  readonly reserveForOutput: number;
}

export interface ContextManager {
  readonly counter: TokenCounter;
  readonly budget: ContextBudget;
  /** Tokens currently consumed by `messages`. */
  used(messages: readonly ChatMessage[]): number;
  /** True when `messages` leave too little room for the reserved output. */
  needsCompaction(messages: readonly ChatMessage[]): boolean;
}

/** Baseline manager: compaction is needed once usage exceeds window − reserve. */
export class DefaultContextManager implements ContextManager {
  constructor(
    readonly counter: TokenCounter,
    readonly budget: ContextBudget,
  ) {}

  used(messages: readonly ChatMessage[]): number {
    return this.counter.countMessages(messages);
  }

  needsCompaction(messages: readonly ChatMessage[]): boolean {
    const limit = this.budget.contextWindow - this.budget.reserveForOutput;
    return this.used(messages) > limit;
  }
}
