/**
 * docs/feat/a2a.md slice S8: a `tentacle/workflow` data part starts a workflow
 * RUN as the task (`session/workflow{start, turnId: taskId}`), per-caller
 * switch, stop, result mapping. Real SDK handler + real `SessionHost` with a
 * real `WorkflowDriver` (scripted runner); a "phone" is a second `Connection`.
 * Each test names its mutation (§9).
 */
import { describe, expect, test } from "bun:test";
import {
  type Message,
  type Part,
  Role,
  type StreamResponse,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import { ServerCallContext } from "@a2a-js/sdk/server";
import { Agent, WorkflowDriver } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
  type ToolContext,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { A2AExecutor, A2ARequestHandler, REFUSED } from "../src/a2a/executor.ts";
import { buildAgentCard } from "../src/a2a/mapping.ts";
import { A2ATaskStore } from "../src/a2a/task-projection.ts";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

const CWD = "/tmp/a2a-workflow-tasks";
const env = {} as ExecutionEnvironment;
const YAML =
  "schemaVersion: 1\nname: task\nversion: 1\nsteps:\n  - id: plan\n    agent: { prompt_text: plan it }\n";

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`until: timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

class NoModel implements ModelProvider {
  readonly id = "none";
  // biome-ignore lint/correctness/useYield: a workflow task never prompts the model
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    throw new Error("the model is not used by a workflow task");
  }
}

interface RigOptions {
  readonly asks?: "owner" | "both";
  /** The caller's workflows switch (default on here; the refusal test turns it off). */
  readonly workflows?: boolean;
  /** The run's step waits on this before ending. */
  readonly block?: Promise<void>;
  /** The step asks `run` through the run's requester (a tool ask of the run). */
  readonly stepAsk?: boolean;
  /** The file is not approved: the run waits for the owner's approval. */
  readonly unapproved?: boolean;
  readonly yaml?: string;
}

function rig(opts: RigOptions = {}) {
  /** What the step's ask was answered. */
  const stepAnswers: boolean[] = [];
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model: new NoModel(),
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      const workflows = new WorkflowDriver({
        load: async () => ({
          path: ".tentacle/workflows/task.yaml",
          text: opts.yaml ?? YAML,
          prompts: {},
        }),
        context: () => ({ models: [], agentTypes: ["general"] }),
        approvals: { has: async () => opts.unapproved !== true, add: async () => {} },
        request: (req: PermissionRequest, options) => permissions.request(req, options),
        runnerFor: (requester) => async (_o, controls) => {
          if (opts.stepAsk === true) {
            const answer = await requester(
              { tool: "run", level: "ask", title: "run it", input: {} },
              { toolCallId: "step-call" },
            );
            stepAnswers.push(answer.allowed);
          }
          if (opts.block !== undefined) {
            const signal = controls?.signal;
            await Promise.race([
              opts.block,
              new Promise<void>((resolve) => {
                if (signal?.aborted) resolve();
                signal?.addEventListener("abort", () => resolve());
              }),
            ]);
          }
          const verdict = controls?.extraTools?.find((t) => t.name === "step_verdict");
          await verdict?.execute({ verdict: "pass", reason: "planned" }, {} as ToolContext);
          return { report: "the plan", toolUses: 1, stopReason: "end_turn" };
        },
      });
      return { agent, permissions, workflows };
    },
  });
  const policy = (who: string) =>
    who === "default"
      ? { asks: opts.asks ?? "owner", workflows: opts.workflows ?? true }
      : undefined;
  const executor = new A2AExecutor({ host, version: "0.0.1", callerPolicy: policy });
  const store = new A2ATaskStore({
    host,
    isDriving: (taskId) => executor.isDriving(taskId),
    callerPolicy: policy,
  });
  const handler = new A2ARequestHandler(
    buildAgentCard({ url: "http://127.0.0.1:1/a2a", version: "0.0.1" }),
    store,
    executor,
  );
  return { host, executor, handler, stepAnswers };
}

const caller = () =>
  new ServerCallContext({ user: { isAuthenticated: true, userName: "default" } });

const dataPart = (value: Record<string, unknown>): Part => ({
  content: { $case: "data", value },
  mediaType: "",
  filename: "",
  metadata: {},
});
const wfPart = (name = "task", inputs?: Record<string, string>) =>
  dataPart({ "tentacle/workflow": { name, ...(inputs !== undefined ? { inputs } : {}) } });
const answerPart = (requestId: string, decision: "allow" | "deny") =>
  dataPart({ "tentacle/permission": { requestId, decision } });

function message(parts: Part[], contextId: string, taskId = ""): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts,
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}
const request = (parts: Part[], contextId: string, taskId = "") => ({
  tenant: "",
  message: message(parts, contextId, taskId),
  configuration: undefined,
  metadata: {},
});

function collect(stream: AsyncGenerator<StreamResponse, void, undefined>) {
  const events: StreamResponse[] = [];
  const done = (async () => {
    for await (const e of stream) events.push(e);
  })();
  return { events, done };
}
const states = (events: readonly StreamResponse[]) =>
  events.flatMap((e) =>
    e.payload?.$case === "statusUpdate" ? [e.payload.value.status?.state] : [],
  );
const statusTexts = (events: readonly StreamResponse[]) =>
  events.flatMap((e) =>
    e.payload?.$case === "statusUpdate" && e.payload.value.status?.message !== undefined
      ? e.payload.value.status.message.parts.map((p) =>
          p.content?.$case === "text" ? p.content.value : "",
        )
      : [],
  );
const taskIdOf = (events: readonly StreamResponse[]) => {
  const first = events[0]?.payload;
  return first?.$case === "task" ? first.value.id : "";
};
const askIdOf = (events: readonly StreamResponse[]) =>
  /^\[([^\]]+)\]/m.exec(statusTexts(events).at(-1) ?? "")?.[1] ?? "";
const artifactText = (task: Task) =>
  task.artifacts
    .flatMap((a) => a.parts)
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");
const statusText = (task: Task) =>
  (task.status?.message?.parts ?? [])
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");
const lastArtifact = (events: readonly StreamResponse[]) => {
  const arts = events.flatMap((e) =>
    e.payload?.$case === "artifactUpdate" ? [e.payload.value] : [],
  );
  const parts = arts.at(-1)?.artifact?.parts ?? [];
  return parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")).join("");
};

async function phone(host: SessionHost) {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const updates: KnownSessionUpdateParams[] = [];
  const peer = new RpcPeer(c, {
    onNotification: (method, params) => {
      if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
    },
    onRequest: async (method) => {
      throw new Error(`unexpected ${method}`);
    },
  });
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
    clientInfo: { name: "phone", version: "1", host: "iPhone" },
  });
  const asks = () =>
    updates
      .map((u) => u.update)
      .filter((u): u is PermissionRequestUpdate => u.type === "permission_request");
  return { peer, asks };
}

async function ownerAllows(host: SessionHost, sessionId: string) {
  const p = await phone(host);
  await p.peer.request("session/open", { sessionId });
  await until(() => p.asks().length >= 1);
  const ask = p.asks()[0];
  await p.peer.request("session/resolve_permission", {
    sessionId,
    requestId: ask?.requestId,
    optionId: ask?.options.find((o) => o.kind === "allow_once")?.optionId,
  });
}

describe("a2a workflow tasks (S8)", () => {
  // Mutation: ignore the switch (start whenever a workflow part is sent) → the
  // task COMPLETES and a session is opened → red.
  test("switch off: REJECTED with the reason, nothing opened, no run", async () => {
    const { host, handler } = rig({ workflows: false });
    const task = (await handler.sendMessage(request([wfPart()], "w0"), caller())) as Task;
    expect(task.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(statusText(task)).toBe(REFUSED.workflow);
    expect(host.get("a2a-default-w0")).toBeUndefined();
  });

  // Mutation: send the start without `turnId: taskId` → the run has no origin,
  // GetTask cannot find the task → red. Mutation: end the task from the row
  // (no ended unit) → the response artifact is empty → red.
  test("start → run → COMPLETED; the response is the run's result; GetTask and the phone agree", async () => {
    const { host, handler } = rig();
    const s = collect(handler.sendMessageStream(request([wfPart()], "w1"), caller()));
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(lastArtifact(s.events)).toContain("the plan");
    const taskId = taskIdOf(s.events);
    const stored = await handler.getTask({ tenant: "", id: taskId }, caller());
    expect(stored.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(stored)).toContain("the plan");
    const hosted = host.get("a2a-default-w1");
    const unit = hosted?.workUnits().find((u) => u.kind === "workflow");
    expect(unit).toMatchObject({ origin: taskId, state: "completed" });
    await until(() => hosted?.attachedCount === 0);
    const p = await phone(host);
    const list = (await p.peer.request("session/list", {})) as {
      sessions: { sessionId: string; title?: string }[];
    };
    expect(list.sessions[0]).toMatchObject({
      sessionId: "a2a-default-w1",
      title: "A2A: workflow task",
    });
  });

  // Mutation: map every refusal to REJECTED → the `inputs` refusal reads
  // REJECTED, not FAILED → red. Mutation: drop the daemon's reason → red.
  test("a refused start: bad inputs → FAILED with the daemon's reason; a missing file → FAILED", async () => {
    const { handler } = rig();
    const bad = (await handler.sendMessage(
      request([wfPart("task", { nope: "x" })], "w2"),
      caller(),
    )) as Task;
    expect(bad.status?.state).toBe(TaskState.TASK_STATE_FAILED);
    expect(statusText(bad)).not.toBe("");
    const none = (await handler.sendMessage(request([wfPart("nothere")], "w3"), caller())) as Task;
    expect([TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_REJECTED]).toContain(
      none.status?.state as TaskState,
    );
  });

  // Mutation: `running` mapped to FAILED → red. The first run is unaffected.
  test("a busy context (a run in flight): the second task is REJECTED; the first runs on", async () => {
    let release = () => {};
    const block = new Promise<void>((r) => {
      release = r;
    });
    const { handler } = rig({ block });
    const first = collect(handler.sendMessageStream(request([wfPart()], "w4"), caller()));
    await until(() => first.events.length > 0);
    const second = (await handler.sendMessage(request([wfPart()], "w4"), caller())) as Task;
    expect(second.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(statusText(second)).toBe(REFUSED.busy);
    release();
    await first.done;
    expect(states(first.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  // Mutation: CancelTask without the `stop` (or on a turn) → the run never
  // ends, the stream hangs → red.
  test("CancelTask stops the run → CANCELED", async () => {
    const { handler } = rig({ block: new Promise<void>(() => {}) });
    const s = collect(handler.sendMessageStream(request([wfPart()], "w5"), caller()));
    await until(() => s.events.length > 0);
    // The run exists once the start answered: wait for its first running row.
    const taskId = taskIdOf(s.events);
    // Cancel until the run is startable-to-stop (a cancel before its id is known is refused).
    let canceled: Task | undefined;
    await until(() => {
      void handler
        .cancelTask({ tenant: "", id: taskId, metadata: {} }, caller())
        .then((t) => {
          canceled = t;
        })
        .catch(() => {});
      return canceled !== undefined;
    });
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });

  // Mutation: `waiting:approval` read as INPUT_REQUIRED, or the caller's answer
  // admitted → red (the approval is the owner's, in `both` too).
  test("an unapproved file in `both`: WORKING + 'waiting for the owner to approve', never INPUT_REQUIRED; the owner approves → COMPLETED", async () => {
    const { host, handler } = rig({ asks: "both", unapproved: true });
    const s = collect(handler.sendMessageStream(request([wfPart()], "w6"), caller()));
    await until(() => statusTexts(s.events).some((t) => t.includes("approve the workflow")));
    expect(states(s.events)).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    await ownerAllows(host, "a2a-default-w6");
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  // Mutation: the run's ask not admitted (inTurn false for a run) → no
  // INPUT_REQUIRED → red. Mutation: answer with `allow_always` → red.
  test("`both`: a step's tool ask is INPUT_REQUIRED; the caller's allow answers it once → COMPLETED", async () => {
    const { handler, stepAnswers } = rig({ asks: "both", stepAsk: true });
    const s = collect(handler.sendMessageStream(request([wfPart()], "w7"), caller()));
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    const taskId = taskIdOf(s.events);
    const ask = askIdOf(s.events);
    const f = collect(
      handler.sendMessageStream(request([answerPart(ask, "allow")], "w7", taskId), caller()),
    );
    await f.done;
    expect(states(f.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(stepAnswers).toEqual([true]);
    expect(lastArtifact(f.events)).toContain("the plan");
  });

  // Mutation: the mode ignored for a run → INPUT_REQUIRED in `owner` → red.
  test("`owner`: a step's ask reads WORKING + 'waiting for the owner'; only the owner answers", async () => {
    const { host, handler, stepAnswers } = rig({ stepAsk: true });
    const s = collect(handler.sendMessageStream(request([wfPart()], "w8"), caller()));
    await until(() => statusTexts(s.events).some((t) => t.startsWith("waiting for the owner")));
    expect(states(s.events)).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    await ownerAllows(host, "a2a-default-w8");
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(stepAnswers).toEqual([true]);
  });
});
