/**
 * Context-management contracts.
 *
 * `TokenCounter` is pluggable (ADR-006): exact tokenizers per model, with a
 * heuristic fallback. `ContextManager` decides what fits the budget and when
 * compaction is required; `DefaultContextManager` provides the baseline policy.
 */
import type { ChatMessage, ChatRequest, ModelProvider } from "./model.ts";

/** The bound on any exact token count made for a meter (docs/feat/tui-target-badge.md). */
export const COUNT_TOKENS_CAP_MS = 2000;

/**
 * `model.countTokens(request)` under a deadline: the provider's exact count, or
 * `undefined` when it cannot, fails, is slower than `timeoutMs` or `signal`
 * aborts — never throws (the caller estimates, silently). The provider's own
 * signal is aborted on the way out, so a still-pending fetch (or tunnelled
 * request) is dropped instead of left hanging.
 */
export async function countTokensBounded(
  model: Pick<ModelProvider, "countTokens">,
  request: ChatRequest,
  signal?: AbortSignal,
  timeoutMs: number = COUNT_TOKENS_CAP_MS,
): Promise<number | undefined> {
  if (model.countTokens === undefined) {
    return undefined;
  }
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const stop = (): void => deadline.abort();
  if (signal?.aborted) {
    stop();
  }
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const cut = new Promise<undefined>((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve(undefined), { once: true });
      if (deadline.signal.aborted) {
        resolve(undefined);
      }
    });
    return await Promise.race([
      model.countTokens({ ...request, signal: deadline.signal }).catch(() => undefined),
      cut,
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
    deadline.abort();
  }
}

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
