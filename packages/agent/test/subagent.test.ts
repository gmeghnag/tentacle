import { describe, expect, test } from "bun:test";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import {
  CONTEXT_RESET_TOOL_NAME,
  ToolRegistry,
  createContextResetTool,
  createTaskTool,
  fsReadTool,
  shellTool,
} from "@tentacle/tools";
import { Agent } from "../src/agent.ts";
import { HookRunner } from "../src/hooks.ts";
import {
  BUILTIN_AGENT_TYPES,
  childToolLabel,
  createSubagentRunner,
  subagentRequester,
} from "../src/subagent.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

function recordingEnv() {
  const execCalls: string[] = [];
  const readCalls: string[] = [];
  const env: ExecutionEnvironment = {
    id: "rec",
    async exec(command) {
      execCalls.push(command);
      return { stdout: "ran", stderr: "", exitCode: 0 };
    },
    async readFile(path) {
      readCalls.push(path);
      return "FILE CONTENTS";
    },
    async writeFile() {},
  };
  return { env, execCalls, readCalls };
}

const toolCall = (name: string, args: unknown): StreamEvent => ({
  type: "tool_call",
  toolCall: { id: "c1", name, arguments: JSON.stringify(args) },
});

function fullRegistry(): ToolRegistry {
  return new ToolRegistry().register(fsReadTool).register(shellTool);
}

