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
 *
 * `twoWay` (`subagents.twoWay`, docs/feat/agent-message-two-way.md, owner Q3 b
 * of docs/fix/autoaccept-wake-turns.md): ONE short trailing line telling the child
 * it may answer with `agent_notify`. Off → the text is byte-identical to before
 * the flag existed.
 */
export function inboxText(from: AgentMessageSender, text: string, twoWay = false): string {
  const head =
    from === "agent"
      ? `[message from the parent agent] ${text}`
      : `[message from the user] ${text}`;
  return twoWay ? `${head}${TWO_WAY_REPLY_HINT}` : head;
}

/**
 * The hint a child reads with a message when it may answer: one line, naming the
 * ONE tool that reaches the agent back (its own `agent_notify`), so the child
 * does not guess that a reply is possible or how to send it.
 */
export const TWO_WAY_REPLY_HINT =
  "\n(You may answer with agent_notify: it reaches the agent as a note.)";

export type InboxPush =
  | {
      readonly ok: true;
      /**
       * This sender's 1-based cumulative count of accepted pushes (the count
       * `read(from)` reports back once the child took it): a `subagent_message`
       * carries it as `n`, so `userRead >= n` means THIS text was read
       * (docs/fix/autoaccept-wake-turns.md, part B).
       */
      readonly index: number;
    }
  | { readonly ok: false; readonly reason: "closed" | "full" };

/** One queued text, with who wrote it (the read count is kept per sender). */
interface InboxItem {
  readonly text: string;
  readonly from: AgentMessageSender;
}

/** What an inbox is built with. */
export interface AgentInboxOptions {
  /**
   * A `drain`/`closeIfEmpty` handed the child at least one text (it is in its
   * context now, which is what its read count just moved for). The runner's
   * publish hook: `AgentJobs` re-reads its rows for the drawer.
   */
  readonly onRead?: () => void;
}

/**
 * One child's queue of ready user-message contents. Synchronous end to end: the
 * runner drains it at a round boundary, and `closeIfEmpty` decides — in one
 * stretch, with no `await` in between — whether the child reads again.
 */
export class AgentInbox {
  private items: InboxItem[] = [];
  private isClosed = false;
  /**
   * Per sender, how many of its texts the child has taken into its context: the
   * ONE source of truth `agent_control status` counts unread from, and the one a
   * client's `✓ read` reads (`AgentJobs.rows().userRead`).
   */
  private readonly readCounts: Record<AgentMessageSender, number> = { agent: 0, user: 0 };
  private readonly onRead?: () => void;

  constructor(options: AgentInboxOptions = {}) {
    this.onRead = options.onRead;
  }

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
   * How many of `from`'s texts this child has READ (taken out of the inbox into
   * its context) since it started. Cumulative and monotonic: a client compares a
   * `subagent_message`'s own index against it. Never moved by `close()` — those
   * texts were never read (the child's report says so).
   */
  read(from: AgentMessageSender): number {
    return this.readCounts[from];
  }

  /**
   * Queue one text. Refused when the child stopped reading (`closed`) or when it
   * already holds `AGENT_INBOX_MAX` unread ones (`full`): the sender reports it,
   * nothing is queued.
   */
  push(text: string, from: AgentMessageSender = "agent"): InboxPush {
    if (this.isClosed) {
      return { ok: false, reason: "closed" };
    }
    if (this.items.length >= AGENT_INBOX_MAX) {
      return { ok: false, reason: "full" };
    }
    this.items.push({ text, from });
    return { ok: true, index: this.readCounts[from] + this.unreadFrom(from) };
  }

  /** Take everything queued (in order). A closed inbox has nothing left to read. */
  drain(): string[] {
    if (this.isClosed) {
      return [];
    }
    return this.takeAll();
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
      return this.takeAll();
    }
    this.isClosed = true;
    return [];
  }

  /**
   * Close for good and hand back what was never read (an empty array once
   * closed): the runner counts them into the report, so a queued text is
   * reported rather than lost. These were NOT read, so no count moves.
   */
  close(): string[] {
    if (this.isClosed) {
      return [];
    }
    this.isClosed = true;
    return this.items.splice(0).map((item) => item.text);
  }

  /**
   * Hand the child every queued text, counting each into its sender's read
   * total — the ONE place a text becomes "read". `onRead` then tells the owner
   * the rows it publishes changed.
   */
  private takeAll(): string[] {
    const taken = this.items.splice(0);
    for (const item of taken) {
      this.readCounts[item.from] += 1;
    }
    if (taken.length > 0) {
      this.onRead?.();
    }
    return taken.map((item) => item.text);
  }

  /** How many of `from`'s texts sit queued, unread (what `push`'s index adds). */
  private unreadFrom(from: AgentMessageSender): number {
    return this.items.filter((item) => item.from === from).length;
  }
}
