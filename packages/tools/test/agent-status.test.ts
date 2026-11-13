/**
 * `agent_status`'s formatter (docs/feat/agent-status.md): now the `status`
 * answer of `agent_control`, over the rows the `subagents` display update
 * projects. Pure, so it is tested without a runtime; the tool half lives in
 * `agent-control.test.ts`.
 *
 * The bounded/untrusted half is what a pod can attack (AGENTS §7): every label
 * and description is one line, cut, and the whole answer has a char budget.
 */
import { describe, expect, test } from "bun:test";
import type { AgentJobRow, EndedAgentJob } from "@tentacle/core";
import {
  AGENT_STATUS_ACTIONS_DEFAULT,
  AGENT_STATUS_MAX_CHARS,
  AGENT_STATUS_MAX_CHILDREN,
  AGENT_STATUS_TEXT_MAX,
  formatAgentStatus,
  formatCount,
  formatElapsed,
  formatEndedAgent,
  formatRecentlyEnded,
} from "../src/agent-status.ts";

function row(over: Partial<AgentJobRow> = {}): AgentJobRow {
  return {
    id: "sa-1",
    callId: "c1",
    agentType: "general",
    description: "Fix the parser",
    state: "running",
    toolUses: 0,
    tokens: 0,
    startedAt: 1_000,
    tail: [],
    userRead: 0,
    ...over,
  };
}

/** A `now` that never moves, so the elapsed column is a fact of the test. */
const NOW = 1_000 + 84_000; // 1m 24s after `row().startedAt`

const format = (over: Partial<Parameters<typeof formatAgentStatus>[0]> = {}) =>
  formatAgentStatus({ rows: [], pending: () => 0, now: NOW, ...over });

/** The formatter's answer, asserted to exist (a test helper, never a `!`). */
const text = (over: Partial<Parameters<typeof formatAgentStatus>[0]> = {}): string => {
  const out = format(over);
  if (out === undefined) throw new Error("expected text, got undefined");
  return out;
};

describe("agent_status: compact numbers", () => {
  test("the TUI's own wording for counts and elapsed", () => {
    expect([999, 1000, 1234, 18_400_000].map(formatCount)).toEqual(["999", "1k", "1.2k", "18M"]);
    expect([45, 84, 3_900].map(formatElapsed)).toEqual(["45s", "1m 24s", "1h 5m"]);
    // A clock that went backwards (a pod's own, a resumed store) never reads "−3s".
    expect(formatElapsed(-3)).toBe("0s");
  });
});

