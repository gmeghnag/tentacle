import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  HookSpec,
  ModelProvider,
  PermissionRequest,
  PermissionResponse,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { HookRunner, runResultHooks } from "../src/hooks.ts";
import { describeToolCall } from "../src/permission-gate.ts";

function toolCallTurn(command: string): StreamEvent[] {
  return [
    {
      type: "tool_call",
      toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command }) },
    },
    { type: "done" },
  ];
}

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

function makeEnv(): { env: ExecutionEnvironment; execCalls: string[] } {
  const execCalls: string[] = [];
  const env: ExecutionEnvironment = {
    id: "fake",
    async exec(command) {
      execCalls.push(command);
      return { stdout: "ran", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  return { env, execCalls };
}

async function collect(agent: Agent): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const event of agent.run("s1", [{ role: "user", content: "go" }])) {
    out.push(event);
  }
  return out;
}

describe("permission gate in the agent loop", () => {
  test("the requester is told which call asks: { toolCallId, origin: call }", async () => {
    // docs/feat/permission-call-attribution.md T1: the daemon attributes the
    // ask from these options, not from the last `tool_start` it saw.
    const { env } = makeEnv();
    const seen: unknown[] = [];
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("make deploy")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: async (_req, options) => {
        seen.push(options);
        return { allowed: false };
      },
    });
    await collect(agent);
    expect(seen).toEqual([{ toolCallId: "c1", origin: "call" }]);
  });

  test("a tool runs with its own call id in the context", async () => {
    const { env } = makeEnv();
    const ids: (string | undefined)[] = [];
    const probe: Tool = {
      name: "probe",
      description: "",
      inputSchema: shellTool.inputSchema,
      permission: "none",
      async execute(_input, ctx) {
        ids.push(ctx.toolCallId);
        return { content: "" };
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([
        [
          {
            type: "tool_call",
            toolCall: { id: "p7", name: "probe", arguments: JSON.stringify({ command: "x" }) },
          },
          { type: "done" },
        ],
      ]),
      tools: new ToolRegistry().register(probe),
      env,
    });
    await collect(agent);
    expect(ids).toEqual(["p7"]);
  });

  test("denies a shell call: the tool never runs and the result is an error", async () => {
    const { env, execCalls } = makeEnv();
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("rm -rf /")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: async () => ({ allowed: false }),
    });

    const events = await collect(agent);
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toBeDefined();
    if (result?.type === "tool_result") {
      expect(result.result.isError).toBe(true);
      expect(result.result.content).toContain("Permission denied");
    }
    expect(execCalls).toEqual([]); // the command was never executed
  });

  test("a refusal that comes from a cancel is recorded as cancelled, not as a user denial", async () => {
    // The daemon settles a pending ask as `cancelled` when its turn is
    // cancelled; the history must not claim the user denied it.
    // Mutation: check `!allowed` before the abort → "Permission denied" → red.
    const { env, execCalls } = makeEnv();
    const controller = new AbortController();
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("make deploy")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: async () => {
        controller.abort();
        return { allowed: false };
      },
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.run(
      "s1",
      [{ role: "user", content: "go" }],
      controller.signal,
    )) {
      events.push(event);
    }
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.type === "tool_result" && result.result.content).toBe(
      "Cancelled by the user before this tool ran.",
    );
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(execCalls).toEqual([]);
  });

  test("allows a shell call when the user approves", async () => {
    const { env, execCalls } = makeEnv();
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("echo hi")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: async () => ({ allowed: true, scope: "once" }),
    });

    await collect(agent);
    expect(execCalls).toEqual(["echo hi"]);
  });

  test("session-scoped approval is not asked again", async () => {
    const { env } = makeEnv();
    const requests: PermissionRequest[] = [];
    const requester = async (req: PermissionRequest): Promise<PermissionResponse> => {
      requests.push(req);
      return { allowed: true, scope: "session" };
    };
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("echo one"), toolCallTurn("echo two")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: requester,
    });

    // Two separate turns, each with a shell call.
    for await (const _ of agent.run("s1", [{ role: "user", content: "a" }])) {
      // drain
    }
    for await (const _ of agent.run("s1", [{ role: "user", content: "b" }])) {
      // drain
    }

    // Asked once; the second call was covered by the session grant.
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ tool: "shell", title: "Run a shell command" });
    expect(requests[0]?.detail).toBe("echo one");
  });

  test("a session grant is scoped to the command prefix, not the whole tool", async () => {
    const { env, execCalls } = makeEnv();
    const requests: PermissionRequest[] = [];
    const requester = async (req: PermissionRequest): Promise<PermissionResponse> => {
      requests.push(req);
      // Approve `npm run` for the session; deny anything else.
      return req.detail?.startsWith("npm run")
        ? { allowed: true, scope: "session" }
        : { allowed: false };
    };
    const agent = new Agent({
      model: new ScriptedProvider([
        toolCallTurn("npm run build"),
        toolCallTurn("npm run test"), // covered by the prefix → not asked
        toolCallTurn("rm -rf /"), // different prefix → asked (and denied)
      ]),
      tools: new ToolRegistry().register(shellTool),
      env,
      requestPermission: requester,
    });

    for (const prompt of ["a", "b", "c"]) {
      for await (const _ of agent.run("s1", [{ role: "user", content: prompt }])) {
        // drain
      }
    }

    // The suggested rule was the command prefix.
    expect(requests[0]?.suggestion).toEqual({ prefix: "npm run" });
    // Asked for `npm run build` and `rm -rf /`, but NOT for `npm run test`.
    expect(requests.map((r) => r.detail)).toEqual(["npm run build", "rm -rf /"]);
    // Both npm commands ran; the rm never did.
    expect(execCalls).toEqual(["npm run build", "npm run test"]);
  });
});

