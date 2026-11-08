/**
 * Sub-agents' asks live inside a running group (docs/feat/parallel-agents.md,
 * the load-bearing assumption), against a real `SessionHost` + `SessionPersister`:
 * "pending on disk ⇒ never started" stays true and the cut cannot pass a live ask.
 */
import { describe, expect, test } from "bun:test";
import { Agent, SessionGrants, createSubagentRunner } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import type { KnownSessionUpdateParams, PermissionRequestUpdate } from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { z } from "zod";
import type { Attachment, HostedSession } from "../src/hosted-session.ts";
import {
  type DaemonSessionRecord,
  INTERRUPTED_NOTE,
  NOT_RUN_NOTE,
  SUBAGENT_INTERRUPTED_NOTE,
  reconcileOnReload,
} from "../src/persisted-session.ts";
import { SessionHost } from "../src/session-host.ts";
import type { LogWrite } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore, decodeFiles, filesOf } from "./support/daemon-store-spy.ts";

const CWD = "/tmp/parallel-agents-work";
const env = {} as ExecutionEnvironment;
const go = [{ type: "text" as const, text: "go" }];

/** The two-file store, decoded by the real decoders (`support/daemon-store-spy.ts`). */
class Store extends SpyDaemonStore {}

/** A store whose writes of an in-flight set fail (`beforeRun` → false); the rest land. */
class NoInFlightStore extends Store {
  override failIf = (unit: LogWrite): boolean =>
    (JSON.parse(unit.sidecar ?? "{}") as { turn?: { inFlight?: unknown } }).turn?.inFlight !==
    undefined;
}

const spawn = (id: string, prompt: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_task",
    arguments: JSON.stringify({ description: `task ${prompt}`, prompt }),
  },
});
const editCall: StreamEvent = {
  type: "tool_call",
  toolCall: { id: "e", name: "edit", arguments: JSON.stringify({ path: "a" }) },
};

