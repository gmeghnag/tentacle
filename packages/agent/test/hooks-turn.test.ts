import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecOptions,
  ExecResult,
  ExecutionEnvironment,
  HookSpec,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";
import {
  HookRunner,
  MAX_HOOK_CONTEXT,
  modelRequestDelta,
  parseTurnEndOutcome,
  parseTurnStartOutcome,
} from "../src/hooks.ts";

const MAX_MODEL_CALLS = 8;

/** Records each request's messages so we can assert what the model saw. */
class RecordingProvider implements ModelProvider {
  readonly id = "rec";
  readonly seen: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    // A runaway loop (e.g. an uncapped continue with maxIterations -1) fails fast.
    if (this.seen.length >= MAX_MODEL_CALLS) {
      throw new Error("runaway: too many model calls");
    }
    this.seen.push(request.messages.map((m) => ({ ...m })));
    const events = this.script[this.turn++] ?? [{ type: "text", delta: "again" }, { type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }, { type: "done" }];
const callMissing = (id: string): StreamEvent[] => [
  { type: "tool_call", toolCall: { id, name: "missing", arguments: "{}" } },
  { type: "done" },
];
const ok = (stdout: string, exitCode = 0, stderr = ""): ExecResult => ({
  stdout,
  stderr,
  exitCode,
});

interface HookCall {
  readonly command: string;
  readonly input: Record<string, unknown>;
}

/** A fake env: `answer(command, opts)` gives each hook's process result. */
function fakeEnv(
  answer: (command: string, opts?: ExecOptions) => Promise<ExecResult> | ExecResult,
) {
  const calls: HookCall[] = [];
  const env: ExecutionEnvironment = {
    id: "fake",
    async exec(command, opts) {
      calls.push({ command, input: JSON.parse(opts?.stdin ?? "{}") as Record<string, unknown> });
      return answer(command, opts);
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
  return { env, calls, of: (command: string) => calls.filter((c) => c.command === command) };
}

function setup(
  specs: readonly HookSpec[],
  script: readonly (readonly StreamEvent[])[],
  answer: Parameters<typeof fakeEnv>[0],
  over: { maxIterations?: number; modelRequestHooks?: boolean } = {},
) {
  const { env, calls, of } = fakeEnv(answer);
  const logs: string[] = [];
  const hooks = new HookRunner({
    specs,
    env,
    cwd: "/w",
    log: (l) => logs.push(l),
    modelId: "m1",
    modelRequestHooks: over.modelRequestHooks ?? true,
  });
  const model = new RecordingProvider(script);
  const agent = new Agent({
    model,
    tools: new ToolRegistry(),
    env,
    hooks,
    ...(over.maxIterations !== undefined ? { maxIterations: over.maxIterations } : {}),
  });
  return { agent, model, calls, of, logs };
}

async function drive(
  agent: Agent,
  messages: ChatMessage[],
  signal?: AbortSignal,
  opts: { resumeFrom?: string } = {},
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of agent.runMessages(messages, "S", signal, undefined, opts)) {
    events.push(e);
  }
  return events;
}

/**
 * Well-formed history: every assistant `toolCalls` is followed immediately by
 * exactly its answers, and no `tool` message appears anywhere else.
 */
function expectWellFormed(messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m?.role === "tool") {
      throw new Error(`orphan tool message at ${i}`);
    }
    if (m?.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
      const ids = m.toolCalls.map((c) => c.id);
      const answers = messages.slice(i + 1, i + 1 + ids.length);
      expect(answers.map((a) => [a.role, a.toolCallId])).toEqual(ids.map((id) => ["tool", id]));
      i += ids.length;
    }
  }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));
const never = (): Promise<ExecResult> => new Promise(() => {});
/** A hook process that runs until the signal kills it (HostExecution reports 124). */
const untilKilled = (opts?: ExecOptions): Promise<ExecResult> =>
  new Promise((resolve) => {
    opts?.signal?.addEventListener("abort", () => resolve(ok("", 124)), { once: true });
  });

