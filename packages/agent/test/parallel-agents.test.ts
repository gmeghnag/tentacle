/**
 * A round's `agent_task` calls in their own lane (docs/feat/parallel-agents.md):
 * T-E (the executor), the read-only type, one store for the tree.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequester,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry, createTaskTool, fsReadTool, shellTool } from "@tentacle/tools";
import { z } from "zod";
import {
  Agent,
  type AgentConfig,
  type AgentEvent,
  type AgentType,
  BUILTIN_AGENT_TYPES,
  SessionGrants,
  createSubagentRunner,
} from "../src/index.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
  readFile() {
    throw new Error("unused");
  },
  writeFile() {
    throw new Error("unused");
  },
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !pred(); i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
  expect(pred()).toBe(true);
}

const spawn = (id: string, prompt: string, type = "worker"): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_task",
    arguments: JSON.stringify({ description: `task ${id}`, prompt, subagent_type: type }),
  },
});

const WORKER: AgentType = { name: "worker", description: "w", prompt: "work", tools: "all" };
const READER: AgentType = { name: "reader", description: "r", prompt: "read", tools: ["note"] };

/**
 * A model: the parent's first turn answers with `round`, its second ends. A
 * child (by its prompt) waits on the test's gate for that prompt, if any.
 */
class TreeModel implements ModelProvider {
  readonly id = "tree";
  readonly gates = new Map<string, Deferred<void>>();
  readonly started: string[] = [];
  readonly finished: string[] = [];
  readonly childScripts = new Map<string, readonly (readonly StreamEvent[])[]>();
  private parentTurn = 0;
  private readonly childTurn = new Map<string, number>();
  running = 0;
  peak = 0;

  constructor(private readonly round: readonly StreamEvent[]) {}

  gate(prompt: string): Deferred<void> {
    const made = deferred();
    this.gates.set(prompt, made);
    return made;
  }

  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const first = request.messages.find((m) => m.role === "user")?.content ?? "";
    if (first === "parent") {
      const events = this.parentTurn++ === 0 ? this.round : [{ type: "done" } as StreamEvent];
      for (const event of events) {
        yield event;
      }
      return;
    }
    const turn = this.childTurn.get(first) ?? 0;
    this.childTurn.set(first, turn + 1);
    const script = this.childScripts.get(first);
    if (script) {
      for (const event of script[turn] ?? [{ type: "done" } as StreamEvent]) {
        yield event;
      }
      return;
    }
    this.started.push(first);
    this.running++;
    this.peak = Math.max(this.peak, this.running);
    await (this.gates.get(first)?.promise ?? Promise.resolve());
    this.running--;
    this.finished.push(first);
    if (first === "boom") {
      throw new Error("child model down");
    }
    yield { type: "text", delta: `report of ${first}` };
    yield { type: "done" };
  }
}

function build(
  model: ModelProvider,
  subagentExecution: AgentConfig["subagentExecution"] | undefined,
  extra: {
    types?: readonly AgentType[];
    requester?: PermissionRequester;
    tools?: readonly Tool[];
    toolExecution?: AgentConfig["toolExecution"];
    grants?: SessionGrants;
  } = {},
) {
  const tools = new ToolRegistry();
  for (const tool of extra.tools ?? []) {
    tools.register(tool);
  }
  const { run, types, readOnlyType } = createSubagentRunner({
    model,
    env: noopEnv,
    tools,
    types: extra.types ?? [WORKER, READER],
    ...(extra.requester ? { requestPermission: extra.requester } : {}),
    ...(extra.grants ? { grants: extra.grants } : {}),
  });
  tools.register(createTaskTool((o, c) => run(o, c), types, { readOnlyType }));
  return new Agent({
    model,
    tools,
    env: noopEnv,
    now: () => 0,
    ...(subagentExecution ? { subagentExecution } : {}),
    ...(extra.toolExecution ? { toolExecution: extra.toolExecution } : {}),
    ...(extra.requester ? { requestPermission: extra.requester } : {}),
    ...(extra.grants ? { grants: extra.grants } : {}),
  });
}

async function drive(
  agent: Agent,
  options: {
    signal?: AbortSignal;
    beforeRun?: (ids: readonly string[], signal: AbortSignal) => Promise<boolean>;
    onEvent?: (event: AgentEvent) => void;
    messages?: ChatMessage[];
  } = {},
) {
  const messages: ChatMessage[] = options.messages ?? [{ role: "user", content: "parent" }];
  const events: AgentEvent[] = [];
  const controller = new AbortController();
  for await (const event of agent.runMessages(
    messages,
    "s",
    options.signal ?? controller.signal,
    undefined,
    options.beforeRun ? { beforeRun: options.beforeRun } : {},
  )) {
    events.push(event);
    options.onEvent?.(event);
  }
  return { messages, events };
}

