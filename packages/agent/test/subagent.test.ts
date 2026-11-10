import { describe, expect, test } from "bun:test";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { AgentInbox, AgentJobs, type AgentNotifyResult } from "@tentacle/core";
import {
  AGENT_KILL_TOOL_NAME,
  AGENT_MESSAGE_TOOL_NAME,
  AGENT_NOTIFY_TOOL_NAME,
  CONTEXT_RESET_TOOL_NAME,
  ToolRegistry,
  createAgentKillTool,
  createAgentMessageTool,
  createAgentNotifyTool,
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
      modelFor: (type) =>
        type.model !== undefined ? { provider: say(), modelId: type.model } : undefined,
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

  test("hooks get the CHOSEN model's id, not the type's own frontmatter model", async () => {
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
      // A type routed by `subagents.types`: the id is the entry's, never `type.model`.
      modelFor: (type) =>
        type.name === "framed"
          ? { provider: say(), modelId: "routed-over-frontmatter" }
          : type.name === "routed"
            ? { provider: say(), modelId: "routed-m" }
            : undefined,
      env,
      tools: fullRegistry(),
      types: [
        { ...base, name: "framed", model: "frontmatter-m" },
        { ...base, name: "routed" },
      ],
      hooks: new HookRunner({
        specs: [{ event: "model_request", command: "mr" }],
        env,
        cwd: "/w",
        modelId: "parent-m",
        modelRequestHooks: true,
      }),
    });
    await run({ description: "d", prompt: "p", type: "framed" });
    await run({ description: "d", prompt: "p", type: "routed" });
    await new Promise((r) => setTimeout(r, 5));
    expect(models).toEqual(["routed-over-frontmatter", "routed-m"]);
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

  test("a child is never offered agent_kill, even in a registry that holds it (owner Q1)", async () => {
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
    // The shape `wiring.ts` gives the shared registry with background on: the
    // parent holds both the spawn tool and `agent_kill`, so a `tools: "all"`
    // child would inherit the kill unless the runner drops it.
    const jobs = new AgentJobs(2);
    const { run } = createSubagentRunner({
      model,
      env,
      tools: fullRegistry()
        .register(
          createTaskTool(
            async () => ({ report: "", toolUses: 0, stopReason: "end_turn" }),
            BUILTIN_AGENT_TYPES,
          ),
        )
        .register(createAgentKillTool(jobs)),
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]?.length).toBeGreaterThan(0);
    expect(offered[0]).not.toContain(AGENT_KILL_TOOL_NAME);
  });

  test("the call's requested model reaches modelFor with the type (models-map)", async () => {
    const { env } = recordingEnv();
    const base = new ScriptedProvider([[{ type: "text", delta: "from base" }, { type: "done" }]]);
    const fast = new ScriptedProvider([[{ type: "text", delta: "from fast" }, { type: "done" }]]);
    const seen: (string | undefined)[][] = [];
    const { run } = createSubagentRunner({
      model: base,
      modelFor: (type, requested) => {
        seen.push([type.name, requested]);
        return requested === "fast" ? { provider: fast } : undefined;
      },
      env,
      tools: fullRegistry(),
    });
    const picked = await run({ description: "d", prompt: "go", type: "explore", model: "fast" });
    const plain = await run({ description: "d", prompt: "go", type: "general" });
    expect(seen).toEqual([
      ["explore", "fast"],
      ["general", undefined],
    ]);
    expect(picked.report).toBe("from fast");
    expect(plain.report).toBe("from base");
  });

  test("a type's model override routes to the provider from modelFor", async () => {
    const { env } = recordingEnv();
    const base = new ScriptedProvider([[{ type: "text", delta: "from base" }, { type: "done" }]]);
    const big = new ScriptedProvider([[{ type: "text", delta: "from big" }, { type: "done" }]]);
    const usedModels: (string | undefined)[] = [];
    const { run } = createSubagentRunner({
      model: base,
      modelFor: (type) => {
        usedModels.push(type.model);
        return { provider: big };
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

// docs/feat/agent-message.md T7-T10: the child's inbox. A text pushed while the
// child runs reaches its next model request as a user message; a text that
// arrives in the CLOSE WINDOW (after the last drain, before the runner decided
// to stop) is carried into one more pass; a child that stops for any other
// reason REPORTS what it never read.

/** A provider that records every request and runs `onRound` after each round. */
function recordingInboxProvider(
  rounds: number,
  onRound?: (round: number, inbox: AgentInbox) => void,
): { model: ModelProvider; seen: ChatRequest[]; inbox: AgentInbox } {
  const seen: ChatRequest[] = [];
  const inbox = new AgentInbox();
  const model: ModelProvider = {
    id: "rec-inbox",
    async *stream(request) {
      seen.push(request);
      const round = seen.length;
      yield { type: "text", delta: `r${round}` };
      yield { type: "done" };
      if (round < rounds) {
        onRound?.(round, inbox);
      }
    },
  };
  return { model, seen, inbox };
}

const userTexts = (request: ChatRequest | undefined): string[] =>
  (request?.messages ?? []).filter((m) => m.role === "user").map((m) => String(m.content));

describe("T7: a text pushed while the child runs reaches its next request", () => {
  test("injected at the next boundary as a user message, formatted", async () => {
    const { model, seen, inbox } = recordingInboxProvider(2, (round, box) => {
      if (round === 1) {
        box.push("[message from the parent agent] also check X");
      }
    });
    const { run } = createSubagentRunner({ model, env: recordingEnv().env, tools: fullRegistry() });
    const result = await run({ description: "d", prompt: "go", type: "general" }, { inbox });
    expect(seen).toHaveLength(2);
    expect(userTexts(seen[1])).toEqual(["go", "[message from the parent agent] also check X"]);
    expect(result.report).toBe("r1r2");
    // The child read it: the inbox closes empty, with nothing to report.
    expect(inbox.closed).toBe(true);
    expect(result.report).not.toContain("were not read");
  });
});

describe("T8: the close window (LBA)", () => {
  test("a text pushed after the child's last drain runs ONE more pass and is read", async () => {
    // The seam: a text that lands between the last drain and the runner's
    // decision — the very interleaving `closeIfEmpty` exists to close. Without
    // the close loop it is never in any request (the naive runner's red).
    const seen: ChatRequest[] = [];
    const inbox = new AgentInbox();
    let armed = false;
    const pushLate = (): void => {
      if (armed) {
        return;
      }
      armed = true;
      void (async () => {
        // Far enough down the microtask chain to land after both drains.
        for (let i = 0; i < 8; i++) {
          await null;
        }
        inbox.push("[message from the parent agent] late text");
      })();
    };
    const model: ModelProvider = {
      id: "gated",
      async *stream(request) {
        seen.push(request);
        pushLate();
        yield { type: "text", delta: "r1" };
        yield { type: "done" };
      },
    };
    const { run } = createSubagentRunner({ model, env: recordingEnv().env, tools: fullRegistry() });
    const result = await run({ description: "d", prompt: "go", type: "general" }, { inbox });
    // One more pass, and the next request carries the text.
    expect(seen).toHaveLength(2);
    expect(userTexts(seen[1])).toContain("[message from the parent agent] late text");
    expect(inbox.closed).toBe(true);
    expect(result.report).not.toContain("were not read");
  });
});

describe("T9: a child that stops early reports what it never read", () => {
  test("a queued text on a cancelled child is counted in the report; the inbox is closed", async () => {
    const controller = new AbortController();
    const inbox = new AgentInbox();
    const seen: ChatRequest[] = [];
    let after = false;
    const model: ModelProvider = {
      id: "cancel",
      async *stream(request) {
        seen.push(request);
        yield { type: "text", delta: "working" };
        yield { type: "done" };
        if (!after) {
          after = true;
          // A text arrives, and THEN the child is cancelled: the runner stops
          // (no more passes) and must report the text it never delivered.
          inbox.push("[message from the parent agent] too late");
          controller.abort();
        }
      },
    };
    const { run } = createSubagentRunner({ model, env: recordingEnv().env, tools: fullRegistry() });
    const result = await run(
      { description: "d", prompt: "go", type: "general" },
      { signal: controller.signal, inbox },
    );
    expect(result.stopReason).toBe("cancelled");
    expect(result.report).toContain(
      "(1 message(s) sent to this sub-agent arrived after it stopped and were not read.)",
    );
    expect(inbox.closed).toBe(true);
    // Never delivered: no request carried it.
    expect(seen.flatMap((r) => userTexts(r))).not.toContain(
      "[message from the parent agent] too late",
    );
  });
});

// docs/feat/agent-message.md H1 (fix round 1): a text DRAINED into the history
// with no model round behind it. A child has no next turn and the inbox is
// already empty, so `close()` cannot see it: the runner must count the `steer`
// events no round answered.
describe("T9c: a text consumed at max_iterations is reported as unread (H1)", () => {
  test("a text pushed while the forced final report streams is counted, not lost", async () => {
    const seen: ChatRequest[] = [];
    const inbox = new AgentInbox();
    let pushedOk: boolean | undefined;
    const model: ModelProvider = {
      id: "cap",
      async *stream(request) {
        seen.push(request);
        if ((request.tools ?? []).length > 0) {
          yield toolCall("fs_read", { path: "a" });
          yield { type: "done" };
          return;
        }
        // The forced final report (no tools left): a parent message arrives
        // while it streams, after the last drain that a round could answer.
        pushedOk = inbox.push("[message from the parent agent] during final").ok;
        yield { type: "text", delta: "final report" };
        yield { type: "done" };
      },
    };
    const { run } = createSubagentRunner({
      model,
      env: recordingEnv().env,
      tools: fullRegistry(),
      maxIterations: 1,
    });
    const result = await run({ description: "d", prompt: "go", type: "general" }, { inbox });
    // The sender was told it was queued...
    expect(pushedOk).toBe(true);
    expect(result.stopReason).toBe("max_iterations");
    expect(result.report).toContain("final report");
    // ...and it was never read: no request carried it.
    expect(seen.flatMap((r) => userTexts(r))).not.toContain(
      "[message from the parent agent] during final",
    );
    // So the report must SAY so.
    expect(result.report).toContain(
      "(1 message(s) sent to this sub-agent arrived after it stopped and were not read.)",
    );
  });
});

describe("T9d: a text drained by a turn_start stop in a continuation pass is reported (H1)", () => {
  test("the second pass's turn_start hook stops it; the carried text is counted unread", async () => {
    const seen: ChatRequest[] = [];
    const inbox = new AgentInbox();
    const hookCalls: string[] = [];
    const env: ExecutionEnvironment = {
      id: "h1",
      async exec(command) {
        hookCalls.push(command);
        // The FIRST pass starts normally; the continuation pass is stopped.
        return hookCalls.length === 1
          ? { stdout: "", stderr: "", exitCode: 0 }
          : { stdout: "", stderr: "", exitCode: 2 };
      },
      async readFile() {
        return "";
      },
      async writeFile() {},
    };
    // The seam T8 uses: a push far enough down the microtask chain to land
    // after the last drain of the first pass, so `closeIfEmpty` hands it back
    // for one more — hook-stopped — pass.
    let armed = false;
    const pushLate = (): void => {
      if (armed) {
        return;
      }
      armed = true;
      void (async () => {
        for (let i = 0; i < 8; i++) {
          await null;
        }
        inbox.push("[message from the parent agent] late text");
      })();
    };
    const model: ModelProvider = {
      id: "gated-hook",
      async *stream(request) {
        seen.push(request);
        pushLate();
        yield { type: "text", delta: `r${seen.length}` };
        yield { type: "done" };
      },
    };
    const { run } = createSubagentRunner({
      model,
      env,
      tools: fullRegistry(),
      hooks: new HookRunner({ specs: [{ event: "turn_start", command: "ts" }], env, cwd: "/w" }),
    });
    const result = await run({ description: "d", prompt: "go", type: "general" }, { inbox });
    // Two passes: the first ran a round, the second was stopped by the hook
    // before any model call.
    expect(hookCalls).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen.flatMap((r) => userTexts(r))).not.toContain(
      "[message from the parent agent] late text",
    );
    expect(result.report).toContain(
      "(1 message(s) sent to this sub-agent arrived after it stopped and were not read.)",
    );
    expect(inbox.closed).toBe(true);
  });
});

describe("T10: an inbox is never handed to the child as a tool", () => {
  test("a child is never offered agent_message, and readOnlyType ignores it", async () => {
    const offered: string[][] = [];
    const model: ModelProvider = {
      id: "rec",
      async *stream(request) {
        offered.push((request.tools ?? []).map((t) => t.name));
        yield { type: "text", delta: "report" };
        yield { type: "done" };
      },
    };
    const jobs = new AgentJobs(2);
    const { run, readOnlyType } = createSubagentRunner({
      model,
      env: recordingEnv().env,
      tools: fullRegistry()
        .register(
          createTaskTool(
            async () => ({ report: "", toolUses: 0, stopReason: "end_turn" }),
            BUILTIN_AGENT_TYPES,
          ),
        )
        .register(createAgentKillTool(jobs))
        .register(createAgentMessageTool(jobs)),
      types: [
        {
          name: "reads",
          description: "reads",
          prompt: "p",
          tools: ["fs_read", AGENT_MESSAGE_TOOL_NAME],
        },
      ],
    });
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[0]?.length).toBeGreaterThan(0);
    expect(offered[0]).not.toContain(AGENT_MESSAGE_TOOL_NAME);
    // A type naming it is still read-only: a child never gets it.
    expect(readOnlyType("reads")).toBe(true);
  });
});

describe("T10b: only a BACKGROUND child gets agent_notify (owner Q3 a)", () => {
  function offeredRig(deps: {
    notify?: (id: string, text: string) => AgentNotifyResult;
    types?: Parameters<typeof createSubagentRunner>[0]["types"];
  }) {
    const offered: string[][] = [];
    const model: ModelProvider = {
      id: "rec",
      async *stream(request) {
        offered.push((request.tools ?? []).map((t) => t.name));
        yield { type: "text", delta: "report" };
        yield { type: "done" };
      },
    };
    const { run, readOnlyType } = createSubagentRunner({
      model,
      env: recordingEnv().env,
      tools: fullRegistry(),
      ...deps,
    });
    return { run, offered, readOnlyType };
  }

  const yes: (id: string, text: string) => AgentNotifyResult = () => ({ ok: true, wakes: true });

  test("a background child (with an agentId) is offered it; a foreground child is not", async () => {
    const { run, offered } = offeredRig({ notify: yes });
    await run({ description: "d", prompt: "go", type: "general" }, { agentId: "sa-1" });
    expect(offered[0]).toContain(AGENT_NOTIFY_TOOL_NAME);
    // The foreground is blocked on the report: its reply already exists.
    await run({ description: "d", prompt: "go", type: "general" });
    expect(offered[1]).not.toContain(AGENT_NOTIFY_TOOL_NAME);
  });

  test("with no notify wired (twoWay off) even a background child is not offered it", async () => {
    const { run, offered } = offeredRig({});
    await run({ description: "d", prompt: "go", type: "general" }, { agentId: "sa-1" });
    expect(offered[0]).not.toContain(AGENT_NOTIFY_TOOL_NAME);
  });

  test("a read-only (explore) child gets it too: it is a channel back, not a capability", async () => {
    const { run, offered } = offeredRig({
      notify: yes,
      types: [{ name: "explore", description: "reads", prompt: "p", tools: ["fs_read"] }],
    });
    await run({ description: "d", prompt: "go", type: "explore" }, { agentId: "sa-2" });
    expect(offered[0]).toEqual(["fs_read", AGENT_NOTIFY_TOOL_NAME]);
  });

  test("a parent registry holding one never leaks it, and readOnlyType ignores it", async () => {
    const offered: string[][] = [];
    const model: ModelProvider = {
      id: "rec",
      async *stream(request) {
        offered.push((request.tools ?? []).map((t) => t.name));
        yield { type: "text", delta: "report" };
        yield { type: "done" };
      },
    };
    const { run, readOnlyType } = createSubagentRunner({
      model,
      env: recordingEnv().env,
      tools: fullRegistry().register(createAgentNotifyTool("sa-parent", yes)),
      types: [
        {
          name: "reads",
          description: "reads",
          prompt: "p",
          tools: ["fs_read", AGENT_NOTIFY_TOOL_NAME],
        },
      ],
    });
    // No `notify` wired: the leak is dropped by the filter, not offered.
    await run({ description: "d", prompt: "go", type: "reads" });
    expect(offered[0]).not.toContain(AGENT_NOTIFY_TOOL_NAME);
    expect(readOnlyType("reads")).toBe(true);
  });
});

describe("T9b: a carried text whose pass never drains it is still reported", () => {
  test("aborted right after the close handed a text back: counted, not lost", async () => {
    // The seam: `closeIfEmpty` hands a text back for one more pass, and the
    // signal aborts in that same stretch — so the continuation pass ends
    // cancelled at its FIRST boundary, before its drain. The text is reported,
    // never silently dropped.
    const controller = new AbortController();
    class AbortingInbox extends AgentInbox {
      private armed = false;
      override closeIfEmpty(): string[] {
        if (!this.armed) {
          this.armed = true;
          // Slips in exactly in the close window, so the carry is non-empty.
          this.push("[message from the parent agent] carried");
        }
        const out = super.closeIfEmpty();
        if (out.length > 0) {
          controller.abort();
        }
        return out;
      }
    }
    const inbox = new AbortingInbox();
    const model: ModelProvider = {
      id: "abort-at-carry",
      async *stream() {
        yield { type: "text", delta: "working" };
        yield { type: "done" };
      },
    };
    const { run } = createSubagentRunner({ model, env: recordingEnv().env, tools: fullRegistry() });
    const result = await run(
      { description: "d", prompt: "go", type: "general" },
      { signal: controller.signal, inbox },
    );
    // The continuation pass never delivered it.
    expect(result.stopReason).toBe("cancelled");
    expect(result.report).toContain(
      "(1 message(s) sent to this sub-agent arrived after it stopped",
    );
    expect(inbox.closed).toBe(true);
  });
});