describe("parseTurnStartOutcome / parseTurnEndOutcome", () => {
  test("turn_start: empty → none; context → note; exit 2 → stop; failures by onFailure", () => {
    expect(parseTurnStartOutcome(ok(""), undefined)).toEqual({ kind: "none" });
    expect(parseTurnStartOutcome(ok('{"context":"hi"}'), undefined)).toEqual({
      kind: "context",
      text: "hi",
    });
    expect(parseTurnStartOutcome(ok("", 2, " nope \n"), undefined)).toEqual({
      kind: "stop",
      reason: "nope",
    });
    expect(parseTurnStartOutcome(ok("", 2), undefined)).toEqual({
      kind: "stop",
      reason: "stopped by hook",
    });
    expect(parseTurnStartOutcome(ok('{"context":1}'), "ignore")).toEqual({
      kind: "none",
      failure: "`context` is not a string",
    });
    expect(parseTurnStartOutcome("timeout", "block")).toEqual({
      kind: "stop",
      reason: "hook failed: timed out",
    });
    expect(parseTurnStartOutcome(ok("", 1), undefined)).toEqual({
      kind: "none",
      failure: "exited 1",
    });
  });

  test("turn_start: a huge context is clipped (MAX_HOOK_CONTEXT)", () => {
    const big = "x".repeat(MAX_HOOK_CONTEXT + 50);
    expect(parseTurnStartOutcome(ok(JSON.stringify({ context: big })), undefined)).toEqual({
      kind: "context",
      text: `${"x".repeat(MAX_HOOK_CONTEXT)}…`,
    });
  });

  test("turn_end: empty → stop; continue:true → continue; exit 2 → continue; failures by onFailure", () => {
    expect(parseTurnEndOutcome(ok(""), undefined)).toEqual({ kind: "stop" });
    expect(parseTurnEndOutcome(ok('{"continue":false}'), undefined)).toEqual({ kind: "stop" });
    expect(parseTurnEndOutcome(ok('{"continue":true,"reason":"tests fail"}'), undefined)).toEqual({
      kind: "continue",
      reason: "tests fail",
    });
    expect(parseTurnEndOutcome(ok('{"continue":true}'), undefined)).toEqual({
      kind: "continue",
      reason: "",
    });
    expect(parseTurnEndOutcome(ok("", 2, "fix lint"), undefined)).toEqual({
      kind: "continue",
      reason: "fix lint",
    });
    expect(parseTurnEndOutcome(ok('{"continue":"yes"}'), "ignore")).toEqual({
      kind: "stop",
      failure: "`continue` is not a boolean",
    });
    expect(parseTurnEndOutcome("error", "block")).toEqual({
      kind: "continue",
      reason: "hook failed: could not be started",
    });
  });

  test("modelRequestDelta: messages since the last count; a shrunk history sends all", () => {
    const m = (content: string): ChatMessage => ({ role: "user", content });
    const h = [m("a"), m("b"), m("c")];
    expect(modelRequestDelta(h, undefined)).toEqual(h);
    expect(modelRequestDelta(h, 2)).toEqual([m("c")]);
    expect(modelRequestDelta(h, 3)).toEqual([]);
    expect(modelRequestDelta(h, 5)).toEqual(h);
  });
});

