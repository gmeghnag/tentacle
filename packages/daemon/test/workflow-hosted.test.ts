/**
 * The workflow driver bound into a hosted session (docs/feat/agent-workflows.md
 * Slice 4, review round 1 #2): `session/workflow` reaches it, the rows reach the
 * snapshot, the end note rides the exits queue (it wakes), run ids are seeded
 * from the history (#1), and a session without a driver (tunnelled) refuses.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, WorkflowDriver, type WorkflowDriverDeps } from "@tentacle/agent";
import {
  type ChatMessage,
  type ExecutionEnvironment,
  NOTE_KIND,
  PermissionBroker,
  type ToolContext,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { HostedSession } from "../src/hosted-session.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    agent: { prompt_text: plan it }\n";

function hosted(messages: ChatMessage[] = []): HostedSession {
  const agent = new Agent({
    model: {
      id: "one",
      async *stream() {
        yield { type: "done" };
      },
    },
    tools: new ToolRegistry(),
    env: noopEnv,
  });
  const session = new Session(agent);
  session.messages.push(...messages);
  return new HostedSession("s1", session, new PermissionBroker());
}

function driver(): WorkflowDriver {
  const deps: WorkflowDriverDeps = {
    load: async () => ({ path: "workflows/task.yaml", text: YAML, prompts: {} }),
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => true, add: async () => {} },
    request: async () => ({ allowed: false }),
    runnerFor: () => async (_opts, controls) => {
      const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await verdict?.execute({ verdict: "pass", reason: "planned" }, {} as ToolContext);
      return { report: "ok", toolUses: 1, stopReason: "end_turn" };
    },
  };
  return new WorkflowDriver(deps);
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

describe("session/workflow on a hosted session", () => {
  test("no driver (a tunnelled session): refused, nothing runs", async () => {
    const result = await hosted().workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(result).toEqual({
      ok: false,
      reason: "workflows run only on a laptop or serve session",
    });
  });

  test("a run started over RPC reaches the snapshot and queues its end note (it wakes)", async () => {
    const session = hosted();
    session.attachWorkflows(driver());
    const result = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(result).toEqual({ ok: true, runId: "wf-1" });
    await settle();
    const rows = session.snapshotPage().workflows ?? [];
    expect(rows.map((r) => [r.runId, r.state])).toEqual([["wf-1", "ok"]]);
    expect(session.unflushedExits).toBeGreaterThan(0);
    expect(session.workflowListRows()[0]).toMatchObject({ runId: "wf-1", needsUser: false });
  });

  test("ids are seeded from the history: a restart never re-mints one it names", async () => {
    const session = hosted([
      {
        role: "user",
        content: "[workflow wf-4 task: ok · 1/1 · 0 tok] planned",
        note: { kind: NOTE_KIND.workflowEnd, id: "wf-4" },
      },
    ]);
    session.attachWorkflows(driver());
    const result = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    expect(result).toEqual({ ok: true, runId: "wf-5" });
  });

  test("a wake turn id cannot start a run", async () => {
    const session = hosted();
    session.attachWorkflows(driver());
    const result = await session.workflow({
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "wake-1",
    });
    expect(result.ok).toBe(false);
  });
});