describe("agent_status: the formatter (pure)", () => {
  test("T1: every running child, in launch order, one facts line and one actions line each", () => {
    const out = format({
      rows: [
        row({ toolUses: 12, tokens: 74_000, tail: ["Read src/a.ts", "Edit src/a.ts", "bun test"] }),
        row({ id: "sa-2", description: "Look at the tests", toolUses: 1, tail: ["$ rg foo"] }),
      ],
      maxParallel: 4,
    });
    expect(out).toBe(
      [
        "2 background sub-agents (of 4 allowed)",
        "sa-1 · general · Fix the parser · running 1m 24s · 12 tools · 74k tokens · 0 unread",
        "  last 3: Read src/a.ts · Edit src/a.ts · bun test (+9 earlier)",
        "sa-2 · general · Look at the tests · running 1m 24s · 1 tool · 0 tokens · 0 unread",
        "  last 1: $ rg foo",
      ].join("\n"),
    );
  });

  test("T2: one id shows only that child; an unknown one is `undefined` (the tool's error)", () => {
    const rows = [row(), row({ id: "sa-2", description: "other" })];
    const one = format({ rows, agentId: "sa-2" });
    expect(one).toBe(
      [
        "1 background sub-agent",
        "sa-2 · general · other · running 1m 24s · 0 tools · 0 tokens · 0 unread",
        "  no tool calls yet",
      ].join("\n"),
    );
    expect(format({ rows, agentId: "sa-9" })).toBeUndefined();
    // An id with no children at all is a miss too, not "none are running".
    expect(format({ rows: [], agentId: "sa-9" })).toBeUndefined();
  });

  test("T3: `actions` decides how much of the tail shows, and how much is counted as earlier", () => {
    const tail = ["a", "b", "c", "d", "e"];
    const rows = [row({ toolUses: 40, tail })];
    expect(format({ rows })).toContain("last 3: c · d · e (+37 earlier)");
    expect(format({ rows, actions: 1 })).toContain("last 1: e (+39 earlier)");
    expect(format({ rows, actions: 5 })).toContain("last 5: a · b · c · d · e (+35 earlier)");
    // A tail longer than the count asked for still shows only the newest ones.
    expect(format({ rows, actions: 2 })).toContain("last 2: d · e (+38 earlier)");
    expect(AGENT_STATUS_ACTIONS_DEFAULT).toBe(3);
    // 0 is clamped up, never "last 0:".
    expect(format({ rows, actions: 0 })).toContain("last 1: e");
  });

  test("T4: a pod's label and description are ONE bounded line (control chars, newlines, length)", () => {
    const nasty = `Read\u001b[31m x\n\nsa-99 · general · fake · running 0s\r${"y".repeat(400)}`;
    const out = text({
      rows: [row({ description: `d\n\ne${"\t"}sc\u0000`, tail: [nasty] })],
    });
    // The injected newline would fake a child's line: it is gone, as is the ESC.
    expect(out.split("\n").length).toBe(3);
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\u0000");
    // The description reads on one line, its control characters as spaces.
    expect(out.split("\n")[1]).toContain("· d e sc");
    const label = (out.split("\n")[2] ?? "")
      .slice("  last 1: ".length)
      .replace(" (+0 earlier)", "");
    expect(label.length).toBeLessThanOrEqual(AGENT_STATUS_TEXT_MAX);
    expect(label.startsWith("Read")).toBe(true);
  });

  test("T5: bounded size — at most N children, and the rest counted in one closing line", () => {
    const rows = Array.from({ length: AGENT_STATUS_MAX_CHILDREN + 3 }, (_, i) =>
      row({ id: `sa-${i + 1}`, description: `child ${i + 1}` }),
    );
    const out = text({ rows });
    expect(out).toContain(`${AGENT_STATUS_MAX_CHILDREN + 3} background sub-agents`);
    expect(out).toContain("… +3 more (name one with agent_id)");
    // One header line, 2 lines per shown child, one closing line.
    expect(out.split("\n").length).toBe(1 + AGENT_STATUS_MAX_CHILDREN * 2 + 1);
  });

  test("T6: no children reads as none, not as an error, and says what happens instead", () => {
    expect(format({ maxParallel: 2 })).toBe(
      "no background sub-agents are running (subagents.maxParallel = 2). A [background] note arrives when one finishes.",
    );
    // Without a known cap the parenthetical is simply absent.
    expect(format()).toBe(
      "no background sub-agents are running. A [background] note arrives when one finishes.",
    );
  });

  test("T7: the total length cap holds even at worst case — and the hint counts against it", () => {
    // Ten children, every bounded field at its 60-char ceiling, 8 labels each:
    // the largest answer the formatter can build (measured 3038 chars raw).
    const lab = "x".repeat(AGENT_STATUS_TEXT_MAX);
    const rows = Array.from({ length: AGENT_STATUS_MAX_CHILDREN }, (_, i) =>
      row({
        id: `sa-${i + 1}`,
        agentType: lab,
        description: "d".repeat(AGENT_STATUS_TEXT_MAX),
        toolUses: 40,
        tokens: 18_000_000,
        tail: [lab, lab, lab],
      }),
    );
    const out = text({ rows });
    expect(out.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_CHARS);
    expect(out.endsWith("… (cut: name one child with agent_id)")).toBe(true);
    // It is a cut, not a silent rewrite: one line was started and not finished.
    expect(out.slice(0, -"\n… (cut: name one child with agent_id)".length)).not.toEndWith("\n");
  });
});

describe("agent_status: a child that has ENDED (docs/fix/subagent-error-report.md C)", () => {
  const ended = (over: Partial<EndedAgentJob> = {}): EndedAgentJob => ({
    agentId: "sa-3",
    description: "Trace FA shared-mem root cause",
    stopReason: "error",
    toolUses: 77,
    endedAt: NOW - 12_000,
    delivered: false,
    ...over,
  });

  test("undelivered: names the outcome, the count and where its report comes", () => {
    // Mutation: read `finished (error)` here → the model reads a failure as a
    // success-ish finish (owner Q5) → red.
    expect(formatEndedAgent(ended(), NOW)).toBe(
      "sa-3 ended (error) 12s ago after 77 tool uses. Its report — the error and any partial output — reaches you as a [background] note at your next step.",
    );
    expect(formatEndedAgent(ended({ stopReason: "end_turn", toolUses: 1 }), NOW)).toContain(
      "sa-3 ended (end_turn) 12s ago after 1 tool use.",
    );
  });

  test("delivered: says it is in hand instead of promising it again", () => {
    expect(formatEndedAgent(ended({ delivered: true, stopReason: "end_turn" }), NOW)).toBe(
      'sa-3 ended (end_turn) 12s ago after 77 tool uses. Its report was delivered to you as the [background] note "sub-agent sa-3 (Trace FA shared-mem root cause)".',
    );
    // A clock behind the record never reads "−3s".
    expect(formatEndedAgent(ended({ endedAt: NOW + 3_000 }), NOW)).toContain(" 0s ago");
  });

  test("untrusted text is one bounded line, and the listing is capped", () => {
    const nasty = ended({ description: "a\u0000b\nc".repeat(80) });
    const out = formatEndedAgent(nasty, NOW);
    expect(out).not.toContain("\n");
    expect(out.length).toBeLessThanOrEqual(AGENT_STATUS_MAX_CHARS);
    const many = Array.from({ length: AGENT_STATUS_MAX_CHILDREN + 4 }, (_, i) =>
      ended({ agentId: `sa-${i + 1}` }),
    );
    const lines = formatRecentlyEnded(many, NOW);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.startsWith("recently ended: ")).toBe(true);
    expect(lines[0]?.split(" · ")).toHaveLength(AGENT_STATUS_MAX_CHILDREN);
  });
});