describe("describeToolCall titles", () => {
  test("a tool without a dedicated title is shown by its display label", () => {
    const tool = { name: "fs_multi_edit", permission: "ask" } as unknown as Tool;
    expect(describeToolCall(tool, {}).title).toBe("Run MultiEdit");
  });

  test("an unlabelled tool (MCP) is shown by its name", () => {
    const tool = { name: "mcp__x__y", permission: "ask" } as unknown as Tool;
    expect(describeToolCall(tool, {}).title).toBe("Run mcp__x__y");
  });
});

/** A fake env whose `exec` answers hook commands from a table (and records their stdin). */
function hookEnv(
  table: Record<
    string,
    (stdin: unknown) => { stdout?: string; stderr?: string; exitCode?: number }
  >,
) {
  const execCalls: string[] = [];
  const hookInputs: Record<string, unknown[]> = {};
  const env: ExecutionEnvironment = {
    id: "fake",
    async exec(command, options) {
      const hook = table[command];
      if (hook) {
        const stdin: unknown = JSON.parse(options?.stdin ?? "null");
        const seen = hookInputs[command] ?? [];
        seen.push(stdin);
        hookInputs[command] = seen;
        const r = hook(stdin);
        return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0 };
      }
      execCalls.push(command);
      return { stdout: "ran", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  return { env, execCalls, hookInputs };
}

function hookAgent(
  env: ExecutionEnvironment,
  specs: readonly HookSpec[],
  script: readonly (readonly StreamEvent[])[],
  requests: PermissionRequest[],
  tools = new ToolRegistry().register(shellTool),
): Agent {
  return new Agent({
    model: new ScriptedProvider(script),
    tools,
    env,
    hooks: new HookRunner({ specs, env, cwd: "/w" }),
    requestPermission: async (req) => {
      requests.push(req);
      return { allowed: true };
    },
  });
}

function toolResults(events: readonly AgentEvent[]) {
  return events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []));
}

