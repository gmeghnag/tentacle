import { describe, expect, test } from "bun:test";
import {
  AgentJobs,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  type StreamEvent,
  type ToolResult,
} from "@tentacle/core";
import { ToolRegistry, createTaskTool, shellTool } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { createSubagentRunner, subagentRequester } from "../src/subagent.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request);
    const events = this.script[this.turn++] ?? [{ type: "text", delta: "ok" }, { type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "ran", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
const tick = () => new Promise((r) => setTimeout(r, 1));

function agentJobsRig(cap = 2) {
  let n = 0;
  const jobs = new AgentJobs(cap);
  jobs.bind({ launched: () => `sa-${++n}`, ended: () => {} });
  return jobs;
}

async function drain(agent: Agent, messages: ChatMessage[]): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.runMessages(messages, "s1")) {
    events.push(event);
  }
  return events;
}

describe("the child's requester (T15)", () => {
  test("forwards the child's signal and id for a background child; origin stays subagent", () => {
    const seen: unknown[] = [];
    const wrapped = subagentRequester(
      async (_req, options) => {
        seen.push(options);
        return { allowed: true };
      },
      "task-1",
      { type: "general", description: "map" },
      { id: "sa-1", signal: new AbortController().signal },
    );
    void wrapped({ tool: "shell", level: "ask", title: "t", input: {} }, { signal: undefined });
    const options = seen[0] as {
      signal?: AbortSignal;
      origin?: string;
      agent?: { type?: string; description?: string; id?: string };
      toolCallId?: string;
    };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.origin).toBe("subagent");
    expect(options.agent).toEqual({ type: "general", description: "map", id: "sa-1" });
    expect(options.toolCallId).toBe("task-1");
  });

  test("a foreground child's ask is unchanged: no id, no signal", () => {
    const seen: unknown[] = [];
    const wrapped = subagentRequester(
      async (_req, options) => {
        seen.push(options);
        return { allowed: true };
      },
      "task-1",
      { type: "general", description: "map" },
    );
    void wrapped({ tool: "shell", level: "ask", title: "t", input: {} });
    expect(seen[0]).toEqual({
      toolCallId: "task-1",
      origin: "subagent",
      agent: { type: "general", description: "map" },
    });
  });

  test("through the runner: agentId + signal controls reach the ask; the signal is the child's own", async () => {
    const seen: { signal?: AbortSignal; agent?: { id?: string } }[] = [];
    const childModel = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: { id: "k1", name: "shell", arguments: JSON.stringify({ command: "ls" }) },
        },
        { type: "done" },
      ],
    ]);
    const { run } = createSubagentRunner({
      model: childModel,
      env,
      tools: new ToolRegistry().register(shellTool),
      requestPermission: async (_req, options) => {
        seen.push(options ?? {});
        return { allowed: false };
      },
    });
    const own = new AbortController();
    await run(
      { description: "map", prompt: "go", type: "general" },
      { signal: own.signal, agentId: "sa-7", toolCallId: "task-9" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agent?.id).toBe("sa-7");
    expect(seen[0]?.signal).toBe(own.signal);
  });
});

