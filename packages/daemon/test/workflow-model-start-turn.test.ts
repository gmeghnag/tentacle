/**
 * docs/fix/workflow-model-start-turn.md: a run the MODEL starts (`workflow` tool,
 * `by: "model"`) is attributed to the turn that started it, so its steps' asks
 * carry a turn and auto-accept answers them (trusted `serve`) — or the client's
 * own-turn test can (worker/TUI). `workflow_approve` is never auto-answered.
 * Mutation: drop `currentTurn` from `attachWorkflows` (or the driver's fallback)
 * → the first two tests turn red.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, WorkflowDriver, type WorkflowDriverDeps } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequester,
  type StreamEvent,
  type ToolContext,
} from "@tentacle/core";
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry, createWorkflowTool } from "@tentacle/tools";
import { HostedSession } from "../src/hosted-session.ts";

const env = {
  id: "n",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as ExecutionEnvironment;
const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: gate\n    run: bun run check\n  - id: plan\n    agent: { prompt_text: plan it }\n";
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
const settle = async (n = 40) => {
  for (let i = 0; i < n; i++) await tick();
};
const shellReq = (c: string) => ({
  tool: "shell",
  level: "ask" as const,
  title: c,
  input: { command: c },
});

class Scripted implements ModelProvider {
  readonly id = "scripted";
  private round = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const e of this.script[this.round++] ?? [{ type: "done" }]) yield e;
  }
}
const startRun: StreamEvent[] = [
  {
    type: "tool_call",
    toolCall: { id: "c1", name: "workflow", arguments: '{"action":"run","name":"task"}' },
  },
  { type: "done" },
];

function rig(opts: { answers: boolean; hashApproved: boolean }) {
  const broker = new PermissionBroker();
  const request = broker.request.bind(broker);
  const tools = new ToolRegistry();
  const agent = new Agent({ model: new Scripted([startRun]), tools, env });
  const hosted = new HostedSession(
    "s1",
    new Session(agent, "s1", {}),
    broker,
    undefined,
    opts.answers ? { answersAutoAccept: true } : {},
  );
  const frames: KnownSessionUpdateParams[] = [];
  hosted.attach({ send: (u) => frames.push(u) });
  const deps: WorkflowDriverDeps = {
    load: async () => ({ path: ".tentacle/workflows/task.yaml", text: YAML, prompts: {} }),
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => opts.hashApproved, add: async () => {} },
    request: (req, o) => request(req, o),
    commands: {
      authorize: async (command, requester: PermissionRequester) => {
        const r = await requester(shellReq(command));
        return r.allowed ? { allowed: true, command } : { allowed: false, reason: "denied" };
      },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    },
    runnerFor: (requester) => async (_o, controls) => {
      await requester(shellReq("git status"));
      const v = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await v?.execute({ verdict: "pass", reason: "ok" }, {} as ToolContext);
      return { report: "ok", toolUses: 1, stopReason: "end_turn" };
    },
  };
  const driver = new WorkflowDriver(deps);
  tools.register(createWorkflowTool(driver));
  hosted.attachWorkflows(driver);
  hosted.setAutoAccept(true);
  const asks = () =>
    frames.flatMap((p) => (p.update.type === "permission_request" ? [p.update] : []));
  const resolved = () => frames.filter((p) => p.update.type === "permission_resolved").length;
  return { hosted, driver, asks, resolved };
}

const go = [{ type: "text" as const, text: "go" }];

describe("a model-started workflow run is attributed to its turn", () => {
  test("trusted serve: every step ask is auto-answered, each carries the turn", async () => {
    const r = rig({ answers: true, hashApproved: true });
    await r.hosted.prompt("t-1", go);
    await settle();
    const asks = r.asks();
    expect(asks.length).toBe(2);
    expect(asks.map((a) => a.turnId)).toEqual(["t-1", "t-1"]);
    expect(r.resolved()).toBe(2);
  });

  test("worker: the ask names the turn (the client's own-turn test can answer); the daemon does not", async () => {
    const r = rig({ answers: false, hashApproved: true });
    await r.hosted.prompt("t-1", go);
    await settle();
    const asks = r.asks();
    expect(asks.length).toBeGreaterThan(0);
    expect(asks.every((a) => a.turnId === "t-1")).toBe(true);
    expect(r.resolved()).toBe(0);
  });

  test("workflow_approve stays manual even with a turn and auto-accept ON", async () => {
    const r = rig({ answers: true, hashApproved: false });
    await r.hosted.prompt("t-1", go);
    await settle();
    const approve = r.asks().filter((a) => a.tool === "workflow_approve");
    expect(approve.length).toBe(1);
    expect(approve[0]?.turnId).toBe("t-1");
    expect(r.resolved()).toBe(0);
  });

  test("a start with no turn running (nothing to attribute to) is not auto-answered", async () => {
    const r = rig({ answers: true, hashApproved: true });
    await r.driver.start({ name: "task", by: "model" });
    await settle();
    expect(r.asks().map((a) => a.turnId ?? null)).toEqual([null]);
    expect(r.resolved()).toBe(0);
  });
});