/** "one" held open: "two" must not start beside it. */
async function expectOneAtATime(model: TreeModel, start: () => Promise<unknown>): Promise<void> {
  const first = model.gate("one");
  const running = start();
  await until(() => model.started.length >= 1);
  await new Promise((r) => setTimeout(r, 10));
  expect(model.started).toEqual(["one"]);
  first.resolve();
  await running;
  expect(model.peak).toBe(1);
  expect(model.started).toEqual(["one", "two"]);
}

const parallel = { mode: "parallel", maxParallel: 4 } as const;
const toolAnswers = (messages: readonly ChatMessage[]) =>
  messages.filter((m) => m.role === "tool").map((m) => m.toolCallId);

describe("the agents' lane (T-E)", () => {
  test("T-E1 two agent_task overlap", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    const one = model.gate("one");
    const two = model.gate("two");
    const running = drive(build(model, parallel));
    // Both children are in flight with neither released: only an overlap gets here.
    await until(() => model.started.length === 2);
    one.resolve();
    two.resolve();
    await running;
    expect(model.peak).toBe(2);
  });

  test("absent subagentExecution: one at a time, as an agent alone", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    await expectOneAtATime(model, () => drive(build(model, undefined)));
  });

  test("T-E2 results pushed in call order on reversed completion; ONE commit; beforeRun first, with all ids", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    const one = model.gate("one");
    const two = model.gate("two");
    const seenAtBeforeRun: number[] = [];
    let ids: readonly string[] = [];
    const land = deferred<boolean>();
    const running = drive(build(model, parallel), {
      beforeRun: async (asked) => {
        ids = asked;
        seenAtBeforeRun.push(model.started.length);
        return land.promise;
      },
    });
    await until(() => ids.length === 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(model.started).toEqual([]); // awaited before any child starts
    land.resolve(true);
    await until(() => model.started.length === 2);
    two.resolve();
    await until(() => model.finished.includes("two"));
    one.resolve();
    const { messages, events } = await running;
    expect(ids).toEqual(["c1", "c2"]);
    expect(seenAtBeforeRun).toEqual([0]);
    expect(toolAnswers(messages)).toEqual(["c1", "c2"]);
    const results = events.flatMap((e) => (e.type === "tool_result" ? [e.id] : []));
    expect(results).toEqual(["c2", "c1"]); // yielded as they complete
    // ONE commit for the group, after both results: never one between them.
    const firstResult = events.findIndex((e) => e.type === "tool_result");
    const commit = events.findIndex((e, i) => i > firstResult && e.type === "history_commit");
    expect(events.slice(firstResult, commit).filter((e) => e.type === "tool_result").length).toBe(
      2,
    );
    expect(events.slice(firstResult).filter((e) => e.type === "history_commit").length).toBe(1);
  });

  test("T-E3 cap 2, 3 agents: never 3 running; the third is queued, then running", async () => {
    const model = new TreeModel([
      spawn("c1", "one"),
      spawn("c2", "two"),
      spawn("c3", "three"),
      { type: "done" },
    ]);
    const one = model.gate("one");
    const two = model.gate("two");
    const three = model.gate("three");
    const phases: string[] = [];
    const running = drive(build(model, { mode: "parallel", maxParallel: 2 }), {
      onEvent: (e) => {
        if (e.type === "tool_phase") {
          phases.push(`${e.id}:${e.phase}`);
        }
      },
    });
    await until(() => model.started.length === 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(model.started).toEqual(["one", "two"]);
    expect(phases).toContain("c3:queued");
    expect(phases).not.toContain("c3:running");
    one.resolve();
    await until(() => model.started.length === 3);
    expect(phases).toContain("c3:running");
    two.resolve();
    three.resolve();
    await running;
    expect(model.peak).toBe(2);
  });

  test("T-E4 independent: tools sequential + agents parallel", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    const one = model.gate("one");
    const two = model.gate("two");
    const running = drive(
      build(model, parallel, { toolExecution: { mode: "sequential", maxParallel: 1 } }),
    );
    await until(() => model.started.length === 2);
    one.resolve();
    two.resolve();
    await running;
  });

  test("T-E4 independent: tools parallel + agents sequential", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    await expectOneAtATime(model, () =>
      drive(
        build(
          model,
          { mode: "sequential", maxParallel: 4 },
          {
            toolExecution: { mode: "parallel", maxParallel: 8 },
          },
        ),
      ),
    );
  });

  test("T-E4 read-only tools never put a read-only spawn with a read", async () => {
    const order: string[] = [];
    const note: Tool<{ path: string }> = {
      name: "note",
      description: "note",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      concurrency: () => [{ mode: "read", resource: "n" }],
      async execute() {
        order.push("read");
        return { content: "" };
      },
    };
    const model = new TreeModel([
      {
        type: "tool_call",
        toolCall: { id: "r", name: "note", arguments: JSON.stringify({ path: "a" }) },
      },
      spawn("c1", "one", "reader"),
      { type: "done" },
    ]);
    const phases: string[] = [];
    await drive(
      build(model, parallel, {
        tools: [note],
        toolExecution: { mode: "read-only", maxParallel: 8 },
      }),
      {
        onEvent: (e) => {
          if (e.type === "tool_phase") {
            phases.push(`${e.id}:${e.phase}`);
          }
        },
      },
    );
    // Alone, both of them: a group would say `queued` first.
    expect(phases.filter((p) => p.endsWith("queued"))).toEqual([]);
  });

  test("subagents read-only: writers run alone, read-only types overlap", async () => {
    const note: Tool<{ path: string }> = {
      name: "note",
      description: "note",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      concurrency: () => [{ mode: "read", resource: "n" }],
      async execute() {
        return { content: "" };
      },
    };
    const model = new TreeModel([
      spawn("c1", "one", "reader"),
      spawn("c2", "two", "reader"),
      spawn("c3", "three", "worker"),
      { type: "done" },
    ]);
    const one = model.gate("one");
    const two = model.gate("two");
    const running = drive(build(model, { mode: "read-only", maxParallel: 4 }, { tools: [note] }));
    await until(() => model.started.length === 2);
    expect(model.started).toEqual(["one", "two"]);
    one.resolve();
    two.resolve();
    await running;
    expect(model.started).toEqual(["one", "two", "three"]);
    expect(model.peak).toBe(2);
  });

  test("T-E5 one child fails: its tree closes, siblings finish, the turn goes on", async () => {
    const model = new TreeModel([spawn("c1", "boom"), spawn("c2", "two"), { type: "done" }]);
    const two = model.gate("two");
    const running = drive(build(model, parallel));
    await until(() => model.finished.includes("boom"));
    two.resolve();
    const { messages, events } = await running;
    const byId = new Map(
      events.flatMap((e) => (e.type === "tool_result" ? [[e.id, e.result] as const] : [])),
    );
    expect(byId.get("c1")?.isError).toBe(true);
    expect(byId.get("c2")?.isError).toBeFalsy();
    expect(byId.get("c2")?.content).toContain("report of two");
    expect(toolAnswers(messages)).toEqual(["c1", "c2"]);
    const ended = events.flatMap((e) => (e.type === "subagent_end" ? [e.stopReason] : []));
    expect(ended.sort()).toEqual(["end_turn", "error"]);
  });

  test("T-E5 Esc mid-group with an ask live: every id answered once, no start after the abort", async () => {
    const ask: Tool<{ path: string }> = {
      name: "ask",
      description: "ask",
      inputSchema: z.object({ path: z.string() }),
      permission: "ask",
      async execute() {
        return { content: "ran" };
      },
    };
    const model = new TreeModel([
      spawn("c1", "asks"),
      spawn("c2", "two"),
      spawn("c3", "queued"),
      { type: "done" },
    ]);
    model.childScripts.set("asks", [
      [
        {
          type: "tool_call",
          toolCall: { id: "x", name: "ask", arguments: JSON.stringify({ path: "a" }) },
        },
        { type: "done" },
      ],
    ]);
    const two = model.gate("two");
    const controller = new AbortController();
    const asks: string[] = [];
    const requester: PermissionRequester = async (_req, options) => {
      asks.push(options?.toolCallId ?? "?");
      // The daemon settles a live ask on the turn's abort.
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { allowed: false };
    };
    const running = drive(
      build(model, { mode: "parallel", maxParallel: 2 }, { tools: [ask], requester }),
      { signal: controller.signal },
    );
    await until(() => asks.length === 1 && model.started.includes("two"));
    expect(asks).toEqual(["c1"]); // attributed to the parent's call, never the child's
    controller.abort();
    two.resolve();
    const { messages } = await running;
    expect(toolAnswers(messages).sort()).toEqual(["c1", "c2", "c3"]);
    expect(model.started).not.toContain("queued");
  });

  test("a bad input is not a spawn: alone, answered by the registry", async () => {
    const model = new TreeModel([
      spawn("c1", "one"),
      { type: "tool_call", toolCall: { id: "bad", name: "agent_task", arguments: "{}" } },
      spawn("c2", "two"),
      { type: "done" },
    ]);
    const first = model.gate("one");
    const running = drive(build(model, parallel));
    await until(() => model.started.length >= 1);
    await new Promise((r) => setTimeout(r, 10));
    expect(model.started).toEqual(["one"]); // the bad call cut the run: two waits for it
    first.resolve();
    const { messages, events } = await running;
    expect(toolAnswers(messages)).toEqual(["c1", "bad", "c2"]);
    const bad = events.find((e) => e.type === "tool_result" && e.id === "bad");
    expect(bad?.type === "tool_result" && bad.result.isError).toBe(true);
    expect(model.peak).toBe(1);
  });
});