describe("a sub-agent's exit in the parent agent (T16, T17)", () => {
  test("it counts, and the next turn flushes ONE noted report before the first model round", async () => {
    const jobs = agentJobsRig();
    const model = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const agent = new Agent({ model, tools: new ToolRegistry(), env, agentJobs: jobs });
    jobs.start({ callId: "c1", agentType: "general", description: "map repo" }, async () => ({
      report: "THE REPORT",
      toolUses: 3,
      stopReason: "end_turn",
    }));
    await tick();
    expect(agent.pendingExitCount).toBe(1);

    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const events = await drain(agent, messages);
    expect(agent.pendingExitCount).toBe(0);

    const exit = events.find((e) => e.type === "background_exit");
    expect(exit).toMatchObject({
      jobId: "sa-1",
      command: "map repo",
      status: "exited",
      exitCode: null,
      agent: { stopReason: "end_turn", toolUses: 3 },
    });
    const note = messages.find((m) => m.note?.kind === "subagent_report");
    expect(note?.note).toEqual({ kind: "subagent_report", id: "sa-1" });
    expect(note?.content).toBe(
      "[background] sub-agent sa-1 (map repo) finished (end_turn):\nTHE REPORT",
    );
    // ONE note, and the model saw it in its first request.
    expect(messages.filter((m) => m.note !== undefined)).toHaveLength(1);
    const first = model.seen[0]?.messages.map((m) => m.content).join("\n") ?? "";
    expect(first).toContain("THE REPORT");
    // A cancelled child reads as killed on the wire.
    jobs.start({ callId: "c2", agentType: "general", description: "x" }, async () => ({
      report: "",
      toolUses: 0,
      stopReason: "cancelled",
    }));
    await tick();
    const second = await drain(agent, [{ role: "user", content: "again" }]);
    expect(second.find((e) => e.type === "background_exit")).toMatchObject({
      jobId: "sa-2",
      status: "killed",
    });
  });

  test("retire/adopt carry agent exits to the next agent, and the old agent stops collecting", async () => {
    const jobs = agentJobsRig();
    const make = () =>
      new Agent({
        model: new ScriptedProvider([]),
        tools: new ToolRegistry(),
        env,
        agentJobs: jobs,
      });
    const old = make();
    jobs.start({ callId: "c1", agentType: "general", description: "one" }, async () => ({
      report: "R1",
      toolUses: 0,
      stopReason: "end_turn",
    }));
    await tick();
    const carried = old.retire();
    expect(carried).toHaveLength(1);
    const next = make();
    next.adoptExits(carried);
    expect(next.pendingExitCount).toBe(1);
    jobs.start({ callId: "c2", agentType: "general", description: "two" }, async () => ({
      report: "R2",
      toolUses: 0,
      stopReason: "end_turn",
    }));
    await tick();
    // The retired agent collects nothing more; the new one gets it.
    expect(old.pendingExitCount).toBe(0);
    expect(next.pendingExitCount).toBe(2);
  });
});

describe("shapeResult in the tool context (T14 support)", () => {
  test("a tool can run the loop's result transforms on its own text after returning", async () => {
    const shaped: ToolResult[] = [];
    let captured: ((r: ToolResult) => Promise<ToolResult>) | undefined;
    const tools = new ToolRegistry().register({
      name: "probe",
      description: "d",
      inputSchema: createTaskTool(async () => ({ report: "", toolUses: 0, stopReason: "x" }), [])
        .inputSchema as never,
      permission: "none",
      execute: async (_i, ctx) => {
        captured = ctx.shapeResult;
        return { content: "x" };
      },
    });
    const agent = new Agent({
      model: new ScriptedProvider([
        [
          {
            type: "tool_call",
            toolCall: {
              id: "p1",
              name: "probe",
              arguments: JSON.stringify({ description: "d", prompt: "p" }),
            },
          },
          { type: "done" },
        ],
      ]),
      tools,
      env,
      resultTransforms: [
        async (result) => {
          shaped.push(result);
          return { ...result, content: `[t] ${result.content}` };
        },
      ],
    });
    await drain(agent, [{ role: "user", content: "go" }]);
    expect(captured).toBeDefined();
    const out = await captured?.({ content: "secret" });
    expect(out?.content).toBe("[t] secret");
  });

  test("also in a parallel group (the second ctx builder)", async () => {
    const captured: (((r: ToolResult) => Promise<ToolResult>) | undefined)[] = [];
    const probe = {
      name: "probe",
      description: "d",
      inputSchema: createTaskTool(async () => ({ report: "", toolUses: 0, stopReason: "x" }), [])
        .inputSchema as never,
      permission: "none" as const,
      concurrency: () => [] as never,
      execute: async (
        _i: unknown,
        ctx: { shapeResult?: (r: ToolResult) => Promise<ToolResult> },
      ) => {
        captured.push(ctx.shapeResult);
        return { content: "x" };
      },
    };
    const call = (id: string): StreamEvent => ({
      type: "tool_call",
      toolCall: {
        id,
        name: "probe",
        arguments: JSON.stringify({ description: "d", prompt: "p" }),
      },
    });
    const agent = new Agent({
      model: new ScriptedProvider([[call("p1"), call("p2"), { type: "done" }]]),
      tools: new ToolRegistry().register(probe as never),
      env,
      toolExecution: { mode: "parallel", maxParallel: 2 },
      resultTransforms: [async (result) => ({ ...result, content: `[t] ${result.content}` })],
    });
    await drain(agent, [{ role: "user", content: "go" }]);
    expect(captured).toHaveLength(2);
    expect((await captured[0]?.({ content: "s" }))?.content).toBe("[t] s");
    expect((await captured[1]?.({ content: "s" }))?.content).toBe("[t] s");
  });
});