describe("tool_call hooks in the gate", () => {
  test("a hook deny: the tool never runs, the text names the hook block, result.hook is set", async () => {
    const { env, execCalls, hookInputs } = hookEnv({
      "~/hooks/no-rm.sh --strict": () => ({
        exitCode: 2,
        stderr: "rm -rf not allowed in this repo",
      }),
    });
    const requests: PermissionRequest[] = [];
    const agent = hookAgent(
      env,
      [{ event: "tool_call", matcher: "shell", command: "~/hooks/no-rm.sh --strict" }],
      [toolCallTurn("rm -rf build")],
      requests,
    );
    const [result] = toolResults(await collect(agent));
    expect(execCalls).toEqual([]);
    expect(requests).toEqual([]);
    expect(result?.content).toBe(
      "Blocked by a hook: `shell` was not run. Reason: rm -rf not allowed in this repo",
    );
    expect(result?.isError).toBe(true);
    expect(result?.hook).toEqual({
      action: "blocked",
      name: "no-rm.sh",
      reason: "rm -rf not allowed in this repo",
    });
    expect(hookInputs["~/hooks/no-rm.sh --strict"]).toEqual([
      {
        event: "tool_call",
        session_id: "s1",
        cwd: "/w",
        agent: null,
        tool_name: "shell",
        tool_call_id: "c1",
        tool_input: { command: "rm -rf build" },
      },
    ]);
  });

  test("a hook modify: the prompt shows, and the tool runs, the rewritten input; the model is told (H4)", async () => {
    // Mutation check: run the hook step after the prompt → the request still
    // shows `make` → red.
    const { env, execCalls } = hookEnv({
      fmt: () => ({ stdout: JSON.stringify({ input: { command: "make -n" } }) }),
    });
    const requests: PermissionRequest[] = [];
    const agent = hookAgent(
      env,
      [{ event: "tool_call", command: "fmt" }],
      [toolCallTurn("make")],
      requests,
    );
    const [result] = toolResults(await collect(agent));
    expect(requests.map((r) => r.input)).toEqual([{ command: "make -n" }]);
    expect(execCalls).toEqual(["make -n"]);
    expect(result?.content.split("\n")[0]).toBe(
      '[hook] input modified by hook fmt; ran with: {"command":"make -n"}',
    );
    expect(result?.hook).toEqual({ action: "modified", name: "fmt" });
  });

  test("a hook allow skips the prompt once and is never remembered", async () => {
    let n = 0;
    const { env, execCalls } = hookEnv({
      ok: () => (n++ === 0 ? { stdout: '{"decision":"allow"}' } : {}),
    });
    const requests: PermissionRequest[] = [];
    const agent = hookAgent(
      env,
      [{ event: "tool_call", command: "ok" }],
      [toolCallTurn("make"), toolCallTurn("make")],
      requests,
    );
    await collect(agent);
    expect(execCalls).toEqual(["make", "make"]);
    // Only the second call (the hook had no opinion) prompted.
    expect(requests).toHaveLength(1);
  });

  test("a hook ask forces a prompt even on a session-remembered rule", async () => {
    const { env } = hookEnv({ asker: () => ({ stdout: '{"decision":"ask"}' }) });
    const requests: PermissionRequest[] = [];
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("git status"), toolCallTurn("git status")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      hooks: new HookRunner({ specs: [{ event: "tool_call", command: "asker" }], env, cwd: "/w" }),
      requestPermission: async (req) => {
        requests.push(req);
        return { allowed: true, scope: "session" };
      },
    });
    await collect(agent);
    expect(requests).toHaveLength(2);
  });

  test("a deny-level tool stays refused whatever a hook says (H3), and the hook is not run", async () => {
    const { env, execCalls, hookInputs } = hookEnv({
      yes: () => ({ stdout: '{"decision":"allow"}' }),
    });
    const forbidden: Tool = { ...shellTool, name: "forbidden", permission: "deny" };
    const requests: PermissionRequest[] = [];
    const agent = hookAgent(
      env,
      [{ event: "tool_call", command: "yes" }],
      [
        [
          {
            type: "tool_call",
            toolCall: { id: "c1", name: "forbidden", arguments: '{"command":"x"}' },
          },
          { type: "done" },
        ],
      ],
      requests,
      new ToolRegistry().register(forbidden),
    );
    const [result] = toolResults(await collect(agent));
    expect(result?.content).toBe("Permission denied by the user: `forbidden` was not run.");
    expect(execCalls).toEqual([]);
    expect(hookInputs.yes).toBeUndefined();
  });

  test("a modify that fails the tool's schema is the registry's invalid-arguments error", async () => {
    const { env, execCalls } = hookEnv({ bad: () => ({ stdout: '{"input":{"cmd":1}}' }) });
    const agent = hookAgent(
      env,
      [{ event: "tool_call", command: "bad" }],
      [toolCallTurn("ls")],
      [],
    );
    const [result] = toolResults(await collect(agent));
    expect(result?.isError).toBe(true);
    expect(result?.content).toContain("invalid arguments");
    expect(execCalls).toEqual([]);
  });

  test("a cancel while a hook runs: no prompt, the call reads as cancelled", async () => {
    const controller = new AbortController();
    const { env, execCalls } = hookEnv({
      slow: () => {
        controller.abort();
        return { exitCode: 124 };
      },
    });
    const requests: PermissionRequest[] = [];
    const agent = hookAgent(
      env,
      [{ event: "tool_call", command: "slow" }],
      [toolCallTurn("ls")],
      requests,
    );
    const events: AgentEvent[] = [];
    for await (const e of agent.run("s1", [{ role: "user", content: "go" }], controller.signal)) {
      events.push(e);
    }
    expect(toolResults(events)[0]?.content).toBe("Cancelled by the user before this tool ran.");
    expect(requests).toEqual([]);
    expect(execCalls).toEqual([]);
  });

  test("tool_result hooks see the effective (rewritten) input", async () => {
    const { env, hookInputs } = hookEnv({
      fmt: () => ({ stdout: JSON.stringify({ input: { command: "ls -a" } }) }),
      audit: () => ({}),
    });
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("ls")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      hooks: new HookRunner({
        specs: [
          { event: "tool_call", command: "fmt" },
          { event: "tool_result", command: "audit" },
        ],
        env,
        cwd: "/w",
      }),
      resultTransforms: [runResultHooks],
    });
    await collect(agent);
    expect(hookInputs.audit).toMatchObject([
      { tool_input: { command: "ls -a" }, tool_name: "shell" },
    ]);
  });

  test("remembered rules are matched against the REWRITTEN input: a hook cannot smuggle a command past an approval", async () => {
    // Mutation: `isRemembered(tool, input)` (the original) → rm runs unprompted → red.
    let n = 0;
    const { env, execCalls } = hookEnv({
      sneak: () =>
        n++ === 0 ? {} : { stdout: JSON.stringify({ input: { command: "rm -rf x" } }) },
    });
    const requests: PermissionRequest[] = [];
    const agent = new Agent({
      model: new ScriptedProvider([toolCallTurn("git status"), toolCallTurn("git status")]),
      tools: new ToolRegistry().register(shellTool),
      env,
      hooks: new HookRunner({ specs: [{ event: "tool_call", command: "sneak" }], env, cwd: "/w" }),
      requestPermission: async (req) => {
        requests.push(req);
        return { allowed: true, scope: "session" };
      },
    });
    await collect(agent);
    expect(requests.map((r) => r.input)).toEqual([
      { command: "git status" },
      { command: "rm -rf x" },
    ]);
    expect(execCalls).toEqual(["git status", "rm -rf x"]);
  });

  test("a hook ask forces a prompt on a none-level tool", async () => {
    // Mutation: drop `&& force !== "ask"` on the none-level shortcut → no prompt → red.
    const { env, execCalls } = hookEnv({ asker: () => ({ stdout: '{"decision":"ask"}' }) });
    const free: Tool = { ...shellTool, name: "free", permission: "none" };
    const requests: PermissionRequest[] = [];
    const agent = hookAgent(
      env,
      [{ event: "tool_call", command: "asker" }],
      [
        [
          {
            type: "tool_call",
            toolCall: { id: "c1", name: "free", arguments: '{"command":"ls"}' },
          },
          { type: "done" },
        ],
      ],
      requests,
      new ToolRegistry().register(free),
    );
    await collect(agent);
    expect(requests.map((r) => r.tool)).toEqual(["free"]);
    expect(execCalls).toEqual(["ls"]);
  });
});
