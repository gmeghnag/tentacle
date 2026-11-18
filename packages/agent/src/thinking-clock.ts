/**
 * How long a model round thought (docs/fix/thought-placeholder.md, owner option
 * 3): the reasoning TEXT is never stored, only this duration, as the round's
 * assistant message's `thought` placeholder.
 *
 * A thinking RUN starts at a reasoning delta that says something (whitespace is
 * not a thought: the phone draws no row for it either) and ends at the next
 * event that is not reasoning (text, a tool call, the stream's end) — the same
 * edges the phone's live row is measured between, on the agent's monotonic clock.
 * A round may think more than once; the runs are summed (one row per message).
 */
import type { ChatMessage, StreamEvent } from "@tentacle/core";

export class ThinkingClock {
  private total = 0;
  private start: number | null = null;
  private said = false;

  constructor(private readonly now: () => number) {}

  /** Feed every stream event, in order. */
  see(event: StreamEvent): void {
    if (event.type === "reasoning") {
      if (this.start === null && event.delta.trim() !== "") {
        this.start = this.now();
        this.said = true;
      }
      return;
    }
    this.close();
  }

  /** `{ thought }` spreadable onto the round's message, or `{}` when it never thought. */
  fact(): Pick<ChatMessage, "thought"> {
    this.close();
    return this.said ? { thought: { ms: Math.max(0, Math.round(this.total)) } } : {};
  }

  private close(): void {
    if (this.start !== null) {
      this.total += this.now() - this.start;
      this.start = null;
    }
  }
}
