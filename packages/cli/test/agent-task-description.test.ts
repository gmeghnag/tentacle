/**
 * fix/agent-task-scope + docs/feat/agent-status.md ("Merge into agent_control"),
 * through the REAL wiring (`buildAgent`): the texts the agent is actually given
 * for each `subagents.twoWay`, read off the request — not off the pure
 * functions, so a flag the wiring forgets to pass is red.
 *
 * Mutation (non-vacuity, AGENTS §9): drop `twoWay` from the `createTaskTool` /
 * `createAgentControlTool` options in `wiring.ts` → "on" loses the reply line.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { buildAgent } from "../src/wiring.ts";

/** The neutral `agent_task` text as it stands: `agent_control` is the way in. */
const TODAY_TASK_NEUTRAL =
  "Delegate a self-contained task to a sub-agent that runs in its own isolated context and returns a final report. You do NOT see its intermediate steps, so it offloads read-heavy work without filling your own context. To create agents, use this tool. Start another agent CLI (claude, codex, tentacle, …) through the shell only when the user explicitly asks for it. Scope each prompt: the files, diff or questions it owns, and a stop criterion — what counts as done. Turn-based: one foreground sub-agent at a time, its report the call's result. Long-lived: `background: true`, then `agent_control` to steer it while it works.";
/** `agent_control`'s one description, `twoWay` off — the one-way facts. */
const CONTROL_ONE_WAY =
  'Control a background sub-agent (agent_task{background:true}). "status": read-only, what it is doing and its last actions; never a way to wait — its report arrives as a [background] note that wakes you. "message" (agent_id, text): read before its next model step; one-way, no reply comes back. "kill" (agent_id): stops it; its report still arrives.';

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
  test("twoWay off: agent_control's one description is one-way, agent_task has no reply line", async () => {
    const tools = await offered({ subagentsTwoWay: false });
    expect(tools.get("agent_control")).toBe(CONTROL_ONE_WAY);
    // The three tools it replaced are not offered at all (the merge is the point).
    for (const old of ["agent_kill", "agent_message", "agent_status"]) {
      expect(tools.get(old)).toBeUndefined();
    }
    const task = tools.get("agent_task") ?? "";
    expect(task.startsWith(TODAY_TASK_NEUTRAL)).toBe(true);
    expect(task).not.toContain("agent_notify");
    // ... and the type list still closes it, as always.
    expect(task).toContain("\n\nAvailable sub-agent types:\n- ");
  });

  test("twoWay on: both texts say a background child may answer with agent_notify", async () => {
    const tools = await offered({ subagentsTwoWay: true });
    const message = tools.get("agent_control") ?? "";
    expect(message).not.toBe(CONTROL_ONE_WAY);
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
