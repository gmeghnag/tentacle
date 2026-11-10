import { describe, expect, test } from "bun:test";
import {
  AGENT_MESSAGE_MAX_CHARS,
  AGENT_NOTIFY_PER_CHILD,
  AgentJobs,
  type AgentNotifyResult,
  type ToolContext,
} from "@tentacle/core";
import { AGENT_NOTIFY_TOOL_NAME, createAgentNotifyTool } from "../src/background.ts";

// docs/feat/agent-message-two-way.md T11: `agent_notify`, a running BACKGROUND
// child's way back to the agent that launched it. Every refusal is a tool ERROR
// carrying the reason; a success says how it will be read, never "answered".

const tick = () => new Promise((r) => setTimeout(r, 1));
const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;

function rig() {
  let n = 0;
  const jobs = new AgentJobs(2);
  jobs.bind({ launched: () => `sa-${++n}`, ended: () => {} });
  const notes: unknown[] = [];
  jobs.onNotify((note) => notes.push(note));
  const gate = Promise.withResolvers<{ report: string; toolUses: number; stopReason: string }>();
  const started = jobs.start(
    { callId: "c1", agentType: "general", description: "map repo" },
    () => gate.promise,
  );
  if (!started.ok) {
    throw new Error("the child did not start");
  }
  const tool = createAgentNotifyTool(started.agentId, (id, text) => jobs.notify(id, text));
  return {
    jobs,
    tool,
    notes,
    gate,
    agentId: started.agentId,
  };
}

describe("T11: agent_notify", () => {
  test("ok + wake says it reads it now; never 'answered'", async () => {
    const r = rig();
    expect(r.tool.name).toBe(AGENT_NOTIFY_TOOL_NAME);
    expect(r.tool.permission).toBe("none");
    const out = await r.tool.execute({ text: "found X" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      "sent to the parent agent (it reads it at its next step, now if it is idle). Keep working.",
    );
    expect(out.content).not.toContain("answered");
    expect(r.notes).toHaveLength(1);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("ok without a wake says so, and still says it will be read", async () => {
    const r = rig();
    // Spend the wake budget (3), then the 4th is delivered without a wake.
    for (let i = 0; i < 3; i++) {
      await r.tool.execute({ text: `n${i}` }, ctx);
    }
    const out = await r.tool.execute({ text: "quiet" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      "sent to the parent agent; it is not woken now (too many wakes since the user last wrote), it reads it at its next step. Keep working.",
    );
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("a refusal is an error carrying the reason, and nothing reaches the parent", async () => {
    const r = rig();
    // The 9th notify from one child is over the per-child cap.
    for (let i = 0; i < AGENT_NOTIFY_PER_CHILD; i++) {
      expect((await r.tool.execute({ text: `n${i}` }, ctx)).isError).toBe(false);
    }
    const over = await r.tool.execute({ text: "one more" }, ctx);
    expect(over.isError).toBe(true);
    expect(over.content).toContain("Put the rest in your final report.");
    expect(r.notes).toHaveLength(AGENT_NOTIFY_PER_CHILD);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("an injected notify returning a refusal is passed through verbatim", async () => {
    const refusal: AgentNotifyResult = { ok: false, reason: "the session is closing" };
    const tool = createAgentNotifyTool("sa-1", () => refusal);
    const out = await tool.execute({ text: "hi" }, ctx);
    expect(out).toEqual({ content: "the session is closing", isError: true });
  });

  test("the input is validated: text is required and non-empty", async () => {
    const r = rig();
    expect(r.tool.inputSchema.safeParse({}).success).toBe(false);
    expect(r.tool.inputSchema.safeParse({ text: "" }).success).toBe(false);
    expect(r.tool.inputSchema.safeParse({ text: "x" }).success).toBe(true);
    const long = await r.tool.execute({ text: "x".repeat(AGENT_MESSAGE_MAX_CHARS + 1) }, ctx);
    expect(long.isError).toBe(true);
    expect(long.content).toContain("nothing was sent");
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });
});
