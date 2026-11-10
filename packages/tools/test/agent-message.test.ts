import { describe, expect, test } from "bun:test";
import {
  AGENT_INBOX_MAX,
  AGENT_MESSAGE_MAX_CHARS,
  AgentJobs,
  type ToolContext,
} from "@tentacle/core";
import { AGENT_MESSAGE_TOOL_NAME, createAgentMessageTool } from "../src/background.ts";

// docs/feat/agent-message.md T11: `agent_message`, the model's way to write into
// a running background sub-agent. Every refusal is a tool ERROR carrying the
// reason; a success says "queued", never "delivered" (a child waiting on a long
// call or a permission ask reads it after that).

const tick = () => new Promise((r) => setTimeout(r, 1));
const ctx = { sessionId: "s", signal: new AbortController().signal } as unknown as ToolContext;

function rig(cap = 2) {
  let n = 0;
  const jobs = new AgentJobs(cap);
  jobs.bind({ launched: () => `sa-${++n}`, ended: () => {} });
  const gate = Promise.withResolvers<{ report: string; toolUses: number; stopReason: string }>();
  let inbox: { drain(): string[]; closeIfEmpty(): string[]; closed: boolean } | undefined;
  jobs.start({ callId: "c1", agentType: "general", description: "map repo" }, async (c) => {
    inbox = c.inbox;
    return gate.promise;
  });
  return {
    jobs,
    gate,
    drain: () => inbox?.drain() ?? [],
  };
}

describe("T11: agent_message", () => {
  test("ok: 'queued for sa-1 …', never 'delivered', never an error", async () => {
    const r = rig();
    const tool = createAgentMessageTool(r.jobs);
    expect(tool.name).toBe(AGENT_MESSAGE_TOOL_NAME);
    expect(tool.permission).toBe("none");
    const out = await tool.execute({ agent_id: "sa-1", text: "also check X" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.content).toBe(
      "queued for sa-1: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.",
    );
    expect(out.content).not.toContain("delivered");
    expect(r.drain()).toEqual(["[message from the parent agent] also check X"]);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("an unknown id is an error with AgentJobs' reason, and nothing is queued", async () => {
    const r = rig();
    const out = await createAgentMessageTool(r.jobs).execute({ agent_id: "sa-9", text: "hi" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.content).toBe(
      "sa-9 is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.",
    );
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("a killed child, a closed inbox and the 8-message cap all refuse with their reason", async () => {
    const r = rig();
    const tool = createAgentMessageTool(r.jobs);
    for (let i = 1; i <= AGENT_INBOX_MAX; i++) {
      expect((await tool.execute({ agent_id: "sa-1", text: `m${i}` }, ctx)).isError).toBe(false);
    }
    const full = await tool.execute({ agent_id: "sa-1", text: "m9" }, ctx);
    expect(full.isError).toBe(true);
    expect(full.content).toBe(
      `sa-1 already has ${AGENT_INBOX_MAX} unread messages: nothing was sent. Wait for it to read them or for its report.`,
    );
    r.drain();
    r.jobs.kill("sa-1");
    const killed = await tool.execute({ agent_id: "sa-1", text: "hi" }, ctx);
    expect(killed.isError).toBe(true);
    expect(killed.content).toBe("sa-1 is being stopped: nothing was sent.");
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });

  test("an over-length text is an error naming the limit; the input is validated", async () => {
    const r = rig();
    const tool = createAgentMessageTool(r.jobs);
    expect(tool.inputSchema.safeParse({ agent_id: "sa-1" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ agent_id: "", text: "x" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ agent_id: "sa-1", text: "" }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ agent_id: "sa-1", text: "x" }).success).toBe(true);
    const long = await tool.execute(
      { agent_id: "sa-1", text: "x".repeat(AGENT_MESSAGE_MAX_CHARS + 1) },
      ctx,
    );
    expect(long.isError).toBe(true);
    expect(long.content).toContain("nothing was sent");
    expect(long.content).toContain(`${AGENT_MESSAGE_MAX_CHARS}`);
    expect(r.drain()).toEqual([]);
    r.gate.resolve({ report: "r", toolUses: 0, stopReason: "end_turn" });
    await tick();
  });
});
