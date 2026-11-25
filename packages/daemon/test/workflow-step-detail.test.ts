/**
 * `session/workflow_step` (docs/feat/workflows-ui.md slice 1a, D1): ONE step
 * execution's `prompt`/`report` — the detail the `workflows` ROW deliberately
 * does not carry (that is a live row, not history).
 *
 * The properties:
 * - an ended step answers its own entry: `live:false`, prompt AND report;
 * - a step running now answers `live:true`, its prompt, and NO report (the row's
 *   live text stands in for it) — and the ended entry replaces that answer;
 * - the newest execution when `attempt` is omitted, the one asked for when given;
 * - a step that never ran, or one whose entry left the retained log (a
 *   compaction two segments back), is `{}` — never a throw, never another
 *   step's text;
 * - a session with no driver (a pod, tunnelled) is `{}`;
 * - the RPC dispatch reaches it (`session/workflow_step` is a real method).
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, WorkflowDriver, type WorkflowDriverDeps } from "@tentacle/agent";
import {
  type ChatMessage,
  type ExecutionEnvironment,
  PermissionBroker,
  type ToolContext,
} from "@tentacle/core";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
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

/** ONE agent step, whose resolved prompt is `plan it`. */
const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    agent: { prompt_text: plan it }\n";

/** ONE agent step that RETRIES once: two executions of the same step id. */
const RETRY_YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    retry: 1\n    agent: { prompt_text: plan it }\n";

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

/** A driver whose one agent step ends `report`, optionally parked mid-step on `gate`. */
function driver(options: { report?: string; gate?: Promise<void> } = {}): WorkflowDriver {
  const deps: WorkflowDriverDeps = {
    load: async () => ({ path: ".tentacle/workflows/task.yaml", text: YAML, prompts: {} }),
    context: () => ({ models: [], agentTypes: ["general"] }),
    approvals: { has: async () => true, add: async () => {} },
    request: async () => ({ allowed: false }),
    runnerFor: () => async (_opts, controls) => {
      const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
      await verdict?.execute({ verdict: "pass", reason: "planned" }, {} as ToolContext);
      await options.gate;
      return { report: options.report ?? "step report text", toolUses: 1, stopReason: "end_turn" };
    },
  };
  return new WorkflowDriver(deps);
}

/** Let the driver's promises settle: `start` returns before the steps run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 40; i++) {
    await Promise.resolve();
  }
};

/** A session whose one step has ENDED. */
async function ranStep(): Promise<HostedSession> {
  const session = hosted();
  session.attachWorkflows(driver());
  const started = await session.workflow({
    sessionId: "s1",
    action: "start",
    name: "task",
    turnId: "t-1",
  });
  expect(started).toEqual({ ok: true, runId: "wf-1" });
  await settle();
  return session;
}

