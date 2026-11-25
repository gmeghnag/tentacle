/**
 * docs/feat/a2a.md slice S6: the SDK `TaskStore` is a PROJECTION of the
 * caller's sessions (`HostedSession.workUnits()`), never an A2A store. Real SDK
 * handler + real `SessionHost`/`Agent` with a scripted model; a "phone" is a
 * second `Connection`. Each test names its mutation (§9).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ListTasksRequest,
  type Message,
  type Part,
  Role,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import {
  RequestMalformedError,
  TaskNotCancelableError,
  TaskNotFoundError,
} from "@a2a-js/sdk/errors";
import { ServerCallContext, UnauthenticatedUser } from "@a2a-js/sdk/server";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
  type WorkUnit,
} from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { A2AExecutor, A2ARequestHandler } from "../src/a2a/executor.ts";
import { buildAgentCard } from "../src/a2a/mapping.ts";
import { A2ATaskStore, pageTasks, unitTask } from "../src/a2a/task-projection.ts";
import { Connection } from "../src/connection.ts";
import { type UnitSource, addressableUnits } from "../src/external/work-units.ts";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";

const CWD = "/tmp/a2a-projection";
const env = {} as ExecutionEnvironment;

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`until: timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

class Scripted implements ModelProvider {
  readonly id = "scripted";
  constructor(private readonly rounds: (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield* this.rounds.shift() ?? [{ type: "text", delta: "idle" }];
    yield { type: "done" };
  }
}

const say = (delta: string): StreamEvent => ({ type: "text", delta });
const call = (id: string, name: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: "{}" },
});

function rig(rounds: (readonly StreamEvent[])[], persistRoot?: string) {
  const model = new Scripted(rounds);
  const run: Tool = {
    name: "run",
    description: "run",
    inputSchema: z.object({}).passthrough(),
    permission: "ask",
    execute: async () => ({ content: "ok" }),
  };
  const persister =
    persistRoot === undefined
      ? undefined
      : new SessionPersister({
          store: new LogSessionStore(persistRoot),
          cwd: CWD,
          model: "m",
          onError: () => {},
        });
  const host = new SessionHost({
    defaultCwd: CWD,
    ...(persister !== undefined ? { persister } : {}),
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(run),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const executor = new A2AExecutor({ host, version: "0.0.1" });
  const store = new A2ATaskStore({ host, isDriving: (id) => executor.isDriving(id) });
  const handler = new A2ARequestHandler(
    buildAgentCard({ url: "http://127.0.0.1:1/a2a", version: "0.0.1" }),
    store,
    executor,
  );
  return { host, executor, store, handler, persister };
}

const caller = (userName = "default") =>
  new ServerCallContext({ user: { isAuthenticated: true, userName } });

function textPart(value: string): Part {
  return { content: { $case: "text", value }, mediaType: "text/plain", filename: "", metadata: {} };
}

function request(text: string, contextId: string) {
  const message: Message = {
    messageId: crypto.randomUUID(),
    contextId,
    taskId: "",
    role: Role.ROLE_USER,
    parts: [textPart(text)],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
  return { tenant: "", message, configuration: undefined, metadata: {} };
}

const artifactText = (task: Task) =>
  task.artifacts
    .flatMap((a) => a.parts)
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");
const statusText = (task: Task) =>
  (task.status?.message?.parts ?? [])
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");

const list = (params: Partial<ListTasksRequest> = {}): ListTasksRequest => ({
  tenant: "",
  contextId: "",
  pageToken: "",
  status: TaskState.TASK_STATE_UNSPECIFIED,
  statusTimestampAfter: undefined,
  ...params,
});

/** A phone on the same host; it opens (creating) and prompts on its own. */
async function phone(host: SessionHost) {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const asks: string[] = [];
  const peer = new RpcPeer(c, {
    onNotification: (method, params) => {
      const u = (params as { update?: { type?: string; requestId?: string } }).update;
      if (method === "session/update" && u?.type === "permission_request" && u.requestId) {
        asks.push(u.requestId);
      }
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
  return { peer, asks };
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("a2a TaskStore — a projection of the session, no A2A store", () => {
  // Mutation: `save` keeps terminal tasks (the in-memory store's rule) →
  // inFlightCount is 1 → red. Mutation: `load` reads only memory → TaskNotFound → red.
  test("ended: the terminal task leaves memory; GetTask reads it from the session", async () => {
    const { host, store, handler } = rig([[say("done: 42")]]);
    const sent = (await handler.sendMessage(request("hello", "ctx1"), caller())) as Task;
    expect(sent.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(store.inFlightCount()).toBe(0);

    const got = await handler.getTask({ tenant: "", id: sent.id }, caller());
    expect(got.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(got.contextId).toBe("ctx1");
    expect(artifactText(got)).toBe("done: 42");
    // It IS the session's unit (turnId = taskId), projected.
    const unit = host
      .get("a2a-default-ctx1")
      ?.workUnits()
      .find((u) => u.id === sent.id);
    expect(unit?.result).toBe("done: 42");
    // Deterministic: two reads of one unit are equal.
    expect(await handler.getTask({ tenant: "", id: sent.id }, caller())).toEqual(got);
  });

  // Mutation: `current()` ignores the in-flight copy → the running task loses
  // the history the SDK merged (the user's message) → red.
  test("running: the in-flight copy while the executor drives it; then the projection", async () => {
    const { host, store, handler } = rig([[call("c1", "run")], [say("ran")]]);
    const pending = handler.sendMessage(
      { ...request("go", "ctx2"), configuration: { returnImmediately: true } as never },
      caller(),
    );
    let taskId = "";
    await until(() => {
      const hosted = host.get("a2a-default-ctx2");
      const u = hosted?.workUnits().find((x) => x.state === "waiting");
      taskId = u?.id ?? "";
      return taskId !== "";
    });
    await until(() => store.inFlightCount() === 1);
    const running = await handler.getTask({ tenant: "", id: taskId }, caller());
    expect(running.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(statusText(running)).toStartWith("waiting for the owner's approval");
    expect(running.history.some((m) => m.role === Role.ROLE_USER)).toBe(true);
    // ListTasks reads the same in-flight copy (mutation: list ignores it → the
    // projection, with no history → red).
    const listed = (await handler.listTasks(list(), caller())).tasks;
    expect(listed.map((t) => t.id)).toEqual([taskId]);
    expect(listed[0]?.history.some((m) => m.role === Role.ROLE_USER)).toBe(true);

    // The owner answers from the phone; the task ends; memory empties.
    const p = await phone(host);
    await p.peer.request("session/open", { sessionId: "a2a-default-ctx2" });
    await until(() => p.asks.length === 1);
    await p.peer.request("session/resolve_permission", {
      sessionId: "a2a-default-ctx2",
      requestId: p.asks[0],
      optionId: "allow_once",
    });
    await pending;
    await until(() => store.inFlightCount() === 0);
    const ended = await handler.getTask({ tenant: "", id: taskId }, caller());
    expect(ended.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(ended)).toBe("ran");
  });

  // Mutation: `save` keeps terminal tasks → the SDK's own CANCELED (no bus)
  // is read back → cancelTask "succeeds" while the turn still waits → red.
  test("a unit this executor does not drive: GetTask projects it; CancelTask never fakes CANCELED", async () => {
    const { host, handler } = rig([[call("c1", "run")]]);
    const p = await phone(host);
    // The owner prompts in the caller's context from the phone: its unit is the caller's task too.
    await p.peer.request("session/open", { sessionId: "a2a-default-ctxP", create: true });
    await p.peer.request("session/prompt", {
      sessionId: "a2a-default-ctxP",
      turnId: "phone-t1",
      content: [{ type: "text", text: "hi" }],
    });
    await until(() => p.asks.length === 1);
    const got = await handler.getTask({ tenant: "", id: "phone-t1" }, caller());
    expect(got.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect(got.contextId).toBe("ctxP");
    expect(statusText(got)).toBe("waiting for the owner's approval");
    // No bus here: the SDK writes its own CANCELED, which the store does not keep
    // (terminal); the re-read is the session's (still waiting) → not cancelable.
    await expect(
      handler.cancelTask({ tenant: "", id: "phone-t1", metadata: {} }, caller()),
    ).rejects.toBeInstanceOf(TaskNotCancelableError);
    const unit = host
      .get("a2a-default-ctxP")
      ?.workUnits()
      .find((u) => u.id === "phone-t1");
    expect(unit?.state).toBe("waiting");
  });

  // Mutation: `contextIdOf` ignores the caller (any `a2a-*` session) → "other"
  // reads default's task → red. Mutation: `ownerOf` accepts an unauthenticated
  // user → red.
  test("owner scoping: another caller, an unauthenticated one, and a phone session see nothing", async () => {
    const { host, handler } = rig([[say("mine")], [say("phone's")]]);
    const mine = (await handler.sendMessage(request("x", "ctx3"), caller())) as Task;
    // A plain phone session's turn is never an A2A task.
    const p = await phone(host);
    const opened = (await p.peer.request("session/open", { create: true })) as {
      sessionId: string;
    };
    await p.peer.request("session/prompt", {
      sessionId: opened.sessionId,
      turnId: "phone-only",
      content: [{ type: "text", text: "hi" }],
    });
    await until(() => host.get(opened.sessionId)?.workUnits().length === 1);

    const other = caller("other");
    const anon = new ServerCallContext({ user: new UnauthenticatedUser() });
    for (const ctx of [other, anon]) {
      await expect(handler.getTask({ tenant: "", id: mine.id }, ctx)).rejects.toBeInstanceOf(
        TaskNotFoundError,
      );
      expect((await handler.listTasks(list(), ctx)).tasks).toEqual([]);
    }
    await expect(
      handler.getTask({ tenant: "", id: "phone-only" }, caller()),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    expect((await handler.listTasks(list(), caller())).tasks.map((t) => t.id)).toEqual([mine.id]);
  });

  // Mutation: `list` drops the contextId filter → ctxB's task listed for ctxA → red.
  test("ListTasks: per context, newest first, paged, artifacts only on request", async () => {
    const { handler } = rig([[say("a1")], [say("b1")], [say("a2")]]);
    const a1 = (await handler.sendMessage(request("1", "ctxA"), caller())) as Task;
    await new Promise((r) => setTimeout(r, 5)); // distinct end stamps (ms)
    const b1 = (await handler.sendMessage(request("2", "ctxB"), caller())) as Task;
    await new Promise((r) => setTimeout(r, 5));
    const a2 = (await handler.sendMessage(request("3", "ctxA"), caller())) as Task;

    const all = await handler.listTasks(list(), caller());
    expect(all.tasks.map((t) => t.id)).toEqual([a2.id, b1.id, a1.id]);
    expect(all.tasks.every((t) => t.artifacts.length === 0)).toBe(true);
    const ctxA = await handler.listTasks(list({ contextId: "ctxA" }), caller());
    expect(ctxA.tasks.map((t) => t.id)).toEqual([a2.id, a1.id]);

    const page1 = await handler.listTasks(list({ pageSize: 2, includeArtifacts: true }), caller());
    expect(page1.tasks.map((t) => t.id)).toEqual([a2.id, b1.id]);
    expect(page1.tasks.map(artifactText)).toEqual(["a2", "b1"]);
    expect(page1.totalSize).toBe(3);
    const page2 = await handler.listTasks(
      list({ pageSize: 2, pageToken: page1.nextPageToken }),
      caller(),
    );
    expect(page2.tasks.map((t) => t.id)).toEqual([a1.id]);
    expect(page2.nextPageToken).toBe("");
    const failed = await handler.listTasks(list({ status: TaskState.TASK_STATE_FAILED }), caller());
    expect(failed.tasks).toEqual([]);
  });

  // Mutation: the projection reads a cached copy instead of the host → the
  // deleted session's task is still found → red.
  test("deleted session → TaskNotFound; a refused (never-run) task is not retained", async () => {
    const { host, store, handler } = rig([[say("x")], [call("c1", "run")]]);
    const t = (await handler.sendMessage(request("x", "ctxD"), caller())) as Task;
    expect(host.delete("a2a-default-ctxD")).toBe(true);
    await expect(handler.getTask({ tenant: "", id: t.id }, caller())).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );

    // Busy context → REJECTED: it never became a unit, so nothing keeps it.
    void handler.sendMessage(
      { ...request("long", "ctxE"), configuration: { returnImmediately: true } as never },
      caller(),
    );
    await until(() => host.get("a2a-default-ctxE")?.workUnits()[0]?.state === "waiting");
    const busy = (await handler.sendMessage(request("again", "ctxE"), caller())) as Task;
    expect(busy.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    await expect(handler.getTask({ tenant: "", id: busy.id }, caller())).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    expect(store.inFlightCount()).toBe(1); // only the waiting task
  });

  // Mutation: the projection is built from the executor's memory (not
  // `workUnits()`) → a fresh process knows nothing → TaskNotFound → red.
  test("after a reload (a fresh store, the session restored from disk): same task; no A2A file anywhere", async () => {
    const root = await mkdtemp(join(tmpdir(), "a2a-proj-"));
    roots.push(root);
    const first = rig([[say("before restart")]], root);
    const t = (await first.handler.sendMessage(request("x", "ctxR"), caller())) as Task;
    const before = await first.handler.getTask({ tenant: "", id: t.id }, caller());
    await first.host.get("a2a-default-ctxR")?.persisted();
    await first.persister?.stop();

    const second = rig([], root);
    const loaded = await second.persister?.load("a2a-default-ctxR");
    if (loaded === undefined || !loaded.ok) throw new Error("reload failed");
    second.host.restore(loaded.record);
    const after = await second.handler.getTask({ tenant: "", id: t.id }, caller());
    expect(after.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(after)).toBe("before restart");
    expect(after).toEqual(before);
    await second.persister?.stop();

    // The session's own files only: no task file, no A2A index.
    const files = (await readdir(root, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile())
      .map((e) => e.name);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => !f.startsWith("a2a-default-ctxR."))).toEqual([]);
  });
});

describe("a2a TaskStore — pure rules", () => {
  const ctx = caller();
  const unit = (over: Partial<WorkUnit>): WorkUnit => ({
    kind: "turn",
    id: "t1",
    state: "completed",
    native: "end_turn",
    endedAt: 1000,
    ...over,
  });
  const source = (units: WorkUnit[]): UnitSource => ({
    values: () => [{ id: "a2a-default-c", workUnits: () => units }],
  });
  const working = (id: string): Task => ({
    id,
    contextId: "c",
    status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: "" },
    artifacts: [],
    history: [],
    metadata: {},
  });

  // Mutation: `current()` trusts the copy without `isDriving` → the stale
  // WORKING copy wins over the session's terminal unit → red.
  test("a copy the executor no longer drives yields to a terminal projection, and is forgotten", async () => {
    let driving = true;
    const store = new A2ATaskStore({ host: source([unit({})]), isDriving: () => driving });
    await store.save(working("t1"), ctx);
    expect((await store.load("t1", ctx))?.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    driving = false;
    expect((await store.load("t1", ctx))?.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(store.inFlightCount()).toBe(0);
  });

  // Mutation: drop the `!isTerminal(projected)` arm → an undriven copy of a
  // unit the session has not ended (or never had) is lost → red.
  test("an undriven copy stays while the session has no terminal reading", async () => {
    const store = new A2ATaskStore({
      host: source([unit({ state: "working", endedAt: undefined })]),
      isDriving: () => false,
    });
    await store.save(working("t1"), ctx);
    await store.save(working("t9"), ctx);
    expect((await store.load("t1", ctx))?.status?.state).toBe(TaskState.TASK_STATE_WORKING);
    expect((await store.load("t9", ctx))?.id).toBe("t9");
    expect(store.inFlightCount()).toBe(2);
    // A terminal save removes it; an unauthenticated save keeps nothing.
    await store.save(
      {
        ...working("t9"),
        status: { state: TaskState.TASK_STATE_FAILED, message: undefined, timestamp: "" },
      },
      ctx,
    );
    await store.save(working("t5"), new ServerCallContext({ user: new UnauthenticatedUser() }));
    expect(store.inFlightCount()).toBe(1);
  });

  // Mutation: the workflow arm overrides a turn of the same id → red.
  test("addressing: a turn by its id; a run by its origin unless a turn of that id exists", () => {
    const byId = addressableUnits([
      unit({ id: "t1" }),
      unit({ kind: "workflow", id: "wf-1", origin: "t1" }),
      unit({ kind: "workflow", id: "wf-2", origin: "t2" }),
      unit({ kind: "workflow", id: "wf-3" }),
      // an owner's re-run that inherited wf-2's origin: wf-2 keeps the task (R1 finding 3)
      unit({ kind: "workflow", id: "wf-4", origin: "t2", state: "working", endedAt: undefined }),
    ]);
    expect([...byId.entries()].map(([k, u]) => `${k}=${u.id}`)).toEqual(["t1=t1", "t2=wf-2"]);
  });

  test("a unit's task: result as the response artifact, dropped result as a note, stamp from its end", () => {
    const cu = { taskId: "t1", contextId: "c", sessionId: "a2a-default-c" };
    const done = unitTask({ ...cu, unit: unit({ result: "r" }) }, "owner", 5);
    expect(artifactText(done)).toBe("r");
    expect(done.status?.timestamp).toBe(new Date(1000).toISOString());
    const dropped = unitTask({ ...cu, unit: unit({ resultDropped: true }) }, "owner", 5);
    expect(dropped.artifacts).toEqual([]);
    expect(statusText(dropped)).toBe("result no longer retained");
    const live = unitTask(
      { ...cu, unit: unit({ state: "working", endedAt: undefined }) },
      "both",
      5,
    );
    expect(live.status?.timestamp).toBe(new Date(5).toISOString());
  });

  test("a malformed page token is refused", () => {
    expect(() =>
      pageTasks([], { tenant: "", contextId: "", pageToken: "bm9iYXI=" } as never),
    ).toThrow(RequestMalformedError);
  });
});