describe("the server's slots (T-S)", () => {
  test("slots lower the cap; slots = 1 runs every call alone", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    const phases: string[] = [];
    await expectOneAtATime(model, () =>
      drive(build(model, { ...parallel, slots: async () => 1 }), {
        onEvent: (e) => {
          if (e.type === "tool_phase") {
            phases.push(e.phase);
          }
        },
      }),
    );
    expect(phases).not.toContain("queued"); // today's path: no group
  });

  test("slots above the config: the config wins", async () => {
    const model = new TreeModel([
      spawn("c1", "one"),
      spawn("c2", "two"),
      spawn("c3", "three"),
      { type: "done" },
    ]);
    const one = model.gate("one");
    const two = model.gate("two");
    const three = model.gate("three");
    const running = drive(build(model, { mode: "parallel", maxParallel: 2, slots: async () => 9 }));
    await until(() => model.started.length === 2);
    await new Promise((r) => setTimeout(r, 0));
    expect(model.started.length).toBe(2);
    one.resolve();
    two.resolve();
    three.resolve();
    await running;
    expect(model.peak).toBe(2);
  });

  test("a failing or a garbage probe: the config's cap", async () => {
    for (const slots of [
      async () => {
        throw new Error("dead host");
      },
      async () => 0,
    ]) {
      const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
      const one = model.gate("one");
      const two = model.gate("two");
      const running = drive(build(model, { ...parallel, slots }));
      await until(() => model.started.length === 2);
      one.resolve();
      two.resolve();
      await running;
    }
  });

  test("the probe runs only on a fan-out (mutation: always → red)", async () => {
    let probed = 0;
    const slots = async () => {
      probed++;
      return 4;
    };
    const single = new TreeModel([spawn("c1", "one"), { type: "done" }]);
    await drive(build(single, { ...parallel, slots }));
    expect(probed).toBe(0);
    const sequential = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    await drive(build(sequential, { mode: "sequential", maxParallel: 4, slots }));
    expect(probed).toBe(0);
    const fan = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    await drive(build(fan, { ...parallel, slots }));
    expect(probed).toBe(1);
  });

  test("an abort during the probe: nothing starts, every call answered", async () => {
    const model = new TreeModel([spawn("c1", "one"), spawn("c2", "two"), { type: "done" }]);
    const controller = new AbortController();
    let probing = false;
    const running = drive(
      build(model, {
        ...parallel,
        slots: () => {
          probing = true;
          return new Promise(() => {}); // a hung tunnel
        },
      }),
      { signal: controller.signal },
    );
    await until(() => probing);
    controller.abort();
    const { messages } = await running;
    expect(model.started).toEqual([]);
    expect(toolAnswers(messages)).toEqual(["c1", "c2"]);
  });
});

