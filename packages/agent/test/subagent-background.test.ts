import { describe, expect, test } from "bun:test";
import {
  AgentJobs,
  type BackgroundJob,
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
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

/** A `JobController` whose exits the test fires by hand (a shell job mid-turn). */
function controllableJobs(): JobController & { fireExit(job: BackgroundJob): void } {
  const listeners = new Set<(job: BackgroundJob) => void>();
  return {
    fireExit(job) {
      for (const l of listeners) {
        l(job);
      }
    },
    start: () => ({
      id: "bg-1",
      command: "serve",
      startedAt: 0,
      status: "running",
      exitCode: null,
    }),
    read: () => undefined,
    kill: () => false,
    list: () => [],
    dispose: () => {},
    onStart: () => () => {},
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

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
    // The wiring `agent_control status` reads: the record says the report is in
    // hand. Mutation: drop `agentJobs?.delivered(...)` from `subagentExitNote` →
    // this stays `false` and `status` tells the model to wait for a note it
    // already holds → red (docs/fix/subagent-error-report.md, Review 1 finding 1).
    expect(jobs.ended("sa-1")?.delivered).toBe(true);
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

// docs/fix/subagent-error-report.md root cause A, tests 1-4: a child that ends
// while the parent's turn RUNS is delivered at the next round boundary, in that
// same turn — never only at the next turn's start.
describe("A: a sub-agent exit that lands mid-turn", () => {
  /** A provider whose rounds are functions, so a round can act while it streams. */
  function actingProvider(
    rounds: readonly ((
      round: number,
    ) => Promise<readonly StreamEvent[]> | readonly StreamEvent[])[],
  ) {
    const seen: ChatRequest[] = [];
    let i = 0;
    const model: ModelProvider = {
      id: "acting",
      async *stream(request) {
        seen.push(request);
        const script = rounds[Math.min(i, rounds.length - 1)];
        i += 1;
        const events = script === undefined ? [{ type: "done" } as StreamEvent] : await script(i);
        for (const event of events) {
          yield event;
        }
      },
    };
    return { model, seen };
  }

  const say = (text: string): readonly StreamEvent[] => [
    { type: "text", delta: text },
    { type: "done" },
  ];

  /** A tool that runs `whileRunning` (the child's whole life) and then returns. */
  function probeTool(whileRunning: () => Promise<void>) {
    return {
      name: "probe",
      description: "slow",
      inputSchema: createTaskTool(async () => ({ report: "", toolUses: 0, stopReason: "x" }), [])
        .inputSchema as never,
      permission: "none" as const,
      execute: async () => {
        await whileRunning();
        return { content: "probe done" };
      },
    };
  }

  const probeCall: StreamEvent = {
    type: "tool_call",
    toolCall: {
      id: "p2",
      name: "probe",
      arguments: JSON.stringify({ description: "d", prompt: "p" }),
    },
  };

  /** The child ends inside the probe: `pendingExits` has it before the boundary. */
  const endsDuringProbe =
    (jobs: AgentJobs, report = "CHILD REPORT") =>
    async () => {
      jobs.start({ callId: "c1", agentType: "general", description: "trace smem" }, async () => ({
        report,
        toolUses: 7,
        stopReason: "end_turn",
      }));
      await tick();
    };

  test("it is delivered at the next round boundary, and nothing stays queued", async () => {
    // Mutation: leave exits out of the mid-turn drain (`flushMidTurn`) →
    // the parent's next request has no note and `pendingExitCount` is 1 → red.
    const jobs = agentJobsRig();
    const { model, seen } = actingProvider([
      () => [
        {
          type: "tool_call",
          toolCall: {
            id: "p1",
            name: "agent_task",
            arguments: JSON.stringify({
              description: "trace smem",
              prompt: "go",
              background: true,
            }),
          },
        },
        { type: "done" },
      ],
      () => [probeCall, { type: "done" }],
      () => say("done"),
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry()
        .register(
          createTaskTool(async () => ({ report: "", toolUses: 0, stopReason: "x" }), []) as never,
        )
        .register(probeTool(endsDuringProbe(jobs)) as never),
      env,
      agentJobs: jobs,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "investigate" }];
    const events = await drain(agent, messages);
    // The exit reached the conversation as a note, in THIS turn.
    const note = messages.find((m) => m.note?.kind === "subagent_report");
    expect(note?.content).toContain("[background] sub-agent sa-1 (trace smem)");
    expect(note?.content).toContain("CHILD REPORT");
    // The parent's request AFTER the probe carried it (round 3, not a wake turn).
    const withNote = seen.filter((r) =>
      r.messages.some((m) => typeof m.content === "string" && m.content.includes("CHILD REPORT")),
    );
    expect(withNote.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(3);
    // The event stream said so too, and the queue is empty.
    expect(events.filter((e) => e.type === "background_exit")).toHaveLength(1);
    expect(agent.pendingExitCount).toBe(0);
    // …and the MID-TURN drain flips the same record (the start flush's own
    // `delivered` assertion is in T16 above): mutation → `false`, `status`
    // promises a note already in history → red.
    expect(jobs.ended("sa-1")?.delivered).toBe(true);
  });

  test("an exit that lands during the final answer's round gets one more round", async () => {
    // Mutation: remove the late drain's exit branch (`agent.ts` late drain) →
    // the turn ends after round 2 and the note waits for a wake turn → red.
    const jobs = agentJobsRig();
    const { model, seen } = actingProvider([
      () => [probeCall, { type: "done" }],
      async () => {
        // The child ends WHILE this last round streams.
        jobs.start({ callId: "c1", agentType: "general", description: "late" }, async () => ({
          report: "LATE REPORT",
          toolUses: 2,
          stopReason: "end_turn",
        }));
        await tick();
        return say("the answer");
      },
      () => say("reacted"),
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(probeTool(async () => {}) as never),
      env,
      agentJobs: jobs,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drain(agent, messages);
    expect(seen).toHaveLength(3);
    expect(seen[2]?.messages.some((m) => m.content.includes("LATE REPORT"))).toBe(true);
    expect(events.filter((e) => e.type === "background_exit")).toHaveLength(1);
    expect(agent.pendingExitCount).toBe(0);
  });

  test("a shell job's exit is still delivered at the turn's start only (Q1's scope)", async () => {
    // Mutation: drain EVERY exit mid-turn → the shell job's note lands in this
    // turn and the turn-start flush has nothing left → red.
    const model = new ScriptedProvider([
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
      [{ type: "text", delta: "answer" }, { type: "done" }],
    ]);
    const shellJobs = controllableJobs();
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(
        probeTool(async () => {
          shellJobs.fireExit({
            id: "bg-1",
            command: "serve",
            startedAt: 0,
            status: "exited",
            exitCode: 0,
          });
        }) as never,
      ),
      env,
      jobs: shellJobs,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drain(agent, messages);
    // A shell job's note is NOT in this turn, and it stays queued for the next.
    expect(messages.some((m) => m.content.includes("shell_output"))).toBe(false);
    expect(agent.pendingExitCount).toBe(1);
    expect(events.filter((e) => e.type === "background_exit")).toHaveLength(0);
  });

  test("the continuation a client armed ends with no model request (stale-wake guard)", async () => {
    // Mutation: don't set `notesFlushedMidTurn` on the mid-turn exit delivery →
    // the armed continuation runs a round over nothing new → red.
    const jobs = agentJobsRig();
    const { model, seen } = actingProvider([
      () => [probeCall, { type: "done" }],
      () => say("answer"),
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(probeTool(endsDuringProbe(jobs)) as never),
      env,
      agentJobs: jobs,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    await drain(agent, messages);
    const rounds = seen.length;
    // The wake the live notice armed: a continuation, no user message, a final
    // answer at the end of the history.
    const wake = await drain(agent, messages);
    expect(seen).toHaveLength(rounds);
    expect(wake.filter((e) => e.type === "turn_end")).toHaveLength(1);
  });
});
