/**
 * docs/feat/a2a.md slice S4: the A2A executor drives a TURN on the single
 * session path (AGENTS §7). Real SDK handler (`A2ARequestHandler`) + real
 * `SessionHost`/`Agent` with a scripted model; a "phone" is a second
 * `Connection` over `createChannelPair`, as a socket would be. Each test names
 * its mutation (§9).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  type Part,
  Role,
  type StreamResponse,
  type Task,
  TaskState,
} from "@a2a-js/sdk";
import { UnsupportedOperationError } from "@a2a-js/sdk/errors";
import { InMemoryTaskStore, ServerCallContext, UnauthenticatedUser } from "@a2a-js/sdk/server";
import { Agent, type HookRunner } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { A2AExecutor, A2ARequestHandler, REFUSED, adapterRequest } from "../src/a2a/executor.ts";
import { buildAgentCard } from "../src/a2a/mapping.ts";
import { Connection, type HooksTrustPrecheck } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";

const CWD = "/tmp/a2a-executor";
const env = {} as ExecutionEnvironment;

/** Throws on a timeout, so an ignored wait never passes vacuously (§9). */
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`until: timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

type Round = readonly StreamEvent[] | "hang";

/** One script shared by every session of a rig: each model call takes the next round. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  /** The user messages each model call saw. */
  readonly users: number[] = [];
  constructor(private readonly rounds: Round[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.users.push(request.messages.filter((m) => m.role === "user").length);
    const round = this.rounds.shift() ?? [{ type: "text", delta: "idle" }];
    if (round === "hang") {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve());
      });
    } else {
      yield* round;
    }
    yield { type: "done" };
  }
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const call = (id: string, name: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: "{}" },
});

interface RigOptions {
  readonly rounds: Round[];
  readonly persistRoot?: string;
  readonly hooks?: HookRunner;
  readonly hooksTrustPrecheck?: HooksTrustPrecheck;
}

function rig(opts: RigOptions) {
  const model = new Scripted(opts.rounds);
  const tool = (name: string, permission: "ask" | "none"): Tool => ({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permission,
    execute: async () => ({ content: "ok" }),
  });
  const persister =
    opts.persistRoot === undefined
      ? undefined
      : new SessionPersister({
          store: new LogSessionStore(opts.persistRoot),
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
        tools: new ToolRegistry().register(tool("run", "ask")).register(tool("note", "none")),
        env,
        ...(opts.hooks !== undefined ? { hooks: opts.hooks } : {}),
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const executor = new A2AExecutor({
    host,
    version: "0.0.1",
    ...(opts.hooksTrustPrecheck !== undefined
      ? { hooksTrustPrecheck: opts.hooksTrustPrecheck }
      : {}),
  });
  const handler = new A2ARequestHandler(
    buildAgentCard({ url: "http://127.0.0.1:1/a2a", version: "0.0.1" }),
    new InMemoryTaskStore(),
    executor,
  );
  return { host, executor, handler, model };
}

const caller = (userName = "default") =>
  new ServerCallContext({ user: { isAuthenticated: true, userName } });

function textPart(value: string): Part {
  return { content: { $case: "text", value }, mediaType: "text/plain", filename: "", metadata: {} };
}

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

function request(parts: Part[], contextId: string, taskId = "") {
  return {
    tenant: "",
    message: message(parts, contextId, taskId),
    configuration: undefined,
    metadata: {},
  };
}

/** Run a stream in the background, collecting its events. */
function collect(stream: AsyncGenerator<StreamResponse, void, undefined>) {
  const events: StreamResponse[] = [];
  let closed = false;
  const done = (async () => {
    for await (const e of stream) events.push(e);
    closed = true;
  })();
  return { events, done, closed: () => closed };
}

const kinds = (events: readonly StreamResponse[]) => events.map((e) => e.payload?.$case);
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
const artifactText = (task: Task) =>
  task.artifacts
    .flatMap((a) => a.parts)
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");
const statusText = (task: Task) =>
  (task.status?.message?.parts ?? [])
    .map((p) => (p.content?.$case === "text" ? p.content.value : ""))
    .join("");

/** A phone: a second client on the same host, exactly as a socket would be. */
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
  return { peer, updates, asks };
}

const roots: string[] = [];
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe("a2a executor — turn tasks on the single session path", () => {
  // Mutation: publish deltas with append always true (no round replace) → the
  // first chunk after the tool call is append:true and the stored artifact
  // keeps "thinking " → red.
  test("stream: task first, deltas, the FINAL round replaces, COMPLETED; the session is the phone's too", async () => {
    const { host, handler } = rig({
      rounds: [
        [text("thinking "), call("c1", "note")],
        [text("done: "), text("42")],
      ],
    });
    const s = collect(handler.sendMessageStream(request([textPart("hello")], "ctx1"), caller()));
    await s.done;
    expect(kinds(s.events)[0]).toBe("task");
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    const arts = s.events.flatMap((e) =>
      e.payload?.$case === "artifactUpdate" ? [e.payload.value] : [],
    );
    const firstAfterTool = arts.find((a) =>
      a.artifact?.parts.some((p) => p.content?.$case === "text" && p.content.value === "done: "),
    );
    expect(firstAfterTool?.append).toBe(false);
    const last = arts.at(-1);
    expect(last?.lastChunk).toBe(true);
    expect(last?.append).toBe(false);
    expect(
      last?.artifact?.parts.map((p) => (p.content?.$case === "text" ? p.content.value : "")),
    ).toEqual(["done: 42"]);

    const first = s.events[0]?.payload;
    const taskId = first?.$case === "task" ? first.value.id : "";
    const stored = await handler.getTask({ tenant: "", id: taskId }, caller());
    expect(artifactText(stored)).toBe("done: 42");

    // One session path: the phone lists it, and its unit IS the task (turnId = taskId).
    const p = await phone(host);
    const list = (await p.peer.request("session/list", {})) as {
      sessions: { sessionId: string; title?: string }[];
    };
    expect(list.sessions.map((x) => x.sessionId)).toEqual(["a2a-default-ctx1"]);
    expect(list.sessions[0]?.title).toBe("A2A: hello");
    const unit = host
      .get("a2a-default-ctx1")
      ?.workUnits()
      .find((u) => u.id === taskId);
    expect(unit?.state).toBe("completed");
    expect(unit?.result).toBe("done: 42");
  });

  // Mutation: no `session/detach` at the end → attachedCount stays 1 → red.
  test("detach: after the end the adapter is no longer attached; the session lives on", async () => {
    const { host, handler } = rig({ rounds: [[text("hi")]] });
    const task = (await handler.sendMessage(request([textPart("x")], "ctx2"), caller())) as Task;
    expect(task.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const hosted = host.get("a2a-default-ctx2");
    await until(() => hosted?.attachedCount === 0);
    expect(host.get("a2a-default-ctx2")).toBeDefined();
  });

  // Mutation: declare `updates` without `permission_request` → the host denies
  // the ask at once, no waiting status, the phone has nothing to answer → red.
  // Mutation: the adapter resolves the ask itself → the phone's answer is
  // `PermissionNotPending` → red.
  test("owner mode: an ask reads WORKING + 'waiting for the owner', is not auto-denied, and only the phone answers", async () => {
    const { host, handler } = rig({ rounds: [[call("c1", "run")], [text("ran")]] });
    const s = collect(handler.sendMessageStream(request([textPart("do it")], "ctx3"), caller()));
    await until(() =>
      statusTexts(s.events).some((t) => t.startsWith("waiting for the owner's approval")),
    );
    expect(states(s.events)).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    const unit = host
      .get("a2a-default-ctx3")
      ?.workUnits()
      .find((u) => u.kind === "turn");
    expect(unit?.state).toBe("waiting");

    const p = await phone(host);
    await p.peer.request("session/open", { sessionId: "a2a-default-ctx3" });
    await until(() => p.asks().length === 1);
    const ask = p.asks()[0];
    // Raised while only the adapter was attached, and it named no `host`: the
    // phone is never told "also asked on A2A" (mutation: send a host → red).
    expect(ask?.askedOn).toBeUndefined();
    await p.peer.request("session/resolve_permission", {
      sessionId: "a2a-default-ctx3",
      requestId: ask?.requestId,
      optionId: ask?.options.find((o) => o.kind === "allow_once")?.optionId,
    });
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    // Back to plain WORKING once answered, before the end.
    expect(
      states(s.events).filter((x) => x === TaskState.TASK_STATE_WORKING).length,
    ).toBeGreaterThanOrEqual(2);
  });

  // Mutation: cancelTask sends `session/cancel` without the turnId, or nothing → red
  // (nothing: the turn never ends; no turnId: still green — pinned by the busy test's
  // "first unit unaffected" instead).
  test("CancelTask: the turn is cancelled → CANCELED, from the turn's own end", async () => {
    const { host, handler } = rig({ rounds: ["hang"] });
    const s = collect(handler.sendMessageStream(request([textPart("wait")], "ctx4"), caller()));
    await until(() => s.events.length > 0);
    const first = s.events[0]?.payload;
    const taskId = first?.$case === "task" ? first.value.id : "";
    await until(
      () =>
        host
          .get("a2a-default-ctx4")
          ?.workUnits()
          .some((u) => u.state === "working") === true,
    );
    const canceled = await handler.cancelTask({ tenant: "", id: taskId, metadata: {} }, caller());
    expect(canceled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
    const unit = host
      .get("a2a-default-ctx4")
      ?.workUnits()
      .find((u) => u.id === taskId);
    expect(unit?.state).toBe("canceled");
  });

  // Mutation: the phone's `session/cancel` not reflected (status from the
  // update's stopReason ignored) → red.
  test("the owner's cancel from the phone ends the task CANCELED too", async () => {
    const { host, handler } = rig({ rounds: ["hang"] });
    const s = collect(handler.sendMessageStream(request([textPart("wait")], "ctx5"), caller()));
    await until(
      () =>
        host
          .get("a2a-default-ctx5")
          ?.workUnits()
          .some((u) => u.state === "working") === true,
    );
    const p = await phone(host);
    await p.peer.request("session/open", { sessionId: "a2a-default-ctx5" });
    p.peer.notify("session/cancel", { sessionId: "a2a-default-ctx5" });
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });

  // Mutation: map TurnInProgress to FAILED / let the error throw (SDK FAILED) → red.
  test("busy context: a second task is REJECTED, the first runs on unaffected", async () => {
    const { host, handler } = rig({ rounds: ["hang"] });
    const a = collect(handler.sendMessageStream(request([textPart("one")], "ctx6"), caller()));
    await until(
      () =>
        host
          .get("a2a-default-ctx6")
          ?.workUnits()
          .some((u) => u.state === "working") === true,
    );
    const b = (await handler.sendMessage(request([textPart("two")], "ctx6"), caller())) as Task;
    expect(b.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
    expect(statusText(b)).toBe(REFUSED.busy);
    // The first is still running, then cancels cleanly under ITS id.
    expect(a.closed()).toBe(false);
    const first = a.events[0]?.payload;
    const taskId = first?.$case === "task" ? first.value.id : "";
    await handler.cancelTask({ tenant: "", id: taskId, metadata: {} }, caller());
    await a.done;
    expect(states(a.events).at(-1)).toBe(TaskState.TASK_STATE_CANCELED);
  });

  // Mutation: answer `hooks/trust` with `{trusted:true}` → red. Mutation: drop
  // the precheck pass-through → the "trusted on this host" case asks the
  // adapter and reads false → red.
  test("hooks: the adapter says NO; the host's own trust still decides first", async () => {
    expect(adapterRequest("hooks/trust")).toEqual({ trusted: false });
    expect(() => adapterRequest("model/stream")).toThrow();

    const answers: boolean[] = [];
    let asked = false;
    const hooks = new Proxy(
      {
        needsProjectTrust: () => !asked,
        resolveProjectTrust: async (
          sessionId: string,
          ask: ((r: unknown) => Promise<boolean>) | undefined,
        ) => {
          asked = true;
          answers.push(
            (await ask?.({
              sessionId,
              folder: CWD,
              hash: "h",
              files: [],
              hooks: [{ event: "turn_start", command: "true" }],
              canAllow: true,
            })) ?? true,
          );
        },
      } as Record<string, unknown>,
      { get: (t, k) => (k in t ? t[k as string] : () => undefined) },
    ) as unknown as HookRunner;
    const untrusted = rig({ rounds: [[text("a")]], hooks });
    await untrusted.handler.sendMessage(request([textPart("x")], "ctx7"), caller());
    expect(answers).toEqual([false]);

    asked = false;
    const trusted = rig({ rounds: [[text("b")]], hooks, hooksTrustPrecheck: () => "trusted" });
    await trusted.handler.sendMessage(request([textPart("y")], "ctx8"), caller());
    expect(answers).toEqual([false, true]);
  });

  // Mutation: drop the `reopen:true` on open → `SessionArchived` → FAILED → red.
  test("reopen: a NEW task on an archived context reloads it and runs", async () => {
    const root = await mkdtemp(join(tmpdir(), "a2a-exec-"));
    roots.push(root);
    const { host, handler, model } = rig({
      rounds: [[text("first")], [text("second")]],
      persistRoot: root,
    });
    const one = (await handler.sendMessage(request([textPart("1")], "ctx9"), caller())) as Task;
    expect(one.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    await until(() => host.get("a2a-default-ctx9")?.attachedCount === 0);
    expect(host.close("a2a-default-ctx9")).toBe(true);
    expect(host.get("a2a-default-ctx9")).toBeUndefined();
    const two = (await handler.sendMessage(request([textPart("2")], "ctx9"), caller())) as Task;
    expect(two.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(artifactText(two)).toBe("second");
    // The SAME conversation reloaded, not a fresh one: the model's second call
    // carries the first exchange (mutation: open a fresh session → red).
    expect(model.users).toEqual([1, 2]);
    expect(host.get("a2a-default-ctx9")?.workUnits().at(-1)?.id).toBe(two.id);
  });

  // Mutation: let any one of these through → a session is opened / a task runs → red.
  test("refusals are REJECTED tasks and open nothing", async () => {
    const { host, handler } = rig({ rounds: [] });
    const send = async (parts: Part[], ctx: string, who = caller()) =>
      (await handler.sendMessage(request(parts, ctx), who)) as Task;
    const raw: Part = {
      content: { $case: "url", value: "http://x" },
      mediaType: "",
      filename: "",
      metadata: {},
    };
    const wf: Part = {
      content: { $case: "data", value: { "tentacle/workflow": { name: "w" } } },
      mediaType: "",
      filename: "",
      metadata: {},
    };
    const ans: Part = {
      content: {
        $case: "data",
        value: { "tentacle/permission": { requestId: "r", decision: "allow" } },
      },
      mediaType: "",
      filename: "",
      metadata: {},
    };
    const cases: [Task, string][] = [
      [await send([raw], "c"), REFUSED.unsupportedPart],
      [await send([wf], "c"), REFUSED.workflow],
      [await send([ans], "c"), REFUSED.answer],
      [await send([textPart("x")], "bad/ctx"), REFUSED.badIds],
      [await send([textPart("x")], "c", new ServerCallContext()), REFUSED.unauthenticated],
      [
        await send(
          [textPart("x")],
          "c",
          new ServerCallContext({ user: new UnauthenticatedUser() }),
        ),
        REFUSED.unauthenticated,
      ],
      [
        await send(
          [textPart("x")],
          "c",
          new ServerCallContext({ user: { isAuthenticated: false, userName: "default" } }),
        ),
        REFUSED.unauthenticated,
      ],
      [await send([textPart("x")], "c", caller("has-dash")), REFUSED.badIds],
    ];
    for (const [task, reason] of cases) {
      expect(task.status?.state).toBe(TaskState.TASK_STATE_REJECTED);
      expect(statusText(task)).toBe(reason);
    }
    const p = await phone(host);
    const list = (await p.peer.request("session/list", {})) as { sessions: unknown[] };
    expect(list.sessions).toEqual([]);
  });

  // Mutation: `refuseFollowUp` lets it through → the SDK runs a second
  // `execute` on the shared bus and the follow-up neither throws −32004 nor
  // leaves the running stream intact → red.
  test("follow-up on a running task (owner mode): refused before execute (−32004); the task runs to its end", async () => {
    const { host, handler, executor } = rig({ rounds: [[call("c1", "run")], [text("ok")]] });
    const s = collect(handler.sendMessageStream(request([textPart("go")], "ctx10"), caller()));
    await until(() => statusTexts(s.events).some((t) => t.startsWith("waiting for the owner")));
    const first = s.events[0]?.payload;
    const taskId = first?.$case === "task" ? first.value.id : "";
    const follow = (stream: boolean) =>
      stream
        ? collect(
            handler.sendMessageStream(request([textPart("allow")], "ctx10", taskId), caller()),
          ).done
        : handler.sendMessage(request([textPart("allow")], "ctx10", taskId), caller());
    for (const stream of [false, true]) {
      const refused = await follow(stream).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(refused).toBeInstanceOf(UnsupportedOperationError);
      expect((refused as Error).message).toBe(REFUSED.running);
    }
    expect(s.closed()).toBe(false);
    expect(executor.liveTaskIds()).toEqual([taskId]);
    // The caller's "allow" answered nothing: the ask is still the owner's.
    expect(host.get("a2a-default-ctx10")?.workUnits().at(-1)?.state).toBe("waiting");
    const p = await phone(host);
    await p.peer.request("session/open", { sessionId: "a2a-default-ctx10" });
    await until(() => p.asks().length === 1);
    const ask = p.asks()[0];
    await p.peer.request("session/resolve_permission", {
      sessionId: "a2a-default-ctx10",
      requestId: ask?.requestId,
      optionId: ask?.options.find((o) => o.kind === "allow_once")?.optionId,
    });
    await s.done;
    expect(states(s.events).at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(executor.liveTaskIds()).toEqual([]);
    // Ended: a follow-up now meets the SDK's own terminal-task refusal.
    await expect(follow(false)).rejects.toThrow("terminal state");
  });

  test("cancel of a task this executor does not run → TaskNotCancelable", async () => {
    const { executor } = rig({ rounds: [] });
    await expect(executor.cancelTask("nope", undefined as never)).rejects.toThrow("not running");
  });
});