/** A gate released by the caller, for the in-flight cases. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

describe("session/workflow_step: the ended execution", () => {
  test("answers its own entry: prompt + report, live:false", async () => {
    const session = await ranStep();
    const result = session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" });
    expect(result.detail).toMatchObject({
      attempt: 0,
      round: 0,
      live: false,
      state: "ok",
      verdict: "pass",
      prompt: "plan it",
      report: "step report text",
    });
    // The measured fields come from the entry, so they are always there.
    expect(typeof result.detail?.durationMs).toBe("number");
    expect(typeof result.detail?.tokens).toBe("number");
  });

  test("an unknown step, and an unknown run, are both `{}`", async () => {
    const session = await ranStep();
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "nope" })).toEqual({});
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-9", stepId: "plan" })).toEqual({});
  });

  test("a run that never started is `{}`", () => {
    const session = hosted();
    session.attachWorkflows(driver());
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" })).toEqual({});
  });
});

describe("session/workflow_step: the execution in flight", () => {
  test("live:true with the prompt and no report; the ended entry replaces it", async () => {
    // Mutation: answer the live record even when the entry exists → the second
    // assertion (the report from the entry) goes red.
    const parked = gate();
    const session = hosted();
    session.attachWorkflows(driver({ gate: parked.wait }));
    await session.workflow({ sessionId: "s1", action: "start", name: "task", turnId: "t-1" });
    await settle();
    const live = session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" });
    expect(live.detail).toMatchObject({ attempt: 0, round: 0, live: true, prompt: "plan it" });
    // A step that has not ended has no report to give.
    expect(live.detail?.report).toBeUndefined();
    parked.open();
    await settle();
    const ended = session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" });
    expect(ended.detail).toMatchObject({ live: false, report: "step report text" });
  });

  test("a live record is NOT offered for another run or another step", async () => {
    const parked = gate();
    const session = hosted();
    session.attachWorkflows(driver({ gate: parked.wait }));
    await session.workflow({ sessionId: "s1", action: "start", name: "task", turnId: "t-1" });
    await settle();
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-2", stepId: "plan" })).toEqual({});
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "other" })).toEqual({});
    parked.open();
    await settle();
  });
});

describe("session/workflow_step: which execution", () => {
  test("an omitted attempt is the newest; the one asked for is answered exactly", async () => {
    const session = await ranStep();
    const newest = session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" });
    expect(newest.detail).toMatchObject({ attempt: 0, report: "step report text" });
    const exact = session.workflowStep({
      sessionId: "s1",
      runId: "wf-1",
      stepId: "plan",
      attempt: 0,
      round: 0,
    });
    expect(exact.detail).toMatchObject({ attempt: 0, round: 0, report: "step report text" });
  });

  test("with a retry, omitted is the LAST attempt and `attempt: 0` is the first", async () => {
    // The scan is NEWEST-first: mutation (oldest-first) makes `attempt: 0` win
    // for an omitted attempt and this goes red.
    let calls = 0;
    const session = hosted();
    const deps: WorkflowDriverDeps = {
      load: async () => ({ path: ".tentacle/workflows/task.yaml", text: RETRY_YAML, prompts: {} }),
      context: () => ({ models: [], agentTypes: ["general"] }),
      approvals: { has: async () => true, add: async () => {} },
      request: async () => ({ allowed: false }),
      runnerFor: () => async (_opts, controls) => {
        const attempt = calls++;
        const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
        await verdict?.execute(
          { verdict: attempt === 0 ? "fail" : "pass", reason: `try ${attempt}` },
          {} as ToolContext,
        );
        return { report: `text ${attempt}`, toolUses: 1, stopReason: "end_turn" };
      },
    };
    session.attachWorkflows(new WorkflowDriver(deps));
    await session.workflow({ sessionId: "s1", action: "start", name: "task", turnId: "t-1" });
    await settle();
    expect(calls).toBe(2);
    const newest = session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" });
    expect(newest.detail).toMatchObject({ attempt: 1, verdict: "pass", report: "text 1" });
    const first = session.workflowStep({
      sessionId: "s1",
      runId: "wf-1",
      stepId: "plan",
      attempt: 0,
    });
    expect(first.detail).toMatchObject({ attempt: 0, verdict: "fail", report: "text 0" });
  });

  test("an attempt the step never ran is `{}`, even when it has other attempts", async () => {
    // Mutation: ignore `attempt` in the scan → this answers attempt 0 and goes red.
    const session = await ranStep();
    expect(
      session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan", attempt: 3 }),
    ).toEqual({});
    expect(
      session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan", round: 2 }),
    ).toEqual({});
  });
});

describe("session/workflow_step: what the retained log can no longer answer", () => {
  test("an entry two segments back is `{}` — 'no longer available', not a throw", async () => {
    const session = await ranStep();
    expect(
      session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" }).detail,
    ).toBeDefined();
    // Retention is the current segment and the previous one. Two replacements
    // push the segment carrying the entry out of that window.
    session.clear();
    expect(
      session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" }).detail,
    ).toBeDefined();
    session.clear();
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" })).toEqual({});
  });
});

describe("session/workflow_step: a session that cannot answer", () => {
  test("no driver (a tunnelled pod session) and no entry: `{}`, never a throw", () => {
    const session = hosted();
    expect(session.workflowStep({ sessionId: "s1", runId: "wf-1", stepId: "plan" })).toEqual({});
  });
});

describe("session/workflow_step over the wire", () => {
  /** A whole daemon whose ONE session gets a workflow driver. */
  async function peerTo(): Promise<RpcPeer> {
    const host = new SessionHost({
      defaultCwd: "/tmp/workflow-step-detail",
      createAgent: () => ({
        agent: new Agent({
          model: {
            id: "one",
            async *stream() {
              yield { type: "done" };
            },
          },
          tools: new ToolRegistry(),
          env: noopEnv,
        }),
        permissions: new PermissionBroker(),
        workflows: driver(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const peer = new RpcPeer(c, {});
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await peer.request("session/open", { sessionId: "s1", create: true });
    return peer;
  }

  test("the method is dispatched: an ended step answers its entry", async () => {
    // Mutation: no `case Method.WorkflowStep` in the dispatch → UnknownMethod.
    const peer = await peerTo();
    await peer.request(Method.Workflow, {
      sessionId: "s1",
      action: "start",
      name: "task",
      turnId: "t-1",
    });
    await settle();
    const result = (await peer.request(Method.WorkflowStep, {
      sessionId: "s1",
      runId: "wf-1",
      stepId: "plan",
    })) as { detail?: { report?: string; live: boolean } };
    expect(result.detail).toMatchObject({ live: false, report: "step report text" });
  });

  /**
   * The editor's two methods (docs/feat/workflow-editor.md slice 3b) reach the
   * session through the dispatch — which the direct-call tests above cannot see:
   * they call `session.workflowSource`/`workflowSave` themselves.
   *
   * This session's driver has no writer wired, so both answer `unavailable`.
   * That ANSWER is the proof of dispatch: a missing `case` in `connection.ts`
   * rejects `MethodNotFound` instead, and these requests would throw.
   */
  test("session/workflow_source and workflow_save are dispatched, both answering", async () => {
    const peer = await peerTo();
    const source = (await peer.request(Method.WorkflowSource, {
      sessionId: "s1",
      name: "task",
    })) as { ok: boolean; unavailable?: string };
    expect(source.ok).toBe(false);
    expect(source.unavailable).toContain("edited only on a laptop or serve session");
    const saved = (await peer.request(Method.WorkflowSave, {
      sessionId: "s1",
      name: "task",
      mode: "replace",
      draft: "{}",
      prompts: [],
      dryRun: true,
    })) as { ok: boolean; refusal?: string; reason?: string };
    expect(saved.ok).toBe(false);
    expect(saved.refusal).toBe("unavailable");
    expect(saved.reason).toContain("edited only on a laptop or serve session");
  });
});
