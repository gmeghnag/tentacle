import { describe, expect, test } from "bun:test";
import {
  AGENT_INBOX_MAX,
  AgentInbox,
  type AgentMessageSender,
  TWO_WAY_REPLY_HINT,
  inboxText,
} from "@tentacle/core";

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
    expect(inbox.push("one")).toEqual({ ok: true, index: 1 });
    // The runner carries these into one more pass; the child is still reading.
    expect(inbox.closeIfEmpty()).toEqual(["one"]);
    expect(inbox.closed).toBe(false);
    expect(inbox.push("two")).toEqual({ ok: true, index: 2 });
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
      expect(inbox.push(`m${i}`)).toEqual({ ok: true, index: i });
    }
    expect(inbox.push("over")).toEqual({ ok: false, reason: "full" });
    expect(inbox.drain()).toEqual(Array.from({ length: AGENT_INBOX_MAX }, (_, i) => `m${i + 1}`));
    // Read, so the room is back.
    expect(inbox.push("again")).toEqual({ ok: true, index: AGENT_INBOX_MAX + 1 });
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

  // docs/fix/autoaccept-wake-turns.md owner Q3 (b): with `subagents.twoWay` ON the
  // text ends with ONE short line saying the child may answer with `agent_notify`;
  // OFF it is byte-for-byte what it was. MUTATION: append the hint regardless of
  // `twoWay` → the `false` cases go red.
  test("the two-way reply hint: exact when on, byte-identical when off", () => {
    for (const from of ["agent", "user"] as const) {
      const head = inboxText(from, "also check X");
      // Off: exactly today's text, nothing appended.
      expect(inboxText(from, "also check X", false)).toBe(head);
      // On: today's text plus ONE line, naming the one tool that answers.
      expect(inboxText(from, "also check X", true)).toBe(`${head}${TWO_WAY_REPLY_HINT}`);
      expect(TWO_WAY_REPLY_HINT.split("\n")).toHaveLength(2);
      expect(TWO_WAY_REPLY_HINT).toContain("agent_notify");
    }
  });
});

// docs/fix/autoaccept-wake-turns.md T6 (part B): the read count is per sender and
// is the ONE source of truth (`agent_control status` reads the other side of it).
describe("T6: the read count, per sender", () => {
  test("two user pushes answer index 1 and 2, and an agent push moves no user index", () => {
    const inbox = new AgentInbox();
    expect(inbox.push("u1", "user")).toEqual({ ok: true, index: 1 });
    expect(inbox.push("a1", "agent")).toEqual({ ok: true, index: 1 });
    expect(inbox.push("u2", "user")).toEqual({ ok: true, index: 2 });
    // Nothing read yet: every index is still ahead of the count.
    expect(inbox.read("user")).toBe(0);
    expect(inbox.read("agent")).toBe(0);
  });

  test("drain() counts what it hands out, per sender", () => {
    const inbox = new AgentInbox();
    inbox.push("u1", "user");
    inbox.push("a1", "agent");
    inbox.push("u2", "user");
    expect(inbox.drain()).toEqual(["u1", "a1", "u2"]);
    expect(inbox.read("user")).toBe(2);
    expect(inbox.read("agent")).toBe(1);
    // Cumulative: a second drain keeps counting from where it was.
    inbox.push("u3", "user");
    expect(inbox.drain()).toEqual(["u3"]);
    expect(inbox.read("user")).toBe(3);
  });

  test("closeIfEmpty's hand-back counts as read (the child takes one more pass)", () => {
    const inbox = new AgentInbox();
    inbox.push("u1", "user");
    expect(inbox.closeIfEmpty()).toEqual(["u1"]);
    expect(inbox.read("user")).toBe(1);
  });

  test("close() leftovers do NOT count: they were never read", () => {
    const inbox = new AgentInbox();
    inbox.push("u1", "user");
    expect(inbox.drain()).toEqual(["u1"]);
    expect(inbox.read("user")).toBe(1);
    inbox.push("u2", "user");
    expect(inbox.close()).toEqual(["u2"]);
    expect(inbox.read("user")).toBe(1);
  });

  test("onRead fires on a non-empty drain/closeIfEmpty, never on an empty one or a close", () => {
    let reads = 0;
    const inbox = new AgentInbox({
      onRead: () => {
        reads += 1;
      },
    });
    // Empty: nothing entered the child's context, so nothing changed.
    expect(inbox.drain()).toEqual([]);
    expect(reads).toBe(0);
    inbox.push("u1", "user");
    expect(inbox.drain()).toEqual(["u1"]);
    expect(reads).toBe(1);
    inbox.push("u2", "user");
    expect(inbox.closeIfEmpty()).toEqual(["u2"]);
    expect(reads).toBe(2);
    // `close()` hands back what was never read: no read happened.
    inbox.push("u3", "user");
    expect(inbox.close()).toEqual(["u3"]);
    expect(reads).toBe(2);
  });
});
