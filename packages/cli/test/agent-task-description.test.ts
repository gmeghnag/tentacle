/**
 * fix/agent-task-scope, through the REAL wiring (`buildAgent`): the texts the
 * agent is actually given for each `subagents.twoWay`, read off the request —
 * not off the pure functions, so a flag the wiring forgets to pass is red.
 *
 * Mutation (non-vacuity, AGENTS §9): drop `twoWay` from the `createTaskTool`
 * options in `wiring.ts` → "on" loses the reply line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

/** The two texts as they stood before this task: `twoWay` off must keep them. */
const TODAY_TASK_NEUTRAL =
  "Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so it offloads read-heavy work without filling your own context. To create agents, use this tool. Start another agent CLI (claude, codex, tentacle, …) through the shell only when the user explicitly asks for it. Scope each prompt: the files, diff or questions it owns, and a stop criterion — what counts as done. Turn-based: one foreground sub-agent at a time, its report the call's result. Long-lived: `background: true`, then `agent_message` to steer it while it works.";
const TODAY_MESSAGE =
  "Send a message to a running background sub-agent started with agent_task{background: true}. It reads it before its next model step. One-way: no reply comes back, and its report still arrives later as a [background] note. It does not wake you.";

class RecordingModel implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "done" };
  }
}

let dir: string;
let config: TentacleConfig;
const saved = process.env.TENTACLE_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-task-description-"));
  const configDir = join(dir, "config");
  await mkdir(configDir, { recursive: true });
  process.env.TENTACLE_CONFIG_DIR = configDir; // never the user's config
  await writeFile(
    join(configDir, "config.jsonc"),
    JSON.stringify({ subagents: { enabled: true, maxParallel: 2 } }),
  );
  config = await loadConfig({ configDir, cwd: dir, env: {} });
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

/** One turn through the real agent, returning the tools it was offered. */
async function offered(over: Partial<TentacleConfig>): Promise<Map<string, string>> {
  const model = new RecordingModel();
  const { agent } = buildAgent({ ...config, ...over }, { modelOverride: model });
  for await (const _event of agent.run("s", [{ role: "user", content: "go" }])) {
    // drained
  }
  const tools = new Map<string, string>();
  for (const definition of model.requests[0]?.tools ?? []) {
    tools.set(definition.name, definition.description);
  }
  return tools;
}

describe("the sub-agent texts the agent is really given", () => {
  test("twoWay off: agent_message is today's, agent_task has no reply line", async () => {
    const tools = await offered({ subagentsTwoWay: false });
    expect(tools.get("agent_message")).toBe(TODAY_MESSAGE);
    const task = tools.get("agent_task") ?? "";
    expect(task.startsWith(TODAY_TASK_NEUTRAL)).toBe(true);
    expect(task).not.toContain("agent_notify");
    // ... and the type list still closes it, as always.
    expect(task).toContain("\n\nAvailable sub-agent types:\n- ");
  });

  test("twoWay on: both texts say a background child may answer with agent_notify", async () => {
    const tools = await offered({ subagentsTwoWay: true });
    const message = tools.get("agent_message") ?? "";
    expect(message).not.toBe(TODAY_MESSAGE);
    expect(message).toContain("agent_notify");
    expect(message).toContain("[sub-agent sa-N → you]");
    expect(message).toContain("may wake you");
    const task = tools.get("agent_task") ?? "";
    expect(task).toContain("A background sub-agent may reply with `agent_notify`");
    expect(task).toContain("`[sub-agent sa-N → you]` note and may wake you");
    expect(task).toContain("\n\nAvailable sub-agent types:\n- ");
  });

  test("a custom agentTaskDescription still replaces the neutral text whole", async () => {
    const tools = await offered({ agentTaskDescription: "Use me well.", subagentsTwoWay: true });
    expect(
      tools.get("agent_task")?.startsWith("Use me well.\n\nAvailable sub-agent types:\n- "),
    ).toBe(true);
  });
});