describe("turn_start", () => {
  test("a hook's context is a user note before the first model request, with a context_note", async () => {
    const { agent, model, of } = setup([{ event: "turn_start", command: "ts" }], [say("ok")], () =>
      ok('{"context":"branch is main"}'),
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drive(agent, messages);
    const note = "[hook turn_start] branch is main";
    expect(model.seen[0]).toEqual([
      { role: "user", content: "go" },
      { role: "user", content: note },
    ]);
    expect(events).toContainEqual({ type: "context_note", text: note, reason: "hook" });
    expect(of("ts")[0]?.input).toMatchObject({
      event: "turn_start",
      session_id: "S",
      prompt: "go",
    });
    expectWellFormed(messages);
  });

  test("exit 2 stops the turn before any model call, ending end_turn with the note", async () => {
    const { agent, model } = setup([{ event: "turn_start", command: "ts" }], [say("ok")], () =>
      ok("", 2, "frozen"),
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drive(agent, messages);
    const note = "[hook turn_start] turn stopped: frozen";
    expect(model.seen).toHaveLength(0);
    expect(events.slice(-2)).toEqual([
      { type: "context_note", text: note, reason: "hook" },
      { type: "turn_end", reason: "end_turn" },
    ]);
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "go"],
      ["user", note],
    ]);
  });

  test("a cancel during the hook ends the turn cancelled, with no model call", async () => {
    const ac = new AbortController();
    const { agent, model } = setup(
      [{ event: "turn_start", command: "ts" }],
      [say("ok")],
      (_c, o) => {
        setTimeout(() => ac.abort(), 1);
        return untilKilled(o);
      },
    );
    const events = await drive(agent, [{ role: "user", content: "go" }], ac.signal);
    expect(model.seen).toHaveLength(0);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(events.some((e) => e.type === "context_note")).toBe(false);
  });

  test("R4: not run on a resumed turn (and run on the same history otherwise)", async () => {
    const suspended = (): ChatMessage[] => [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "missing", arguments: "{}" }],
      },
    ];
    const a = setup([{ event: "turn_start", command: "ts" }], [say("ok")], () => ok(""));
    await drive(a.agent, suspended(), undefined, { resumeFrom: "c1" });
    expect(a.of("ts")).toHaveLength(0);
    const b = setup([{ event: "turn_start", command: "ts" }], [say("ok")], () => ok(""));
    await drive(b.agent, [{ role: "user", content: "go" }]);
    expect(b.of("ts")).toHaveLength(1);
  });
});

describe("turn_end (end_turn) may continue", () => {
  for (const maxIterations of [16, -1]) {
    test(`at most 3 continues per turn (maxIterations ${maxIterations})`, async () => {
      const { agent, model, of } = setup(
        [{ event: "turn_end", command: "te" }],
        [say("a1"), say("a2"), say("a3"), say("a4"), say("a5")],
        () => ok('{"continue":true,"reason":"keep going"}'),
        { maxIterations },
      );
      const messages: ChatMessage[] = [{ role: "user", content: "go" }];
      const events = await drive(agent, messages);
      expect(model.seen).toHaveLength(4);
      expect(of("te").map((c) => c.input.continued)).toEqual([0, 1, 2]);
      expect(of("te")[0]?.input).toMatchObject({
        event: "turn_end",
        reason: "end_turn",
        last_assistant_message: "a1",
      });
      expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
      const note = "[hook turn_end] keep going";
      expect(events.filter((e) => e.type === "context_note")).toEqual(
        [0, 1, 2].map(() => ({ type: "context_note", text: note, reason: "hook" })),
      );
      expect(messages.map((m) => [m.role, m.content])).toEqual([
        ["user", "go"],
        ["assistant", "a1"],
        ["user", note],
        ["assistant", "a2"],
        ["user", note],
        ["assistant", "a3"],
        ["user", note],
        ["assistant", "a4"],
      ]);
      expectWellFormed(messages);
    });
  }

  test("several hooks: any continue continues; reasons joined; empty → 'continue'", async () => {
    const { agent, model } = setup(
      [
        { event: "turn_end", command: "x" },
        { event: "turn_end", command: "y" },
      ],
      [say("a1"), say("a2")],
      (c) => (c === "x" ? ok("", 2, "lint") : ok('{"continue":true}')),
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drive(agent, messages);
    expect(model.seen.length).toBeGreaterThanOrEqual(2);
    expect(events).toContainEqual({
      type: "context_note",
      text: "[hook turn_end] lint",
      reason: "hook",
    });
    const only = setup([{ event: "turn_end", command: "y" }], [say("a1")], () =>
      ok('{"continue":true}'),
    );
    const ev2 = await drive(only.agent, [{ role: "user", content: "go" }]);
    expect(ev2).toContainEqual({
      type: "context_note",
      text: "[hook turn_end] continue",
      reason: "hook",
    });
  });

  test("not run on an empty (stalled) round: the nudge handles it", async () => {
    const { agent, of } = setup(
      [{ event: "turn_end", command: "te" }],
      [say(""), say("done")],
      () => ok(""),
    );
    await drive(agent, [{ role: "user", content: "go" }]);
    expect(of("te").map((c) => c.input.last_assistant_message)).toEqual(["done"]);
  });

  test("a cancel during the hook ends the turn cancelled, never continued", async () => {
    const ac = new AbortController();
    const { agent, model } = setup(
      [{ event: "turn_end", command: "te" }],
      [say("a1"), say("a2")],
      (_c, o) => {
        setTimeout(() => ac.abort(), 1);
        return untilKilled(o);
      },
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drive(agent, messages, ac.signal);
    expect(model.seen).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(events.some((e) => e.type === "context_note")).toBe(false);
    expectWellFormed(messages);
  });
});

describe("turn_end notifications (cancelled / max_iterations)", () => {
  test("max_iterations: the hook is told, and the turn ends without awaiting it", async () => {
    const { agent, of } = setup(
      [{ event: "turn_end", command: "te" }],
      [callMissing("c1"), say("report")],
      () => never(),
      { maxIterations: 1 },
    );
    const messages: ChatMessage[] = [{ role: "user", content: "go" }];
    const events = await drive(agent, messages);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "max_iterations" });
    expect(of("te").map((c) => c.input.reason)).toEqual(["max_iterations"]);
    expectWellFormed(messages);
  });

  test("cancelled: the hook is told, and the turn ends without awaiting it", async () => {
    const ac = new AbortController();
    ac.abort();
    const { agent, of } = setup([{ event: "turn_end", command: "te" }], [say("x")], () => never());
    const events = await drive(agent, [{ role: "user", content: "go" }], ac.signal);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect(of("te").map((c) => c.input.reason)).toEqual(["cancelled"]);
  });
});