describe("the read-only type", () => {
  const types: readonly AgentType[] = [
    WORKER,
    { name: "shelly", description: "", prompt: "", tools: ["fs_read", "shell"] },
    { name: "reads", description: "", prompt: "", tools: ["fs_read"] },
    { name: "mcp", description: "", prompt: "", tools: ["mcp__x__read"] },
    { name: "late", description: "", prompt: "", tools: ["later"] },
    { name: "nest", description: "", prompt: "", tools: ["fs_read", "agent_task"] },
  ];
  const hinted = (name: string, mode: "read" | "write"): Tool =>
    ({
      name,
      description: name,
      inputSchema: z.object({}),
      permission: "ask",
      concurrency: () => [{ mode, resource: `mcp:${name}` }],
      execute: async () => ({ content: "" }),
    }) as Tool;

  test("explore is read-only; general-purpose is not", () => {
    const tools = new ToolRegistry().register(fsReadTool).register(shellTool);
    const { readOnlyType } = createSubagentRunner({
      model: new TreeModel([]),
      env: noopEnv,
      tools,
    });
    expect(BUILTIN_AGENT_TYPES.map((t) => t.name)).toEqual(["general-purpose", "explore"]);
    expect(readOnlyType("explore")).toBe(true);
    expect(readOnlyType("general-purpose")).toBe(false);
    expect(readOnlyType("nobody")).toBe(false);
  });

  test('"all", a list with shell, a hinted MCP read, a late-registered write', () => {
    const tools = new ToolRegistry()
      .register(fsReadTool)
      .register(shellTool)
      .register(hinted("mcp__x__read", "read"));
    const { readOnlyType } = createSubagentRunner({
      model: new TreeModel([]),
      env: noopEnv,
      tools,
      types,
    });
    expect(readOnlyType("worker")).toBe(false);
    expect(readOnlyType("shelly")).toBe(false);
    expect(readOnlyType("reads")).toBe(true);
    expect(readOnlyType("mcp")).toBe(true);
    expect(readOnlyType("nest")).toBe(true); // a child never gets the spawn tool
    expect(readOnlyType("late")).toBe(true); // nothing registered, nothing it can write
    tools.register(hinted("later", "write"));
    expect(readOnlyType("late")).toBe(false); // asked live
  });

  test("a hook rewriting subagent_type to a writer: under read-only it waits", async () => {
    const note: Tool<{ path: string }> = {
      name: "note",
      description: "note",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      concurrency: () => [{ mode: "read", resource: "n" }],
      async execute() {
        return { content: "" };
      },
    };
    const model = new TreeModel([
      spawn("c1", "one", "reader"),
      spawn("c2", "two", "reader"),
      { type: "done" },
    ]);
    const one = model.gate("one");
    const hooks = {
      hasAny: (event: string) => event === "tool_call",
      forAgent() {
        return this;
      },
      notifyModelRequest() {},
      forgetModelRequestBaseline() {},
      needsProjectTrust: () => false,
      toolCall: async (call: { toolCallId: string; input: unknown }) => {
        const input = call.input as Record<string, unknown>;
        return {
          kind: "pass" as const,
          input: call.toolCallId === "c2" ? { ...input, subagent_type: "worker" } : input,
          modified: call.toolCallId === "c2",
          force: null,
        };
      },
    };
    const tools = new ToolRegistry().register(note);
    const { run, types, readOnlyType } = createSubagentRunner({
      model,
      env: noopEnv,
      tools,
      types: [WORKER, READER],
    });
    tools.register(createTaskTool((o, c) => run(o, c), types, { readOnlyType }));
    const agent = new Agent({
      model,
      tools,
      env: noopEnv,
      hooks: hooks as never,
      subagentExecution: { mode: "read-only", maxParallel: 4 },
    });
    const running = drive(agent);
    await until(() => model.started.includes("one"));
    await new Promise((r) => setTimeout(r, 5));
    expect(model.started).toEqual(["one"]); // two is a writer now: it waits
    one.resolve();
    await running;
    expect(model.peak).toBe(1);
  });
});

