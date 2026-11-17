/**
 * The compaction's display view (docs/feat/harness-notices.md S1): which
 * message is a compaction summary, and the separator line drawn for it. Pure,
 * in core so the TUI and mobile (which cannot import `@tentacle/agent`) share it.
 */
import { formatTokens } from "./format.ts";
import type { ChatMessage } from "./model.ts";

/** The first line of every compaction summary message (`compactedHistory` writes it). */
export const COMPACTION_SUMMARY_HEAD =
  "Summary of the earlier conversation (compacted to save context):";

/** What a separator knows about a compaction: figures only when the message carried them. */
export interface CompactionView {
  readonly fromTokens?: number;
  readonly toTokens?: number;
  readonly toExact?: true;
}

/**
 * The compaction a message stands for, or null. Structural first (`compacted`);
 * a legacy summary (a user message opening with the head, written before the
 * field existed) → `{}`: a separator without figures, never a fake number.
 */
export function compactionOf(m: ChatMessage): CompactionView | null {
  if (m.role !== "user") {
    return null;
  }
  if (m.compacted) {
    const { fromTokens, toTokens, toExact } = m.compacted;
    return toExact ? { fromTokens, toTokens, toExact } : { fromTokens, toTokens };
  }
  return m.content.startsWith(COMPACTION_SUMMARY_HEAD) ? {} : null;
}

/**
 * `compacted · ctx 182k → 9k`; `~9k` when the after was estimated (owner Q2);
 * `compacted` alone without figures; `foreign` → `compacted on another device …` (Q6).
 */
export function compactionSeparatorText(
  view: CompactionView,
  opts: { foreign?: boolean } = {},
): string {
  const head = opts.foreign ? "compacted on another device" : "compacted";
  if (view.fromTokens === undefined || view.toTokens === undefined) {
    return head;
  }
  const to = `${view.toExact ? "" : "~"}${formatTokens(view.toTokens)}`;
  return `${head} · ctx ${formatTokens(view.fromTokens)} → ${to}`;
}
