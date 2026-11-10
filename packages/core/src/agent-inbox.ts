/**
 * A running sub-agent's inbox (docs/feat/agent-message.md): the ONE channel every
 * sender writes into — the parent agent's `agent_control` tool today, the user's
 * panel in task 7 — delivered at the child's next boundary exactly like a steer.
 *
 * One-way, and bounded: a child never answers here (task 9 is the other
 * direction) and never sees its context grow without limit (owner Q2 a).
 *
 * THE property (the load-bearing assumption of the design): a text `push`
 * ACCEPTS is either drained into the child's history or handed back to the
 * runner by `closeIfEmpty` / `close` — never accepted and then silently lost.
 * That holds because the close is a plain synchronous flag set by the runner in
 * the same stretch as its decision to stop reading: after it, `push` refuses.
 */
/**
 * Who wrote the text. `user` is task 7's panel path, built and tested here so it
 * reuses this channel rather than a second one.
 */
export type AgentMessageSender = "agent" | "user";

/** Unread texts a child may hold at once (owner Q2 a). */
export const AGENT_INBOX_MAX = 8;
/** Longest text a sender may write (owner Q2 a). */
export const AGENT_MESSAGE_MAX_CHARS = 8_000;

/**
 * A text as the child reads it: a user-role message naming who wrote it, so the
 * child's model never mistakes it for its own task prompt.
 */
export function inboxText(from: AgentMessageSender, text: string): string {
  return from === "agent"
    ? `[message from the parent agent] ${text}`
    : `[message from the user] ${text}`;
}

export type InboxPush =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "closed" | "full" };

/**
 * One child's queue of ready user-message contents. Synchronous end to end: the
 * runner drains it at a round boundary, and `closeIfEmpty` decides — in one
 * stretch, with no `await` in between — whether the child reads again.
 */
export class AgentInbox {
  private items: string[] = [];
  private isClosed = false;

  /** Whether the child has stopped reading. A push onto a closed inbox is refused. */
  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * How many texts the child has not drained yet (docs/feat/agent-status.md):
   * read by `AgentJobs.pending`, so a parent deciding to write again knows
   * whether the last ones were read. The one reader of `items.length`.
   */
  get pending(): number {
    return this.items.length;
  }

  /**
   * Queue one text. Refused when the child stopped reading (`closed`) or when it
   * already holds `AGENT_INBOX_MAX` unread ones (`full`): the sender reports it,
   * nothing is queued.
   */
  push(text: string): InboxPush {
    if (this.isClosed) {
      return { ok: false, reason: "closed" };
    }
    if (this.items.length >= AGENT_INBOX_MAX) {
      return { ok: false, reason: "full" };
    }
    this.items.push(text);
    return { ok: true };
  }

  /** Take everything queued (in order). A closed inbox has nothing left to read. */
  drain(): string[] {
    if (this.isClosed) {
      return [];
    }
    return this.items.splice(0);
  }

  /**
   * The child's run ended: either texts slipped in after its last drain — they
   * come back for ONE more pass and the inbox STAYS OPEN (the child will read
   * them) — or it holds none, and the inbox closes for good in this same
   * synchronous stretch, so no sender can interleave a text nobody would read.
   */
  closeIfEmpty(): string[] {
    if (this.isClosed) {
      return [];
    }
    if (this.items.length > 0) {
      return this.items.splice(0);
    }
    this.isClosed = true;
    return [];
  }

  /**
   * Close for good and hand back what was never read (an empty array once
   * closed): the runner counts them into the report, so a queued text is
   * reported rather than lost.
   */
  close(): string[] {
    if (this.isClosed) {
      return [];
    }
    this.isClosed = true;
    return this.items.splice(0);
  }
}