describe("model_request (notification)", () => {
  test("once per model call, with the new messages since the previous one", async () => {
    const { agent, of } = setup(
      [{ event: "model_request", command: "mr" }],
      [callMissing("c1"), say("done")],
      () => ok(""),
    );
    await drive(agent, [{ role: "user", content: "go" }]);
    await tick();
    const inputs = of("mr").map((c) => c.input);
    expect(inputs.map((i) => i.iteration)).toEqual([0, 1]);
    expect(inputs[0]).toMatchObject({
      event: "model_request",
      model: "m1",
      message_count: 1,
      tool_names: [],
      new_messages: [{ role: "user", content: "go" }],
    });
    expect(inputs[1]).toMatchObject({ message_count: 3 });
    expect((inputs[1]?.new_messages as { role: string }[]).map((m) => m.role)).toEqual([
      "assistant",
      "tool",
    ]);
  });

  test("the final no-tools call is reported as iteration 'final'", async () => {
    const { agent, of } = setup(
      [{ event: "model_request", command: "mr" }],
      [callMissing("c1"), say("report")],
      () => ok(""),
      { maxIterations: 1 },
    );
    await drive(agent, [{ role: "user", content: "go" }]);
    await tick();
    expect(of("mr").map((c) => c.input.iteration)).toEqual([0, "final"]);
  });

  test("not run when modelRequestHooks is false (a pod: the request is built in the pod)", async () => {
    const { agent, of } = setup(
      [{ event: "model_request", command: "mr" }],
      [say("done")],
      () => ok(""),
      { modelRequestHooks: false },
    );
    await drive(agent, [{ role: "user", content: "go" }]);
    await tick();
    expect(of("mr")).toHaveLength(0);
  });

  test("R3: a call while the previous one still runs is dropped (one log line), never queued", async () => {
    const { agent, of, logs } = setup(
      [{ event: "model_request", command: "mr" }],
      [callMissing("c1"), callMissing("c2"), say("done")],
      () => never(),
    );
    const events = await drive(agent, [{ role: "user", content: "go" }]);
    await tick();
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(of("mr")).toHaveLength(1);
    expect(logs.filter((l) => l.includes("model_request"))).toHaveLength(1);
  });
});
