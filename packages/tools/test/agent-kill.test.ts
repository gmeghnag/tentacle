/**
 * 6a-2 (docs/feat/subagent-background-ui.md Design 2, owner Q1 a): `agent_kill`,
 * the model's way to stop a background sub-agent it launched. The mirror of
 * `shell_kill`, wired only where the background runtime is.
 */
import { describe, expect, test } from "bun:test";
import { AgentJobs, type ToolContext } from "@tentacle/core";
import { createAgentKillTool } from "../src/background.ts";

const tick = () => new Promise((r) => setTimeout(r, 1));
const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;

function rig(cap = 2) {
  let n = 0;
  const ended: string[] = [];
  const jobs = new AgentJobs(cap);
  jobs.bind({
    launched: () => `sa-${++n}`,
    ended: (id, stop) => ended.push(`${id}:${stop}`),
  });
  const gate = Promise.withResolvers<{ report: string; toolUses: number; stopReason: string }>();
  let aborted = false;
  const signals: AbortSignal[] = [];
  jobs.start({ callId: "c1", agentType: "general", description: "map repo" }, async (c) => {
    signals.push(c.signal);
    c.signal.addEventListener("abort", () => {
      aborted = true;
    });
    return gate.promise;
  });
  return { jobs, ended, gate, signals, isAborted: () => aborted };
}

describe("T50: agent_kill", () => {
  test("kills a running background sub-agent: its signal aborts, its exit is cancelled", async () => {
    const r = rig();
    const tool = createAgentKillTool(r.jobs);
    expect(tool.name).toBe("agent_kill");
    expect(tool.permission).toBe("none");
    const out = await tool.execute({ agent_id: "sa-1" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toBe("killed background sub-agent sa-1");
    expect(r.isAborted()).toBe(true);
    r.gate.resolve({ report: "partial", toolUses: 1, stopReason: "end_turn" });
    await tick();
    // The end says how it ended: killed, not "finished".
    expect(r.ended).toEqual(["sa-1:cancelled"]);
    expect(r.jobs.rows()).toEqual([]);
  });

  test("a second kill, and an unknown id, say it was not running (never an error)", async () => {
    const r = rig();
    const tool = createAgentKillTool(r.jobs);
    await tool.execute({ agent_id: "sa-1" }, ctx);
    const again = await tool.execute({ agent_id: "sa-1" }, ctx);
    expect(again).toEqual({ content: "background sub-agent sa-1 was not running", isError: false });
    const unknown = await tool.execute({ agent_id: "sa-9" }, ctx);
    expect(unknown).toEqual({
      content: "background sub-agent sa-9 was not running",
      isError: false,
    });
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "cancelled" });
    await tick();
  });

  test("an ended child is not running either", async () => {
    const r = rig();
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
    const out = await createAgentKillTool(r.jobs).execute({ agent_id: "sa-1" }, ctx);
    expect(out.content).toBe("background sub-agent sa-1 was not running");
    expect(r.isAborted()).toBe(false);
  });

  test("a foreground child is not killable by id: it has none", async () => {
    const r = rig(2);
    expect(r.jobs.acquire("fg one").ok).toBe(true);
    const out = await createAgentKillTool(r.jobs).execute({ agent_id: "fg one" }, ctx);
    expect(out.content).toBe("background sub-agent fg one was not running");
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("the id argument is required and non-empty", () => {
    const r = rig();
    const tool = createAgentKillTool(r.jobs);
    expect(tool.inputSchema.safeParse({}).success).toBe(false);
    expect(tool.inputSchema.safeParse({ agent_id: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ agent_id: "sa-1" }).success).toBe(true);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
  });
});