describe("createSubagentRunner", () => {
  test("a child's hooks run with its identity in the input (H2)", async () => {
    const stdins: unknown[] = [];
    const env: ExecutionEnvironment = {
      id: "hk",
      async exec(command, options) {
        if (command === "audit") {
          stdins.push(JSON.parse(options?.stdin ?? "null"));
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([[toolCall("shell", { command: "ls" }), { type: "done" }]]),
      env,
      tools: fullRegistry(),
      hooks: new HookRunner({ specs: [{ event: "tool_call", command: "audit" }], env, cwd: "/w" }),
    });
    await run({ description: "scan repo", prompt: "look", type: "general" });
    expect(stdins).toMatchObject([
      { agent: { type: "general", description: "scan repo" }, tool_name: "shell" },
    ]);
  });

  test("a child with a model override reports ITS model id to model_request hooks", async () => {
    const models: unknown[] = [];
    const env: ExecutionEnvironment = {
      id: "hk",
      async exec(_command, options) {
        models.push((JSON.parse(options?.stdin ?? "null") as { model: unknown }).model);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    const first = BUILTIN_AGENT_TYPES[0];
    if (!first) throw new Error("no builtin type");
    const { model: _model, ...base } = first;
    const say = () => new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const { run } = createSubagentRunner({
      model: say(),
      modelFor: () => say(),
      env,
      tools: fullRegistry(),
      types: [
        { ...base, name: "fast", model: "child-m" },
        { ...base, name: "plain" },
      ],
      hooks: new HookRunner({
        specs: [{ event: "model_request", command: "mr" }],
        env,
        cwd: "/w",
        modelId: "parent-m",
        modelRequestHooks: true,
      }),
    });
    await run({ description: "d", prompt: "p", type: "fast" });
    await run({ description: "d", prompt: "p", type: "plain" });
    await new Promise((r) => setTimeout(r, 5));
    expect(models).toEqual(["child-m", "parent-m"]);
  });

  test("returns the child's final text as the report (isolated run)", async () => {
    const { env } = recordingEnv();
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([[{ type: "text", delta: "found the bug" }, { type: "done" }]]),
      env,
      tools: fullRegistry(),
    });
    const result = await run({ description: "d", prompt: "look", type: "general" });
    expect(result.report).toBe("found the bug");
    expect(result.toolUses).toBe(0);
    expect(result.stopReason).toBe("end_turn");
  });

  test("a general child can run an allowed tool with the inherited env", async () => {
    const { env, readCalls } = recordingEnv();
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("fs_read", { path: "a.ts" }), { type: "done" }],
        [{ type: "text", delta: "read it" }, { type: "done" }],
      ]),
      env,
      tools: fullRegistry(),
    });
    const result = await run({ description: "d", prompt: "read a.ts", type: "general" });
    expect(readCalls).toEqual(["a.ts"]);
    expect(result.toolUses).toBe(1);
    expect(result.report).toBe("read it");
  });

  test("the `explore` type is read-only: shell is not available to the child", async () => {
    const { env, execCalls } = recordingEnv();
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("shell", { command: "rm -rf /" }), { type: "done" }],
        [{ type: "text", delta: "could not run shell" }, { type: "done" }],
      ]),
      env,
      tools: fullRegistry(),
    });
    await run({ description: "d", prompt: "try shell", type: "explore" });
    // shell was never executed — it is not in the explore child's registry.
    expect(execCalls).toEqual([]);
  });

  test("recovers a report via the final summary turn when the child hits maxIterations", async () => {
    const { env } = recordingEnv();
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("fs_read", { path: "a.ts" })], // iteration 0: only a tool call, no text
        [{ type: "text", delta: "SUMMARY FROM CAP" }, { type: "done" }], // forced summary turn
      ]),
      env,
      tools: fullRegistry(),
      maxIterations: 1,
    });
    const result = await run({ description: "d", prompt: "investigate", type: "explore" });
    expect(result.stopReason).toBe("max_iterations");
    expect(result.report).toBe("SUMMARY FROM CAP"); // not empty — recovered at the cap
  });

  test("never returns an empty report (floor) if even the summary produces nothing", async () => {
    const { env } = recordingEnv();
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("fs_read", { path: "a.ts" })], // tool call, no text
        [{ type: "done" }], // forced summary yields no text either
      ]),
      env,
      tools: fullRegistry(),
      maxIterations: 1,
    });
    const result = await run({ description: "d", prompt: "investigate", type: "explore" });
    expect(result.stopReason).toBe("max_iterations");
    expect(result.report).toContain("without producing a report");
  });

  test("a child never receives the spawn tool (no recursion)", async () => {
    const { env } = recordingEnv();
    const spawned: string[] = [];
    const parentTools = fullRegistry().register({
      name: "agent_task",
      description: "spawn",
      inputSchema: shellTool.inputSchema,
      permission: "none",
      async execute(input) {
        // Side effect that only fires if the spawn tool is actually callable
        // by the child (i.e. the no-recursion filter failed to strip it).
        spawned.push(JSON.stringify(input));
        return { content: "SPAWNED A CHILD" };
      },
    });
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("agent_task", { command: "x" }), { type: "done" }],
        [{ type: "text", delta: "no task tool" }, { type: "done" }],
      ]),
      env,
      tools: parentTools,
    });
    await run({ description: "d", prompt: "spawn", type: "general" });
    // The child attempted to call the spawn tool; it must be rejected as
    // unknown (not in the child's registry) and therefore never executed.
    expect(spawned).toEqual([]);
  });

  test("a child is never offered context_reset (its context is its own)", async () => {
    const { env } = recordingEnv();
    const offered: string[][] = [];
    const model: ModelProvider = {
      id: "rec",
      async *stream(request) {
        offered.push((request.tools ?? []).map((t) => t.name));
        yield { type: "text", delta: "report" };
        yield { type: "done" };
      },
    };
    const { run } = createSubagentRunner({
      model,
      env,
      tools: fullRegistry().register(createContextResetTool()),
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]?.length).toBeGreaterThan(0);
    expect(offered[0]).not.toContain(CONTEXT_RESET_TOOL_NAME);
  });

  test("a type's model override routes to the provider from modelFor", async () => {
    const { env } = recordingEnv();
    const base = new ScriptedProvider([[{ type: "text", delta: "from base" }, { type: "done" }]]);
    const big = new ScriptedProvider([[{ type: "text", delta: "from big" }, { type: "done" }]]);
    const usedModels: string[] = [];
    const { run } = createSubagentRunner({
      model: base,
      modelFor: (id) => {
        usedModels.push(id);
        return big;
      },
      env,
      tools: fullRegistry(),
      types: [
        {
          name: "big",
          description: "uses a bigger model",
          prompt: "p",
          tools: "all",
          model: "big-model",
        },
      ],
    });
    const result = await run({ description: "d", prompt: "go", type: "big" });
    expect(usedModels).toEqual(["big-model"]);
    expect(result.report).toBe("from big");
  });

  test("emits progress events: start, one per child tool call, then end", async () => {
    const { env } = recordingEnv();
    const events: string[] = [];
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("fs_read", { path: "a.ts" }), { type: "done" }],
        [{ type: "text", delta: "done" }, { type: "done" }],
      ]),
      env,
      tools: fullRegistry(),
    });
    await run(
      { description: "look", prompt: "read a.ts", type: "general" },
      {
        onEvent: (e) => {
          if (e.kind === "subagent_start") {
            events.push(`start:${e.agentType}`);
          } else if (e.kind === "subagent_tool") {
            events.push(`tool:${e.label}`);
          } else if (e.kind === "subagent_end") {
            events.push(`end:${e.toolUses}`);
          }
        },
      },
    );
    expect(events).toEqual(["start:general", "tool:Read a.ts", "end:1"]);
  });

  test("forwards each child usage event as subagent_usage (its own tokens, per model call)", async () => {
    const { env } = recordingEnv();
    const usages: [number, number][] = [];
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [
          toolCall("fs_read", { path: "a.ts" }),
          { type: "done", usage: { promptTokens: 100, completionTokens: 7 } },
        ],
        [
          { type: "text", delta: "done" },
          { type: "done", usage: { promptTokens: 150, completionTokens: 3 } },
        ],
      ]),
      env,
      tools: fullRegistry(),
    });
    await run(
      { description: "look", prompt: "read a.ts", type: "general" },
      {
        onEvent: (e) => {
          if (e.kind === "subagent_usage") {
            usages.push([e.promptTokens, e.completionTokens]);
          }
        },
      },
    );
    expect(usages).toEqual([
      [100, 7],
      [150, 3],
    ]);
  });

  test("the inherited permission requester can block a child's shell command", async () => {
    const { env, execCalls } = recordingEnv();
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([
        [toolCall("shell", { command: "ls" }), { type: "done" }],
        [{ type: "text", delta: "denied" }, { type: "done" }],
      ]),
      env,
      tools: fullRegistry(),
      requestPermission: async () => ({ allowed: false }),
    });
    await run({ description: "d", prompt: "run ls", type: "general" });
    expect(execCalls).toEqual([]); // denied by the inherited requester
  });

  // docs/feat/permission-call-attribution.md T2: a child's ask is attributed
  // to the PARENT's `agent_task` call — its own call id ("c1" here) is unknown
  // to the parent history and must never escape.
  test("a child's ask carries the parent's call id, origin subagent and the agent", async () => {
    const { env } = recordingEnv();
    const seen: unknown[] = [];
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([[toolCall("shell", { command: "ls" }), { type: "done" }]]),
      env,
      tools: fullRegistry(),
      requestPermission: async (_req, options) => {
        seen.push(options);
        return { allowed: false };
      },
    });
    await run(
      { description: "scan repo", prompt: "run ls", type: "general" },
      { toolCallId: "parent-9" },
    );
    expect(seen).toEqual([
      {
        toolCallId: "parent-9",
        origin: "subagent",
        agent: { type: "general", description: "scan repo" },
      },
    ]);
  });

  test("without a parent call id, a child's ask carries no toolCallId (never its own)", async () => {
    const { env } = recordingEnv();
    const seen: unknown[] = [];
    const { run } = createSubagentRunner({
      model: new ScriptedProvider([[toolCall("shell", { command: "ls" }), { type: "done" }]]),
      env,
      tools: fullRegistry(),
      requestPermission: async (_req, options) => {
        seen.push(options);
        return { allowed: false };
      },
    });
    await run({ description: "d", prompt: "run ls", type: "general" });
    expect(seen).toEqual([{ origin: "subagent", agent: { type: "general", description: "d" } }]);
  });

  test("the wrapper keeps the other options and overrides origin/agent", async () => {
    const seen: unknown[] = [];
    const signal = new AbortController().signal;
    const wrapped = subagentRequester(
      async (_req, options) => {
        seen.push(options);
        return { allowed: true };
      },
      "parent-1",
      { type: "explore", description: "find" },
    );
    await wrapped(
      { tool: "shell", level: "ask", title: "t", input: {} },
      // A child's group head names a call unknown to the parent history:
      // dropped (docs/feat/round-groups-persistence.md T7).
      { signal, turnId: "t1", toolCallId: "child-3", origin: "call", groupStart: "child-2" },
    );
    expect(seen).toEqual([
      {
        signal,
        turnId: "t1",
        toolCallId: "parent-1",
        origin: "subagent",
        agent: { type: "explore", description: "find" },
      },
    ]);
  });

  test("through agent_task: the ask names the parent's agent_task call", async () => {
    const { env } = recordingEnv();
    const seen: unknown[] = [];
    const requestPermission = async (_req: unknown, options: unknown) => {
      seen.push(options);
      return { allowed: false };
    };
    const childModel = new ScriptedProvider([
      [toolCall("shell", { command: "ls" }), { type: "done" }],
    ]);
    const { run, types } = createSubagentRunner({
      model: childModel,
      env,
      tools: fullRegistry(),
      requestPermission,
    });
    const parent = new Agent({
      model: new ScriptedProvider([
        [
          {
            type: "tool_call",
            toolCall: {
              id: "task-42",
              name: "agent_task",
              arguments: JSON.stringify({ description: "look", prompt: "run ls" }),
            },
          },
          { type: "done" },
        ],
      ]),
      tools: new ToolRegistry().register(createTaskTool(run, types)),
      env,
      requestPermission,
    });
    for await (const _ of parent.run("s", [{ role: "user", content: "go" }])) {
      // drain
    }
    expect(seen).toEqual([
      {
        toolCallId: "task-42",
        origin: "subagent",
        agent: { type: "general", description: "look" },
      },
    ]);
  });

  test('an old history\'s "general-purpose" runs as the default built-in, through agent_task', async () => {
    // Wiring level (feat/subagent-general-rename, eval C2): no user agent files,
    // so the real wiring's merged list (`wiring.ts:473-477`) IS the built-ins.
    // The runner is given no `types` here, which is the same list. A call stored
    // before the rename names a type that no longer exists; the generic
    // unknown→default path (`task.ts:82-85`) runs the child as the default
    // built-in — no alias.
    const { env } = recordingEnv();
    const { run, types } = createSubagentRunner({
      model: new ScriptedProvider([[toolCall("shell", { command: "ls" }), { type: "done" }]]),
      env,
      tools: fullRegistry(),
    });
    // No `types`: the runner falls back to the real built-ins, as `wiring.ts:477` gets.
    expect(types.map((t) => t.name)).toEqual(["general", "explore"]);
    const parent = new Agent({
      model: new ScriptedProvider([
        [
          {
            type: "tool_call",
            toolCall: {
              id: "task-1",
              name: "agent_task",
              arguments: JSON.stringify({
                description: "look",
                prompt: "run ls",
                subagent_type: "general-purpose",
              }),
            },
          },
          { type: "done" },
        ],
      ]),
      tools: new ToolRegistry().register(createTaskTool(run, types)),
      env,
    });
    const starts: { id: string; agentType: string }[] = [];
    for await (const event of parent.run("s", [{ role: "user", content: "go" }])) {
      // `subagent_start.agentType` is the child's RESOLVED type, not the requested one.
      if (event.type === "subagent_start") {
        starts.push({ id: event.id, agentType: event.agentType });
      }
    }
    expect(starts).toEqual([{ id: "task-1", agentType: "general" }]);
  });
});

describe("childToolLabel", () => {
  test("keeps the dedicated shell / fs strings", () => {
    expect(childToolLabel("shell", '{"command":"ls -la"}')).toBe("$ ls -la");
    expect(childToolLabel("fs_read", '{"path":"a.ts"}')).toBe("Read a.ts");
    expect(childToolLabel("fs_edit", '{"path":"a.ts"}')).toBe("Edit a.ts");
  });

  test("any other tool shows its display label, or its name when it has none", () => {
    expect(childToolLabel("fs_multi_edit", '{"path":"a.ts","edits":[]}')).toBe("MultiEdit");
    expect(childToolLabel("shell_output", '{"job_id":"j1"}')).toBe("BashOutput");
    expect(childToolLabel("mcp__x__y", "{}")).toBe("mcp__x__y");
  });
});
