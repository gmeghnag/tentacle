import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ExecResult,
  ExecutionEnvironment,
  HookSpec,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";
import {
  type AskHooksTrust,
  HookRunner,
  type ProjectHooksOptions,
  projectVote,
} from "../src/hooks.ts";

const ok = (stdout: string): ExecResult => ({ stdout, stderr: "", exitCode: 0 });

function fakeEnv(answer: (command: string) => ExecResult) {
  const ran: string[] = [];
  const env: ExecutionEnvironment = {
    id: "fake",
    async exec(command) {
      ran.push(command);
      return answer(command);
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  return { env, ran };
}

class SayProvider implements ModelProvider {
  readonly id = "say";
  calls = 0;
  async *stream(): AsyncIterable<StreamEvent> {
    this.calls++;
    yield { type: "text", delta: "hi" };
    yield { type: "done" };
  }
}

const userStart: HookSpec = { event: "turn_start", command: "user-start" };
const projStart: HookSpec = { event: "turn_start", command: "proj-start" };
const projGuard: HookSpec = { event: "tool_call", matcher: "shell", command: "proj-guard" };

function project(specs: readonly HookSpec[], canAllow = true): ProjectHooksOptions {
  return { specs, folder: "/repo", hash: "h1", files: [".agents/hooks.json"], canAllow };
}

function setup(
  userSpecs: readonly HookSpec[],
  proj: ProjectHooksOptions,
  answer: (command: string) => ExecResult = () => ok(""),
) {
  const { env, ran } = fakeEnv(answer);
  const logs: string[] = [];
  const hooks = new HookRunner({
    specs: userSpecs,
    env,
    cwd: "/w",
    log: (l) => logs.push(l),
    project: proj,
  });
  const model = new SayProvider();
  const agent = new Agent({ model, tools: new ToolRegistry(), env, hooks });
  return { agent, hooks, ran, logs, model };
}

async function turn(
  agent: Agent,
  messages: ChatMessage[],
  ask?: AskHooksTrust,
  signal?: AbortSignal,
): Promise<AgentEvent[]> {
  messages.push({ role: "user", content: "go" });
  const events: AgentEvent[] = [];
  for await (const e of agent.runMessages(
    messages,
    "S",
    signal,
    undefined,
    ask ? { askHooksTrust: ask } : {},
  )) {
    events.push(e);
  }
  return events;
}

const call = { sessionId: "S", toolName: "shell", toolCallId: "c1", input: { command: "ls" } };

describe("projectVote (D6)", () => {
  test("where a project hook may not approve, its allow is no vote", () => {
    expect(projectVote({ kind: "allow" }, false)).toEqual({ kind: "none" });
    expect(projectVote({ kind: "modify", input: { a: 1 }, decision: "allow" }, false)).toEqual({
      kind: "modify",
      input: { a: 1 },
    });
    expect(projectVote({ kind: "deny", reason: "r" }, false)).toEqual({
      kind: "deny",
      reason: "r",
    });
    expect(projectVote({ kind: "ask" }, false)).toEqual({ kind: "ask" });
  });

  test("where it may (local), the vote is unchanged", () => {
    expect(projectVote({ kind: "allow" }, true)).toEqual({ kind: "allow" });
  });
});

describe("project hooks and trust", () => {
  test("project hooks never run before trust", async () => {
    const { hooks, ran } = setup([], project([projGuard]), () => ok('{"decision":"deny"}'));
    const verdict = await hooks.toolCall({ ...call, signal: new AbortController().signal });
    expect(ran).toEqual([]);
    expect(verdict.kind).toBe("gate");
  });

  test("declined → they never run; asked once per runner (session)", async () => {
    const { agent, ran } = setup([userStart], project([projStart]));
    let asked = 0;
    const ask: AskHooksTrust = async () => {
      asked++;
      return false;
    };
    const messages: ChatMessage[] = [];
    await turn(agent, messages, ask);
    await turn(agent, messages, ask);
    expect(asked).toBe(1);
    expect(ran).toEqual(["user-start", "user-start"]);
  });

  test("trusted → they run after the user's for the same event; asked once", async () => {
    const { agent, ran } = setup([userStart], project([projStart]));
    const seen: unknown[] = [];
    const ask: AskHooksTrust = async (req) => {
      seen.push(req);
      return true;
    };
    const messages: ChatMessage[] = [];
    await turn(agent, messages, ask);
    await turn(agent, messages, ask);
    expect(ran).toEqual(["user-start", "proj-start", "user-start", "proj-start"]);
    expect(seen).toEqual([
      {
        sessionId: "S",
        folder: "/repo",
        hash: "h1",
        files: [".agents/hooks.json"],
        hooks: [{ event: "turn_start", command: "proj-start" }],
        canAllow: true,
      },
    ]);
  });

  test("no asker (non-interactive, in-process headless) → declined, logged", async () => {
    const { agent, ran, logs } = setup([], project([projStart]));
    await turn(agent, []);
    expect(ran).toEqual([]);
    expect(logs.some((l) => l.includes("no client to ask"))).toBe(true);
  });

  test("the ask rejecting (an old laptop's MethodNotFound, a disconnect) → declined; the turn runs", async () => {
    const { agent, ran, logs, model } = setup([], project([projStart]));
    const events = await turn(agent, [], async () => {
      throw new Error("unexpected request: hooks/trust");
    });
    expect(ran).toEqual([]);
    expect(model.calls).toBe(1);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(logs.some((l) => l.includes("hooks/trust"))).toBe(true);
  });

  test("a cancel while asked → not run, the turn ends cancelled; the next turn asks again", async () => {
    const { agent, ran, model } = setup([], project([projStart]));
    const controller = new AbortController();
    const messages: ChatMessage[] = [];
    const pending = turn(agent, messages, () => new Promise<boolean>(() => {}), controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const events = await pending;
    expect(ran).toEqual([]);
    expect(model.calls).toBe(0);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    let asked = 0;
    await turn(agent, messages, async () => {
      asked++;
      return true;
    });
    expect(asked).toBe(1);
    expect(ran).toEqual(["proj-start"]);
  });

  test("a sub-agent's runner shares the session's decision", async () => {
    const { hooks, ran } = setup([], project([projGuard]), () => ok(""));
    const child = hooks.forAgent({ type: "t", description: "d" });
    await hooks.resolveProjectTrust("S", async () => true);
    expect(child.needsProjectTrust()).toBe(false);
    await child.toolCall({ ...call, signal: new AbortController().signal });
    expect(ran).toEqual(["proj-guard"]);
  });

  test("canAllow false: a trusted project hook's allow does not skip the prompt", async () => {
    const local = setup([], project([projGuard], true), () => ok('{"decision":"allow"}'));
    await local.hooks.resolveProjectTrust("S", async () => true);
    const v1 = await local.hooks.toolCall({ ...call, signal: new AbortController().signal });
    expect(v1).toMatchObject({ kind: "gate", force: "allow" });

    const pod = setup([], project([projGuard], false), () => ok('{"decision":"allow"}'));
    await pod.hooks.resolveProjectTrust("S", async () => true);
    const v2 = await pod.hooks.toolCall({ ...call, signal: new AbortController().signal });
    expect(pod.ran).toEqual(["proj-guard"]);
    expect(v2).toMatchObject({ kind: "gate", force: null });
  });
});
