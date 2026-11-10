/**
 * `agent_status` (docs/feat/agent-status.md): the pure formatter, then the tool
 * on a REAL `AgentJobs` — the same rows the `subagents` display update projects.
 *
 * The bounded/untrusted half is what a pod can attack (AGENTS §7): every label
 * and description is one line, cut, and the whole answer has a char budget.
 */
import { describe, expect, test } from "bun:test";
import { type AgentJobRow, AgentJobs, type ToolContext } from "@tentacle/core";
import {
  AGENT_STATUS_ACTIONS_DEFAULT,
  AGENT_STATUS_MAX_CHARS,
  AGENT_STATUS_MAX_CHILDREN,
  AGENT_STATUS_TEXT_MAX,
  AGENT_STATUS_TOOL_NAME,
  createAgentStatusTool,
  formatAgentStatus,
  formatCount,
  formatElapsed,
} from "../src/agent-status.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));
const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;

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

/** A real runtime: one child, a gate to finish it, and the progress a run emits. */
function rig(cap = 2) {
  let n = 0;
  const jobs = new AgentJobs(cap);
  jobs.bind({
    launched: () => `sa-${++n}`,
    ended: () => {},
    now: () => 1_000,
  });
  const gate = Promise.withResolvers<{ report: string; toolUses: number; stopReason: string }>();
  const started = jobs.start(
    { callId: "c1", agentType: "general", description: "Fix the parser" },
    async () => gate.promise,
  );
  if (!started.ok) throw new Error(started.reason);
  const id = started.agentId;
  return { jobs, gate, id };
}

describe("agent_status: the tool on real AgentJobs state", () => {
  test("T7: a running child — its own tool uses, tokens, labels and unread messages", async () => {
    const r = rig(4);
    for (const label of ["Read src/a.ts", "Edit src/a.ts", "$ bun test"]) {
      r.jobs.progress(r.id, { kind: "subagent_tool", label });
    }
    r.jobs.progress(r.id, {
      kind: "subagent_usage",
      promptTokens: 70_000,
      completionTokens: 4_000,
    });
    expect(r.jobs.message(r.id, "try the other file", "agent").ok).toBe(true);

    const out = await createAgentStatusTool(r.jobs, { now: () => NOW }).execute({}, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      [
        "1 background sub-agent (of 4 allowed)",
        "sa-1 · general · Fix the parser · running 1m 24s · 3 tools · 74k tokens · 1 unread",
        "  last 3: Read src/a.ts · Edit src/a.ts · $ bun test",
      ].join("\n"),
    );
    // The unread count is the inbox's own, not a copy: draining it clears the field.
    r.jobs.progress(r.id, { kind: "subagent_tool", label: "Read src/b.ts" });
    r.gate.resolve({ report: "done", toolUses: 4, stopReason: "end_turn" });
    await tick();
    expect(r.jobs.pending(r.id)).toBe(0);
  });

  test("T8: a finished child, and an id that never existed, are a tool ERROR naming the id", async () => {
    const r = rig();
    const tool = createAgentStatusTool(r.jobs);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
    const miss = (id: string) =>
      `no such background sub-agent: ${id} — it finished, was stopped, or never existed. If it just finished, its report arrives as a [background] note.`;
    const ended = await tool.execute({ agent_id: r.id }, ctx);
    expect(ended).toEqual({ content: miss(r.id), isError: true });
    expect(await tool.execute({ agent_id: "sa-9" }, ctx)).toEqual({
      content: miss("sa-9"),
      isError: true,
    });
  });

  test("T9: with nothing running it is not an error — it says so and how the report arrives", async () => {
    const jobs = new AgentJobs(1);
    jobs.bind({ launched: () => "sa-1", ended: () => {} });
    const out = await createAgentStatusTool(jobs).execute({}, ctx);
    expect(out).toEqual({
      content:
        "no background sub-agents are running (subagents.maxParallel = 1). A [background] note arrives when one finishes.",
      isError: false,
    });
  });

  test("T10: read-only, and cheap — a read key, no permission, and bounded arguments", () => {
    const r = rig();
    const tool = createAgentStatusTool(r.jobs);
    expect(tool.name).toBe(AGENT_STATUS_TOOL_NAME);
    expect(tool.name).toBe("agent_status");
    expect(tool.permission).toBe("none");
    expect(tool.concurrency).toBeFunction();
    expect(tool.concurrency === "exclusive" ? "exclusive" : tool.concurrency?.({})).toEqual([
      { mode: "read", resource: "subagents" },
    ]);
    expect(tool.inputSchema.safeParse({}).success).toBe(true);
    expect(tool.inputSchema.safeParse({ agent_id: "sa-1", actions: 5 }).success).toBe(true);
    expect(tool.inputSchema.safeParse({ agent_id: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ actions: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ actions: 9 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ actions: 1.5 }).success).toBe(false);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
  });
});
