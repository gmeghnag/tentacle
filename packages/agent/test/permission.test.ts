import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequest,
  PermissionResponse,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";

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
