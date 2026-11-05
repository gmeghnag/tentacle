/**
 * The round executor (docs/feat/parallel-tools.md): the sequential golden
 * (T-S1) and the grouped executor's behaviour.
 */
import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequester,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/index.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

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

function call(id: string, name: string, path: string): StreamEvent {
  return { type: "tool_call", toolCall: { id, name, arguments: JSON.stringify({ path }) } };
}

describe("round executor — sequential golden (T-S1)", () => {
  test("a mixed round: read, denied ask, edit, cancel-after-abort", async () => {
    const controller = new AbortController();
    const ran: string[] = [];
    const read: Tool<{ path: string }> = {
      name: "read",
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      async execute(input) {
        ran.push(`read ${input.path}`);
        return { content: `content of ${input.path}` };
      },
    };
    const edit: Tool<{ path: string }> = {
      name: "edit",
      description: "edit",
      inputSchema: z.object({ path: z.string() }),
      permission: "ask",
      async execute(input) {
        ran.push(`edit ${input.path}`);
        // The user cancels while the edit runs: the next call never starts.
        controller.abort();
        return { content: `edited ${input.path}` };
      },
    };
    const asked: string[] = [];
    const requester: PermissionRequester = async (req, options) => {
      asked.push(`${req.tool} ${options?.toolCallId ?? "?"} ${options?.groupStart ?? "-"}`);
      return { allowed: asked.length > 1 };
    };
    const model = new ScriptedProvider([
      [
        call("c1", "read", "a.ts"),
        call("c2", "edit", "b.ts"),
        call("c3", "edit", "c.ts"),
        call("c4", "read", "d.ts"),
        { type: "done" },
      ],
    ]);
    const agent = new Agent({
      model,
      tools: new ToolRegistry().register(read).register(edit),
      env: noopEnv,
      now: () => 0,
      requestPermission: requester,
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events: AgentEvent[] = [];
    for await (const event of agent.runMessages(messages, "s1", controller.signal)) {
      events.push(event);
    }

    expect(ran).toEqual(["read a.ts", "edit c.ts"]);
    expect(asked).toEqual(["edit c2 -", "edit c3 -"]);
    expect(events.map((e) => (e.type === "tool_result" ? `${e.type} ${e.id}` : e.type))).toEqual([
      "history_commit",
      "tool_start",
      "tool_phase",
      "tool_result c1",
      "history_commit",
      "tool_start",
      "tool_result c2",
      "history_commit",
      "tool_start",
      "tool_phase",
      "tool_result c3",
      "history_commit",
      "tool_result c4",
      "history_commit",
      "turn_end",
    ]);
    expect(messages.slice(2)).toEqual([
      { role: "tool", content: "content of a.ts", toolCallId: "c1", durationMs: 0 },
      {
        role: "tool",
        content: expect.stringContaining("denied") as unknown as string,
        toolCallId: "c2",
      },
      { role: "tool", content: "edited c.ts", toolCallId: "c3", durationMs: 0 },
      {
        role: "tool",
        content: "Cancelled by the user before this tool ran.",
        toolCallId: "c4",
      },
    ]);
  });
});

// ---------------------------------------------------------------- the executor

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

/** Yield to the event loop until `pred` holds (fails after ~200 turns). */
async function until(pred: () => boolean, what = "condition"): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * A lab of path tools whose runs block on a per-call gate the test releases:
 * `read` (read key), `write` (write key), `ask_read` (read key, asks).
 */
function lab(opts: { readonly requester?: PermissionRequester } = {}) {
  const log: string[] = [];
  const gates = new Map<string, Deferred<void>>();
  const gateOf = (path: string): Deferred<void> => {
    let g = gates.get(path);
    if (!g) {
      g = deferred();
      gates.set(path, g);
    }
    return g;
  };
  let live = 0;
  let maxLive = 0;
  const mk = (
    name: string,
    mode: "read" | "write",
    permission: "none" | "ask",
  ): Tool<{ path: string }> => ({
    name,
    description: name,
    inputSchema: z.object({ path: z.string() }),
    permission,
    concurrency: (input) => {
      const path = (input as { path?: unknown }).path;
      return typeof path === "string" ? [{ mode, resource: `path:${path}` }] : "exclusive";
    },
    async execute(input) {
      log.push(`start ${input.path}`);
      live++;
      maxLive = Math.max(maxLive, live);
      await gateOf(input.path).promise;
      live--;
      log.push(`end ${input.path}`);
      return { content: `${name} ${input.path}` };
    },
  });
  const tools = new ToolRegistry()
    .register(mk("read", "read", "none"))
    .register(mk("write", "write", "none"))
    .register(mk("ask_read", "read", "ask"));
  return {
    log,
    release: (path: string) => gateOf(path).resolve(),
    maxLive: () => maxLive,
    agent(
      round: readonly StreamEvent[],
      extra: Partial<ConstructorParameters<typeof Agent>[0]> = {},
    ): Agent {
      return new Agent({
        model: new ScriptedProvider([
          [...round, { type: "done" }],
          [{ type: "text", delta: "ok" }, { type: "done" }],
        ]),
        tools,
        env: noopEnv,
        now: () => 0,
        toolExecution: { mode: "read-only", maxParallel: 8 },
        ...(opts.requester ? { requestPermission: opts.requester } : {}),
        ...extra,
      });
    },
  };
}

/** Run a turn in the background, collecting its events. */
function start(
  agent: Agent,
  messages: ChatMessage[],
  signal?: AbortSignal,
  runOpts: Parameters<Agent["runMessages"]>[4] = {},
) {
  const events: AgentEvent[] = [];
  const done = (async () => {
    for await (const event of agent.runMessages(messages, "s1", signal, undefined, runOpts)) {
      events.push(event);
    }
  })();
  return { events, done };
}

const label = (e: AgentEvent): string =>
  e.type === "tool_result" || e.type === "tool_start"
    ? `${e.type} ${e.id}`
    : e.type === "tool_phase"
      ? `${e.id} ${e.phase}`
      : e.type;

describe("tool_phase: `running` precedes every start, in stream order (T-O)", () => {
  /** A tool that records, when it starts, whether the consumer already saw its `running`. */
  function observed(events: AgentEvent[], seenAtStart: Map<string, boolean>) {
    return {
      name: "read",
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      permission: "none" as const,
      concurrency: (input: unknown) => [
        { mode: "read" as const, resource: `path:${(input as { path: string }).path}` },
      ],
      async execute(input: { path: string }, ctx: { toolCallId?: string }) {
        const id = ctx.toolCallId ?? "?";
        seenAtStart.set(
          id,
          events.some((e) => e.type === "tool_phase" && e.id === id && e.phase === "running"),
        );
        return { content: input.path };
      },
    };
  }

  for (const [name, mode, beforeRun] of [
    ["a call alone (sequential)", "sequential", undefined],
    ["a landed group (2a)", "read-only", async () => true],
    ["a fallback group (2b)", "read-only", async () => false],
  ] as const) {
    test(name, async () => {
      const events: AgentEvent[] = [];
      const seenAtStart = new Map<string, boolean>();
      const agent = new Agent({
        model: new ScriptedProvider([
          [call("c1", "read", "a"), call("c2", "read", "b"), { type: "done" }],
        ]),
        tools: new ToolRegistry().register(observed(events, seenAtStart) as Tool),
        env: noopEnv,
        toolExecution: { mode, maxParallel: 8 },
      });
      for await (const event of agent.runMessages(
        [{ role: "user", content: "go" }],
        "s1",
        undefined,
        undefined,
        beforeRun ? { beforeRun } : {},
      )) {
        events.push(event);
      }
      expect([...seenAtStart.entries()].sort()).toEqual([
        ["c1", true],
        ["c2", true],
      ]);
      const phases = events.flatMap((e) => (e.type === "tool_phase" ? [`${e.id} ${e.phase}`] : []));
      expect(phases).toEqual(
        mode === "sequential"
          ? ["c1 running", "c2 running"]
          : ["c1 queued", "c2 queued", "c1 running", "c2 running"],
      );
    });
  }

  test("an abort in the hop after `running`: cancelled, never started", async () => {
    for (const mode of ["sequential", "read-only"] as const) {
      const controller = new AbortController();
      const ran: string[] = [];
      const tool: Tool<{ path: string }> = {
        name: "read",
        description: "read",
        inputSchema: z.object({ path: z.string() }),
        permission: "none",
        concurrency: () => [{ mode: "read", resource: "r" }],
        async execute(input) {
          ran.push(input.path);
          return { content: input.path };
        },
      };
      const agent = new Agent({
        model: new ScriptedProvider([
          [call("c1", "read", "a"), call("c2", "read", "b"), { type: "done" }],
        ]),
        tools: new ToolRegistry().register(tool),
        env: noopEnv,
        toolExecution: { mode, maxParallel: 8 },
      });
      const messages: ChatMessage[] = [{ role: "user", content: "go" }];
      for await (const event of agent.runMessages(messages, "s1", controller.signal)) {
        if (event.type === "tool_phase" && event.phase === "running" && event.id === "c1") {
          controller.abort();
        }
      }
      expect(ran).toEqual([]);
      expect(messages.slice(2).map((m) => m.content)).toEqual([
        "Cancelled by the user before this tool ran.",
        "Cancelled by the user before this tool ran.",
      ]);
    }
  });
});

describe("round executor — groups (S3)", () => {
  test("T-E1: two read calls overlap in read-only mode", async () => {
    const l = lab();
    const run = start(l.agent([call("c1", "read", "a"), call("c2", "read", "b")]), [
      { role: "user", content: "go" },
    ]);
    // Both must start before either is released (the serial loop deadlocks here).
    await until(() => l.log.includes("start b"), "c2 to start while c1 runs");
    expect(l.log).toEqual(["start a", "start b"]);
    l.release("a");
    l.release("b");
    await run.done;
  });

  test("T-E2: results pushed in call order when completion is reversed; one commit", async () => {
    const l = lab();
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const run = start(l.agent([call("c1", "read", "a"), call("c2", "read", "b")]), messages);
    await until(() => l.log.includes("start b"));
    l.release("b");
    await until(() => l.log.includes("end b"));
    l.release("a");
    await run.done;
    expect(run.events.map(label).slice(0, 11)).toEqual([
      "history_commit",
      "tool_start c1",
      "c1 queued",
      "tool_start c2",
      "c2 queued",
      "c1 running",
      "c2 running",
      "tool_result c2",
      "tool_result c1",
      "history_commit",
      "text",
    ]);
    expect(messages.slice(2).map((m) => m.toolCallId)).toEqual(["c1", "c2"]);
  });

  test("T-E3: beforeRun once per multi-call group, awaited before any start", async () => {
    const l = lab();
    const held = deferred<boolean>();
    const seen: { ids: readonly string[]; started: number }[] = [];
    const beforeRun = (ids: readonly string[]) => {
      seen.push({ ids, started: l.log.length });
      return held.promise;
    };
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b"), call("c3", "write", "c")]),
      [{ role: "user", content: "go" }],
      undefined,
      { beforeRun },
    );
    await until(() => seen.length === 1);
    await new Promise((r) => setTimeout(r, 5));
    expect(l.log).toEqual([]); // held → nothing started
    held.resolve(true);
    await until(() => l.log.includes("start b"));
    l.release("a");
    l.release("b");
    await until(() => l.log.includes("start c"));
    l.release("c");
    await run.done;
    // Never for the write alone.
    expect(seen).toEqual([{ ids: ["c1", "c2"], started: 0 }]);
  });

  test("T-E3b: never in sequential mode", async () => {
    const l = lab();
    let calls = 0;
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b")], {
        toolExecution: { mode: "sequential", maxParallel: 8 },
      }),
      [{ role: "user", content: "go" }],
      undefined,
      {
        beforeRun: async () => {
          calls++;
          return true;
        },
      },
    );
    l.release("a");
    l.release("b");
    await run.done;
    expect(calls).toBe(0);
  });

  test("T-E4: beforeRun → false: strictly one at a time, a commit after each", async () => {
    const l = lab();
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b")]),
      [{ role: "user", content: "go" }],
      undefined,
      { beforeRun: async () => false },
    );
    await until(() => l.log.includes("start a"));
    await new Promise((r) => setTimeout(r, 5));
    expect(l.log).toEqual(["start a"]);
    l.release("a");
    await until(() => l.log.includes("start b"));
    l.release("b");
    await run.done;
    expect(l.log).toEqual(["start a", "end a", "start b", "end b"]);
    expect(run.events.map(label).slice(0, 11)).toEqual([
      "history_commit",
      "tool_start c1",
      "c1 queued",
      "tool_start c2",
      "c2 queued",
      "c1 running",
      "tool_result c1",
      "history_commit",
      "c2 running",
      "tool_result c2",
      "history_commit",
    ]);
  });

  test("T-E5: asks serial in call order with groupStart = head; a session grant covers call 2", async () => {
    const asked: string[] = [];
    const requester: PermissionRequester = async (req, options) => {
      asked.push(`${options?.toolCallId} ${options?.groupStart ?? "-"}`);
      return { allowed: true, scope: "session" };
    };
    const l = lab({ requester });
    const run = start(l.agent([call("c1", "ask_read", "a"), call("c2", "ask_read", "b")]), [
      { role: "user", content: "go" },
    ]);
    await until(() => l.log.includes("start b"));
    l.release("a");
    l.release("b");
    await run.done;
    expect(asked).toEqual(["c1 c1"]);

    const asked2: string[] = [];
    const l2 = lab({
      requester: async (_req, options) => {
        asked2.push(`${options?.toolCallId} ${options?.groupStart ?? "-"}`);
        return { allowed: true };
      },
    });
    const run2 = start(l2.agent([call("c1", "ask_read", "a"), call("c2", "ask_read", "b")]), [
      { role: "user", content: "go" },
    ]);
    await until(() => l2.log.includes("start b"));
    l2.release("a");
    l2.release("b");
    await run2.done;
    expect(asked2).toEqual(["c1 c1", "c2 c1"]);
  });

  test("T-E6a: Esc in phase 1 — the authorized sibling never starts", async () => {
    const controller = new AbortController();
    const second = deferred<void>();
    const l = lab({
      requester: async (_req, options) => {
        if (options?.toolCallId === "c2") {
          controller.abort();
          await second.promise;
          return { allowed: false, dismissed: true };
        }
        return { allowed: true };
      },
    });
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const run = start(
      l.agent([call("c1", "ask_read", "a"), call("c2", "ask_read", "b"), call("c3", "read", "c")]),
      messages,
      controller.signal,
    );
    await until(() => controller.signal.aborted);
    second.resolve();
    await run.done;
    expect(l.log).toEqual([]);
    expect(messages.slice(2).map((m) => [m.toolCallId, m.content])).toEqual([
      ["c1", "Cancelled by the user before this tool ran."],
      ["c2", "Cancelled by the user before this tool ran."],
      ["c3", "Cancelled by the user before this tool ran."],
    ]);
    expect(run.events.filter((e) => e.type === "tool_result").length).toBe(3);
  });

  test("T-E6b: Esc during beforeRun — nothing starts, all cancelled", async () => {
    const controller = new AbortController();
    const l = lab();
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b")]),
      messages,
      controller.signal,
      {
        beforeRun: (_ids, signal) =>
          new Promise<boolean>((resolve) =>
            signal.addEventListener("abort", () => resolve(false), { once: true }),
          ),
      },
    );
    await until(() => run.events.filter((e) => e.type === "tool_start").length === 2);
    controller.abort();
    await run.done;
    expect(l.log).toEqual([]);
    expect(messages.slice(2).map((m) => m.content)).toEqual([
      "Cancelled by the user before this tool ran.",
      "Cancelled by the user before this tool ran.",
    ]);
  });

  test("T-E6c: Esc in phase 2 — running awaited, not-started cancelled, each id once", async () => {
    const controller = new AbortController();
    const l = lab();
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b"), call("c3", "read", "c")], {
        toolExecution: { mode: "read-only", maxParallel: 2 },
      }),
      messages,
      controller.signal,
    );
    await until(() => l.log.includes("start b"));
    controller.abort();
    l.release("b");
    await until(() => l.log.includes("end b"));
    await new Promise((r) => setTimeout(r, 5));
    expect(l.log).not.toContain("start c");
    l.release("a");
    await run.done;
    expect(l.log).toEqual(["start a", "start b", "end b", "end a"]);
    expect(messages.slice(2).map((m) => [m.toolCallId, m.content])).toEqual([
      ["c1", "read a"],
      ["c2", "read b"],
      ["c3", "Cancelled by the user before this tool ran."],
    ]);
    const results = run.events.filter((e) => e.type === "tool_result").map(label);
    expect(results.sort()).toEqual(["tool_result c1", "tool_result c2", "tool_result c3"]);
  });

  test("T-E7: a throwing result transform in a group → that call's isError, the turn goes on", async () => {
    const l = lab();
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b")], {
        resultTransforms: [
          (result, ctx) => {
            if (ctx.toolCallId === "c1") {
              throw new Error("hook exploded");
            }
            return result;
          },
        ],
      }),
      messages,
    );
    l.release("a");
    l.release("b");
    await run.done;
    expect(messages[2]).toMatchObject({ toolCallId: "c1" });
    expect(messages[2]?.content).toContain("hook exploded");
    expect(messages[3]).toMatchObject({ toolCallId: "c2", content: "read b" });
    expect(run.events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    const r1 = run.events.find((e) => e.type === "tool_result" && e.id === "c1");
    expect(r1?.type === "tool_result" && r1.result.isError).toBe(true);
  });

  test("T-E7b: in a group of one, the throw fails the turn as today", async () => {
    const l = lab();
    const run = start(
      l.agent([call("c1", "read", "a")], {
        resultTransforms: [
          () => {
            throw new Error("hook exploded");
          },
        ],
      }),
      [{ role: "user", content: "go" }],
    );
    l.release("a");
    await expect(run.done).rejects.toThrow("hook exploded");
  });

  test("T-E8: maxParallel 2, three reads → never three running", async () => {
    const l = lab();
    const run = start(
      l.agent([call("c1", "read", "a"), call("c2", "read", "b"), call("c3", "read", "c")], {
        toolExecution: { mode: "read-only", maxParallel: 2 },
      }),
      [{ role: "user", content: "go" }],
    );
    await until(() => l.log.includes("start b"));
    await new Promise((r) => setTimeout(r, 5));
    expect(l.log).toEqual(["start a", "start b"]);
    l.release("b");
    await until(() => l.log.includes("start c"));
    l.release("a");
    l.release("c");
    await run.done;
    expect(l.maxLive()).toBe(2);
  });

  test("dependencies hold: [write a, read a] in parallel mode run one after the other", async () => {
    const l = lab();
    const run = start(
      l.agent([call("c1", "write", "a"), call("c2", "read", "a"), call("c3", "read", "b")], {
        toolExecution: { mode: "parallel", maxParallel: 8 },
      }),
      [{ role: "user", content: "go" }],
    );
    await until(() => l.log.includes("start b"));
    expect(l.log).toEqual(["start a", "start b"]);
    l.release("a");
    await until(() => l.log.filter((x) => x === "start a").length === 2);
    l.release("b");
    await run.done;
    expect(l.log.slice(0, 3)).toEqual(["start a", "start b", "end a"]);
  });
});