describe("one store for the tree (T-G, end to end)", () => {
  test('a child\'s "always" covers the parent and later children', async () => {
    const edit: Tool<{ path: string }> = {
      name: "edit",
      description: "edit",
      inputSchema: z.object({ path: z.string() }),
      permission: "ask",
      async execute() {
        return { content: "edited" };
      },
    };
    const editCall = (id: string): StreamEvent => ({
      type: "tool_call",
      toolCall: { id, name: "edit", arguments: JSON.stringify({ path: "a" }) },
    });
    const model = new TreeModel([spawn("c1", "first"), spawn("c2", "second"), { type: "done" }]);
    model.childScripts.set("first", [[editCall("e1"), { type: "done" }]]);
    model.childScripts.set("second", [[editCall("e2"), { type: "done" }]]);
    const asked: string[] = [];
    const requester: PermissionRequester = async (_req, options) => {
      asked.push(options?.toolCallId ?? "?");
      return { allowed: true, scope: "session" };
    };
    const grants = new SessionGrants();
    const agent = build(model, parallel, { tools: [edit], requester, grants });
    await drive(agent);
    expect(asked.length).toBe(1);
    // The parent's own call of the tool, now covered.
    const again = new TreeModel([editCall("p"), { type: "done" }]);
    const parent = new Agent({
      model: again,
      tools: new ToolRegistry().register(edit),
      env: noopEnv,
      requestPermission: requester,
      grants,
    });
    await drive(parent);
    expect(asked.length).toBe(1);
  });
});
