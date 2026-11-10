import { describe, expect, test } from "bun:test";
import { AGENT_INBOX_MAX, AgentInbox, type AgentMessageSender, inboxText } from "@tentacle/core";

// docs/feat/agent-message.md T1-T3: the channel the parent (later: the user)
// writes into a running child's context. One-way, and CLOSED for good once the
// child has stopped reading — the close is what makes "accepted" mean
// "delivered or reported" (LBA).

describe("T1: the close is the property (LBA)", () => {
  test("a push after closeIfEmpty closed the inbox is refused, and nothing is drained", () => {
    const inbox = new AgentInbox();
    // The child's run just ended and its inbox is empty: it stops reading.
    expect(inbox.closeIfEmpty()).toEqual([]);
    expect(inbox.closed).toBe(true);
    // A text accepted here would be read by nobody, ever.
    expect(inbox.push("late")).toEqual({ ok: false, reason: "closed" });
    expect(inbox.drain()).toEqual([]);
  });

  test("closeIfEmpty with texts hands them back and leaves the inbox OPEN", () => {
    const inbox = new AgentInbox();
    expect(inbox.push("one")).toEqual({ ok: true });
    // The runner carries these into one more pass; the child is still reading.
    expect(inbox.closeIfEmpty()).toEqual(["one"]);
    expect(inbox.closed).toBe(false);
    expect(inbox.push("two")).toEqual({ ok: true });
    expect(inbox.drain()).toEqual(["two"]);
  });
});

describe("T2: draining, closing, and the cap", () => {
  test("close returns the leftovers once, then nothing", () => {
    const inbox = new AgentInbox();
    inbox.push("a");
    inbox.push("b");
    expect(inbox.close()).toEqual(["a", "b"]);
    expect(inbox.closed).toBe(true);
    expect(inbox.close()).toEqual([]);
    // Drained already: a closed inbox has nothing to read.
    expect(inbox.drain()).toEqual([]);
    expect(inbox.push("c")).toEqual({ ok: false, reason: "closed" });
  });

  test("the cap is AGENT_INBOX_MAX unread texts, in order, and it frees as they are read", () => {
    const inbox = new AgentInbox();
    for (let i = 1; i <= AGENT_INBOX_MAX; i++) {
      expect(inbox.push(`m${i}`)).toEqual({ ok: true });
    }
    expect(inbox.push("over")).toEqual({ ok: false, reason: "full" });
    expect(inbox.drain()).toEqual(Array.from({ length: AGENT_INBOX_MAX }, (_, i) => `m${i + 1}`));
    // Read, so the room is back.
    expect(inbox.push("again")).toEqual({ ok: true });
    expect(inbox.drain()).toEqual(["again"]);
  });
});

describe("T3: what the child sees", () => {
  test("each sender has its own prefix, and the text follows verbatim", () => {
    expect(inboxText("agent", "also check X")).toBe("[message from the parent agent] also check X");
    expect(inboxText("user", "also check X")).toBe("[message from the user] also check X");
    const senders: readonly AgentMessageSender[] = ["agent", "user"];
    expect(senders.map((from) => inboxText(from, "").endsWith("] "))).toEqual([true, true]);
  });
});