/** The parent's scripted turns; a child by its prompt: `asks` edits, others wait on `gates`. */
class TreeModel implements ModelProvider {
  readonly id = "tree";
  readonly gates = new Map<string, PromiseWithResolvers<void>>();
  readonly started: string[] = [];
  parentCalls = 0;
  private readonly childCalls = new Map<string, number>();
  constructor(private readonly round: readonly StreamEvent[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const first = request.messages.find((m) => m.role === "user")?.content ?? "";
    if (first === "go") {
      const events = this.parentCalls++ === 0 ? this.round : [{ type: "done" } as StreamEvent];
      for (const event of events) {
        yield event;
      }
      return;
    }
    const turn = this.childCalls.get(first) ?? 0;
    this.childCalls.set(first, turn + 1);
    if (turn === 0) {
      this.started.push(first);
    }
    if (first.startsWith("asks") && turn === 0) {
      yield editCall;
      yield { type: "done" };
      return;
    }
    await this.gates.get(first)?.promise;
    yield { type: "text", delta: `report ${first}` };
    yield { type: "done" };
  }
}

function rig(model: TreeModel, store: Store = new Store(), maxParallel = 4) {
  const edits: string[] = [];
  const brokers: PermissionBroker[] = [];
  const errors: Error[] = [];
  const edit: Tool = {
    name: "edit",
    description: "edit",
    inputSchema: z.object({ path: z.string() }),
    permission: "ask",
    async execute() {
      edits.push("ran");
      return { content: "edited" };
    },
  };
  const host = new SessionHost({
    defaultCwd: CWD,
    persister: new SessionPersister({
      store,
      cwd: CWD,
      model: "m",
      onError: (e) => errors.push(e),
    }),
    createAgent: () => {
      const permissions = new PermissionBroker();
      brokers.push(permissions);
      const tools = new ToolRegistry().register(edit);
      const grants = new SessionGrants();
      const requestPermission = (
        req: Parameters<PermissionBroker["request"]>[0],
        options: Parameters<PermissionBroker["request"]>[1],
      ) => permissions.request(req, options);
      const { run, types } = createSubagentRunner({
        model,
        env,
        tools,
        requestPermission,
        grants,
        types: [{ name: "worker", description: "w", prompt: "work", tools: "all" }],
      });
      tools.register(createTaskTool((o, c) => run(o, c), types));
      const agent = new Agent({
        model,
        tools,
        env,
        requestPermission,
        grants,
        subagentExecution: { mode: "parallel", maxParallel },
      });
      return { agent, permissions };
    },
  });
  return { host, store, model, edits, brokers, errors };
}

function client() {
  const updates: KnownSessionUpdateParams[] = [];
  const attachment: Attachment = { send: (u) => updates.push(u) };
  const pending = (): PermissionRequestUpdate[] => {
    const resolved = new Set(
      updates.flatMap((u) => (u.update.type === "permission_resolved" ? [u.update.requestId] : [])),
    );
    return updates.flatMap((u) =>
      u.update.type === "permission_request" && !resolved.has(u.update.requestId) ? [u.update] : [],
    );
  };
  return {
    attachment,
    updates,
    get asks() {
      return pending();
    },
    allow(hosted: HostedSession, optionId = "allow_once"): void {
      const first = pending()[0];
      if (first) {
        hosted.resolvePermission(first.requestId, optionId);
      }
    },
  };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${String(cond)}`);
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

const reread = (record: DaemonSessionRecord | undefined): DaemonSessionRecord => {
  if (!record) {
    throw new Error("nothing durable");
  }
  return decodeFiles(record.id, filesOf(record));
};

const toolRows = (record: DaemonSessionRecord): string[] =>
  reconcileOnReload(record).messages.flatMap((m) =>
    m.role === "tool" ? [`${m.toolCallId}:${m.content}`] : [],
  );

describe("a sub-agent's ask during a group", () => {
  test("T-D1 inFlight + pending resumable:false on disk; a reload closes and re-runs nothing", async () => {
    // What keeps the entry non-resumable: `classifyPending` wants the origin AND the asking call
    // named as asked, and a child's ask names the child's tool, never `agent_task`. Mutation:
    // `origin: "call"` alone survives here; with `classifyPending`'s name check removed too → red.
    const model = new TreeModel([spawn("c1", "asks"), spawn("c2", "two"), { type: "done" }]);
    model.gates.set("two", Promise.withResolvers<void>());
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.includes("two"));
    await hosted.persisted();

    const record = reread(r.store.durable.get(hosted.id));
    expect(record.turn?.inFlight).toEqual(["c1", "c2"]);
    expect(record.turn?.pending?.map((p) => [p.toolCallId, p.resumable])).toEqual([["c1", false]]);

    const reconciled = reconcileOnReload(record);
    expect(reconciled.resume).toBeUndefined();
    expect(toolRows(record)).toEqual([`c1:${SUBAGENT_INTERRUPTED_NOTE}`, `c2:${INTERRUPTED_NOTE}`]);

    // A second daemon restores it: nothing re-runs, no model call, no new ask.
    const secondModel = new TreeModel([]);
    const second = rig(secondModel, r.store);
    const c2 = client();
    const restored = second.host.restore(record);
    restored.attach(c2.attachment);
    await new Promise((r2) => setTimeout(r2, 5));
    expect(restored.running).toBe(false);
    expect(secondModel.parentCalls).toBe(0);
    expect(secondModel.started).toEqual([]);
    expect(c2.asks).toEqual([]);
    expect(second.edits).toEqual([]);

    c.allow(hosted);
    model.gates.get("two")?.resolve();
    await until(() => !hosted.running);
  });

  test("a child waiting in the lane has no entry, and reads Interrupted", async () => {
    const model = new TreeModel([spawn("c1", "asks-1"), spawn("c2", "asks-2"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.length === 2);
    await new Promise((r2) => setTimeout(r2, 5));
    await hosted.persisted();
    expect(c.asks.length).toBe(1);
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.turn?.pending?.map((p) => p.toolCallId)).toEqual(["c1"]);
    expect(toolRows(record)).toEqual([`c1:${SUBAGENT_INTERRUPTED_NOTE}`, `c2:${INTERRUPTED_NOTE}`]);
    c.allow(hosted);
    await until(() => c.asks.length === 1);
    c.allow(hosted);
    await until(() => !hosted.running);
  });

  test("T-D2 beforeRun fails: children one at a time, a commit each", async () => {
    // Mutation: ignore the boolean (run phase 2 anyway) → c2 starts beside c1.
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    const one = Promise.withResolvers<void>();
    const two = Promise.withResolvers<void>();
    model.gates.set("one", one);
    model.gates.set("two", two);
    const r = rig(model, new NoInFlightStore());
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => model.started.includes("one"));
    await new Promise((r2) => setTimeout(r2, 5));
    expect(model.started).toEqual(["one"]);
    one.resolve();
    await until(() => model.started.includes("two"));
    await hosted.persisted();
    // c1's commit is durable while c2 runs; c2 is the only one that may have started.
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : []))).toEqual([
      "c1",
    ]);
    expect(r.errors.length).toBeGreaterThan(0);
    two.resolve();
    await until(() => !hosted.running);
  });

  test("T-D3 an ask live while a sibling finished: the cut has not moved; a fresh attach re-offers it, and its answer works", async () => {
    // Mutation: a commit per call in phase 2 → the record holds c2's answer, the replay loses the ask.
    const model = new TreeModel([spawn("c1", "asks"), spawn("c2", "two"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(
      () =>
        c.asks.length === 1 &&
        c.updates.some(
          (u) =>
            u.update.type === "tool_call_update" &&
            u.update.toolCallId === "c2" &&
            u.update.status !== "in_progress",
        ),
    );
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    // The sibling finished; nothing of the group is committed.
    expect(record.messages.filter((m) => m.role === "tool")).toEqual([]);
    expect(record.turn?.inFlight).toEqual(["c1", "c2"]);

    const late = client();
    hosted.attach(late.attachment);
    expect(late.asks.map((a) => a.toolCallId)).toEqual(["c1"]);
    late.allow(hosted);
    await until(() => !hosted.running);
    expect(r.edits).toEqual(["ran"]);
    const done = reread(r.store.durable.get(hosted.id));
    expect(done.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : []))).toEqual([
      "c1",
      "c2",
    ]);
  });

  test("T-D4 attribution: each ask names its own agent_task and its sub-agent; one broker", async () => {
    const model = new TreeModel([spawn("c1", "asks-1"), spawn("c2", "asks-2"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1);
    c.allow(hosted);
    await until(() =>
      c.updates.some((u) => u.update.type === "permission_request" && u.update.toolCallId === "c2"),
    );
    c.allow(hosted);
    await until(() => !hosted.running);
    const asks = c.updates.flatMap((u) =>
      u.update.type === "permission_request" ? [u.update] : [],
    );
    expect(asks.map((a) => [a.toolCallId, a.agent?.description])).toEqual([
      ["c1", "task asks-1"],
      ["c2", "task asks-2"],
    ]);
    expect(r.brokers.length).toBe(1);
    expect(r.edits).toEqual(["ran", "ran"]);
  });

  test("an always covers the waiter: one ask, both run", async () => {
    const model = new TreeModel([spawn("c1", "asks-1"), spawn("c2", "asks-2"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.length === 2);
    c.allow(hosted, "allow_always");
    await until(() => !hosted.running);
    expect(r.edits).toEqual(["ran", "ran"]);
    expect(c.updates.filter((u) => u.update.type === "permission_request").length).toBe(1);
  });

  test("a cancel with an ask live and a waiter in the lane: no more asks, every id answered once", async () => {
    const model = new TreeModel([spawn("c1", "asks-1"), spawn("c2", "asks-2"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.length === 2);
    hosted.cancel();
    await until(() => !hosted.running);
    expect(c.updates.filter((u) => u.update.type === "permission_request").length).toBe(1);
    expect(r.edits).toEqual([]);
    await hosted.persisted();
    const record = reread(r.store.durable.get(hosted.id));
    expect(record.messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : []))).toEqual([
      "c1",
      "c2",
    ]);
    expect(record.turn).toBeUndefined();
  });

  test('"no" to one child refuses only that call; the sibling is then asked and goes on', async () => {
    const model = new TreeModel([spawn("c1", "asks-1"), spawn("c2", "asks-2"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.length === 2);
    c.allow(hosted, "reject_once");
    await until(() => c.asks.length === 1);
    c.allow(hosted);
    await until(() => !hosted.running);
    expect(r.edits).toEqual(["ran"]);
  });

  test("the only client that could answer leaves: the live ask and the waiter are refused, the turn converges", async () => {
    const model = new TreeModel([spawn("c1", "asks-1"), spawn("c2", "asks-2"), { type: "done" }]);
    const r = rig(model);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.length === 2);
    hosted.attach({ send: () => {}, updates: [] }); // an older client: cannot show an ask
    hosted.detach(c.attachment);
    await until(() => !hosted.running);
    expect(r.edits).toEqual([]);
  });

  test("a call queued over the cap and never started: an honest Interrupted, nothing re-run", async () => {
    // The set is durable before any start: a queued one cannot be told from a
    // started one, conservative and decided (parallel-tools.md).
    const round = [spawn("c1", "asks"), spawn("c2", "two"), spawn("c3", "three")];
    const model = new TreeModel([...round, { type: "done" }]);
    model.gates.set("two", Promise.withResolvers<void>());
    const r = rig(model, new Store(), 2);
    const c = client();
    const { hosted } = r.host.open({ create: true }, c.attachment);
    hosted.prompt("T1", go);
    await until(() => c.asks.length === 1 && model.started.includes("two"));
    await hosted.persisted();
    expect(model.started).not.toContain("three");
    const record = reread(r.store.durable.get(hosted.id));
    expect(toolRows(record)).toEqual([
      `c1:${SUBAGENT_INTERRUPTED_NOTE}`,
      `c2:${INTERRUPTED_NOTE}`,
      `c3:${INTERRUPTED_NOTE}`,
    ]);
    expect(toolRows(record).join()).not.toContain(NOT_RUN_NOTE);
    hosted.cancel();
    model.gates.get("two")?.resolve();
    await until(() => !hosted.running);
  });
});
