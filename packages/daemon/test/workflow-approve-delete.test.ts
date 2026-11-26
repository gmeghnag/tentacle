/**
 * `session/workflow_approve` + `session/workflow_delete` on a hosted session
 * (docs/feat/mobile-workflows-landing.md D4): the approval ask is RAISED, never
 * awaited; a session without a driver (a pod's daemon) refuses; a delete names
 * the schedules that still start the workflow.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, WorkflowDriver, type WorkflowDriverDeps } from "@tentacle/agent";
import {
  type ExecutionEnvironment,
  PermissionBroker,
  type PermissionRequest,
} from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { HostedSession } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    agent: { prompt_text: plan it }\n";
const HASH = "a".repeat(64);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve();
  }
};

const agent = (): Agent =>
  new Agent({
    model: {
      id: "one",
      async *stream() {
        yield { type: "done" };
      },
    },
    tools: new ToolRegistry(),
    env: noopEnv,
  });

/** The real driver over fakes; its one requester never answers on its own. */
function approvableDriver() {
  const asks: { req: PermissionRequest; answer(allowed: boolean): void }[] = [];
  const adds: string[] = [];
  const removed: string[] = [];
  const deps: WorkflowDriverDeps = {
    load: async () => ({ path: ".tentacle/workflows/task.yaml", text: YAML, prompts: {} }),
    remove: (name) => {
      removed.push(name);
      return { ok: true, path: `.tentacle/workflows/${name}.yaml` };
    },
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => false, add: async (_path, hash) => void adds.push(hash) },
    request: (req) =>
      new Promise((resolve) => {
        asks.push({ req, answer: (allowed) => resolve({ allowed, scope: "once" }) });
      }),
    runnerFor: () => async () => ({ report: "ok", toolUses: 1, stopReason: "end_turn" }),
  };
  const driver = new WorkflowDriver(deps);
  const prepared = driver.prepareSourceSync("task", {
    path: ".tentacle/workflows/task.yaml",
    text: YAML,
    prompts: {},
  });
  const params = {
    sessionId: "s1",
    name: "task",
    hash: prepared.ok ? prepared.hash : HASH,
    turnId: "t-phone",
  };
  return { driver, asks, adds, removed, params };
}

async function overRpc(driver: WorkflowDriver | undefined): Promise<RpcPeer> {
  const host = new SessionHost({
    defaultCwd: "/tmp/workflow-approve-delete",
    createAgent: () => ({
      agent: agent(),
      permissions: new PermissionBroker(),
      ...(driver ? { workflows: driver } : {}),
    }),
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const client = new RpcPeer(c, {
    onNotification: () => {},
    onRequest: async (method) => {
      throw new Error(`unexpected request ${method}`);
    },
  });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
    clientInfo: { name: "tentacle", version: "1.0.0" },
  });
  await client.request("session/open", { sessionId: "s1", create: true });
  return client;
}

/** A session that can schedule, with an audit sink. */
function schedulingHosted(onAudit: (line: string) => void): HostedSession {
  return new HostedSession(
    "s1",
    new Session(agent()),
    new PermissionBroker(),
    undefined,
    {},
    undefined,
    Date.now,
    undefined,
    {},
    undefined,
    {},
    undefined,
    undefined,
    undefined,
    { setTimeout: () => ({}), clearTimeout: () => {}, onAudit },
  );
}

async function scheduleTwice(session: HostedSession): Promise<void> {
  for (const every of ["2h", "3h"]) {
    const created = await session.scheduleCreateRpc({
      sessionId: "s1",
      turnId: "t-user",
      workflow: { name: "task", inputs: [] },
      every,
    });
    expect(created.ok).toBe(true);
  }
}

describe("session/workflow_approve + workflow_delete", () => {
  test("over RPC: approve answers while its ask is still pending (raised, never awaited)", async () => {
    const { driver, asks, adds, params } = approvableDriver();
    const client = await overRpc(driver);
    const answer = await client.request("session/workflow_approve", params);
    expect(answer).toEqual({ ok: true, asked: true });
    expect(asks.map((a) => a.req.kind)).toEqual(["workflow_approve"]);
    expect(adds).toEqual([]);
    asks[0]?.answer(true);
    await settle();
    expect(adds).toEqual([params.hash]);
  });

  test("over RPC: delete reaches the driver and answers its path", async () => {
    const { driver, removed } = approvableDriver();
    const client = await overRpc(driver);
    const answer = await client.request("session/workflow_delete", {
      sessionId: "s1",
      name: "task",
      hash: HASH,
    });
    expect(answer).toEqual({ ok: true, path: ".tentacle/workflows/task.yaml" });
    expect(removed).toEqual(["task"]);
  });

  test("no driver (a pod's daemon): both answer `unavailable`", async () => {
    const client = await overRpc(undefined);
    const approve = await client.request("session/workflow_approve", {
      sessionId: "s1",
      name: "task",
      hash: HASH,
      turnId: "t",
    });
    expect(approve).toMatchObject({ ok: false, refusal: "unavailable" });
    const gone = await client.request("session/workflow_delete", { sessionId: "s1", name: "task" });
    expect(gone).toMatchObject({ ok: false, refusal: "unavailable" });
  });

  test("a wake turn id cannot ask for an approval: nothing is raised", async () => {
    const { driver, asks, params } = approvableDriver();
    const session = schedulingHosted(() => {});
    session.attachWorkflows(driver);
    const answer = await session.workflowApprove({ ...params, turnId: "wake-sc-1" });
    expect(answer.ok).toBe(false);
    expect(answer.reason).toContain("wake turn id");
    await settle();
    expect(asks).toEqual([]);
  });

  test("a long refusal reason is cut to the wire's cap, never thrown", async () => {
    const { driver, params } = approvableDriver();
    const session = schedulingHosted(() => {});
    session.attachWorkflows(driver);
    driver.approve = async () => ({ ok: false, refusal: "invalid", reason: "x".repeat(5000) });
    const answer = await session.workflowApprove(params);
    expect(answer.refusal).toBe("invalid");
    expect(answer.reason).toHaveLength(2000);
  });

  test("delete names the schedules that still start THIS workflow, and audits it", async () => {
    const { driver } = approvableDriver();
    const audits: string[] = [];
    const session = schedulingHosted((line) => audits.push(line));
    session.attachWorkflows(driver);
    await scheduleTwice(session);
    expect(session.workflowDelete({ sessionId: "s1", name: "other" }).schedules).toBeUndefined();
    expect(session.workflowDelete({ sessionId: "s1", name: "task", hash: HASH })).toEqual({
      ok: true,
      path: ".tentacle/workflows/task.yaml",
      schedules: ["sc-1", "sc-2"],
    });
    expect(audits).toContain("workflow: deleted .tentacle/workflows/task.yaml s1");
  });

  test("a refused delete carries no schedules and audits nothing", async () => {
    const { driver } = approvableDriver();
    const audits: string[] = [];
    const session = schedulingHosted((line) => audits.push(line));
    session.attachWorkflows(driver);
    await scheduleTwice(session);
    driver.remove = () => ({ ok: false, refusal: "changed", reason: "moved" });
    expect(session.workflowDelete({ sessionId: "s1", name: "task", hash: HASH })).toEqual({
      ok: false,
      refusal: "changed",
      reason: "moved",
    });
    expect(audits.filter((a) => a.startsWith("workflow: deleted"))).toEqual([]);
  });
});
