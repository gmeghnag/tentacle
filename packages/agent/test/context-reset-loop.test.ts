import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecResult,
  ExecutionEnvironment,
  ModelProvider,
  PermissionRequest,
  PermissionResponse,
  StreamEvent,
  Tool,
  ToolCall,
} from "@tentacle/core";
import {
  CONTEXT_RESET_TOOL_NAME,
  SKILL_TOOL_NAME,
  ToolRegistry,
  createContextResetTool,
  createSkillActivator,
  createSkillTool,
} from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentConfig, type AgentEvent, type SessionSkills } from "../src/agent.ts";
import { contextResetHistory, restartMessage, restartPromptOf } from "../src/context-reset.ts";
import { HookRunner } from "../src/hooks.ts";
import { Session } from "../src/session.ts";

// docs/feat/context-reset.md (slice 3): the agent loop runs `context_reset` —
// refusals before the gate, the approval, prepare (all I/O) then commit (one
// synchronous stretch: history + skill set), the anti-loop guard, the round
// budget restart, the hook baseline and the context line after a reset.

const MAX_MODEL_CALLS = 12;

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  /** Each request's history, copied at call time (the array is live). */
  readonly seen: ChatMessage[][] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.requests.length >= MAX_MODEL_CALLS) {
      throw new Error("runaway: too many model calls");
    }
    this.requests.push(request);
    this.seen.push(request.messages.map((m) => ({ ...m })));
    for (const event of this.script[this.turn++] ?? [{ type: "text", delta: "end" }]) {
      yield event;
    }
    yield { type: "done" };
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

const call = (id: string, name: string, args: unknown = {}): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(args),
});
const calls = (...c: ToolCall[]): StreamEvent[] =>
  c.map((toolCall) => ({ type: "tool_call", toolCall }));
const reset = (id: string, prompt: unknown = "next: step 2"): StreamEvent[] =>
  calls(call(id, CONTEXT_RESET_TOOL_NAME, { prompt }));
const other = (id: string): StreamEvent[] => calls(call(id, "other"));
const say = (text: string): StreamEvent[] => [{ type: "text", delta: text }];

const otherTool: Tool<Record<string, never>> = {
  name: "other",
  description: "another tool",
  inputSchema: z.object({}),
  permission: "none",
  async execute() {
    return { content: "ok" };
  },
};

/** A skill set over `bodies` (name → body), built as the wiring builds one. */
function skillSet(bodies: Record<string, string>): SessionSkills {
  const entries = Object.keys(bodies).map((name) => ({
    name,
    location: `/s/${name}/SKILL.md`,
    dir: `/s/${name}`,
    files: [],
    filesTruncated: false,
  }));
  const reader = async (s: { name: string }) => ({ body: bodies[s.name] ?? "", bodyLine: 1 });
  return {
    tool: createSkillTool(entries, reader),
    activator: createSkillActivator(
      entries.map((e) => ({ ...e, userInvocable: true })),
      reader,
    ),
  };
}

interface Harness {
  readonly agent: Agent;
  readonly session: Session;
  readonly tools: ToolRegistry;
  readonly model: ScriptedProvider;
  readonly asked: PermissionRequest[];
  readonly refreshes: { count: number };
}

function harness(o: {
  script: readonly (readonly StreamEvent[])[];
  refresh?: () => Promise<{ systemPrompt: string; skills: SessionSkills }>;
  maxPerMessage?: number;
  maxIterations?: number;
  answer?: (req: PermissionRequest) => Promise<PermissionResponse>;
  skills?: SessionSkills;
  extra?: Partial<AgentConfig>;
}): Harness {
  const tools = new ToolRegistry().register(otherTool).register(createContextResetTool());
  const skills = o.skills ?? {};
  if (skills.tool) {
    tools.register(skills.tool);
  }
  const model = new ScriptedProvider(o.script);
  const asked: PermissionRequest[] = [];
  const refreshes = { count: 0 };
  const agent = new Agent({
    model,
    tools,
    env: noopEnv,
    systemPrompt: "OLD SYSTEM",
    ...(o.maxIterations !== undefined ? { maxIterations: o.maxIterations } : {}),
    ...(skills.activator ? { skills: skills.activator } : {}),
    requestPermission: async (req) => {
      asked.push(req);
      return o.answer ? o.answer(req) : { allowed: true };
    },
    contextReset: {
      maxPerMessage: o.maxPerMessage ?? -1,
      refresh: async () => {
        refreshes.count++;
        return o.refresh ? o.refresh() : { systemPrompt: "FRESH SYSTEM", skills: {} };
      },
    },
    ...o.extra,
  });
  const session = new Session(agent, "s1");
  return { agent, session, tools, model, asked, refreshes };
}

/** Wait (bounded) for `ready`: a never-reached point fails on the assertion, not a timeout. */
async function until(ready: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await Bun.sleep(1);
  expect(ready()).toBe(true);
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) {
    out.push(e);
  }
  return out;
}

const resultOf = (events: readonly AgentEvent[], id: string): string | undefined => {
  const r = events.find((e) => e.type === "tool_result" && e.id === id);
  return r?.type === "tool_result" ? r.result.content : undefined;
};
const resets = (events: readonly AgentEvent[]) =>
  events.filter(
    (e): e is Extract<AgentEvent, { type: "context_reset" }> => e.type === "context_reset",
  );
const turnEnd = (events: readonly AgentEvent[]) => {
  const e = events.at(-1);
  return e?.type === "turn_end" ? e.reason : undefined;
};
/** Every assistant call is answered by a `tool` message: the history is valid. */
function assertPaired(messages: readonly ChatMessage[]): void {
  messages.forEach((m, i) => {
    const ids = (m.toolCalls ?? []).map((c) => c.id);
    const answers = messages
      .slice(i + 1, i + 1 + ids.length)
      .map((n) => (n.role === "tool" ? n.toolCallId : undefined));
    expect(answers).toEqual(ids);
  });
}

describe("context_reset in the agent loop", () => {
  test("(a) accepted: the next request is exactly contextResetHistory(fresh prompt, restart prompt)", async () => {
    const h = harness({
      script: [other("c1"), reset("c2", "goal: X; plan in docs/p.md"), say("on")],
    });
    const events = await collect(h.session.send("hello"));
    expect(turnEnd(events)).toBe("end_turn");
    expect(h.refreshes.count).toBe(1);
    const expected = contextResetHistory({
      systemPrompt: "FRESH SYSTEM",
      prompt: "goal: X; plan in docs/p.md",
      jobs: [],
      skills: { kept: [], dropped: [] },
    });
    // The exact property: the round after the reset sees the fresh history only.
    expect(h.model.seen[2]).toEqual(expected);
    expect(h.model.seen[2]?.[0]?.content).toBe("FRESH SYSTEM");
    // The barrier event carries the new history; the display row says what happened.
    expect(resets(events).map((e) => e.messages)).toEqual([expected]);
    expect(resultOf(events, "c2")).toContain("Context reset");
    // The reset's own call is discarded: nothing answers it in the history.
    expect(h.session.messages.some((m) => m.toolCallId === "c2")).toBe(false);
    expect(h.session.messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
    assertPaired(h.session.messages);
  });

  test("(b) not the only call of its message: refused before the gate; the other call runs", async () => {
    const h = harness({
      script: [[...reset("c1"), ...other("c2")], say("ok")],
    });
    const events = await collect(h.session.send("hello"));
    expect(resultOf(events, "c1")).toContain("only tool call");
    expect(resultOf(events, "c2")).toBe("ok");
    expect(resets(events)).toHaveLength(0);
    expect(h.asked).toHaveLength(0);
    expect(h.refreshes.count).toBe(0);
    expect(h.session.messages[0]?.content).toBe("OLD SYSTEM");
    assertPaired(h.session.messages);
  });

  test("(c) no other call since the previous reset: the second is refused", async () => {
    const h = harness({ script: [other("c0"), reset("c1"), reset("c2"), say("ok")] });
    const events = await collect(h.session.send("hello"));
    expect(resets(events)).toHaveLength(1);
    expect(resultOf(events, "c2")).toContain("since your previous");
    expect(h.asked.map((r) => r.tool)).toEqual([CONTEXT_RESET_TOOL_NAME]);
    assertPaired(h.session.messages);
  });

  test("(c') the first reset of a session needs no earlier call", async () => {
    const h = harness({ script: [reset("c1"), say("ok")] });
    expect(resets(await collect(h.session.send("hello")))).toHaveLength(1);
  });

  test("(d) cap 1 per user message: the second is refused; a new user message (or a steer) resets the count", async () => {
    const h = harness({
      maxPerMessage: 1,
      script: [reset("c1"), other("c2"), reset("c3"), say("done"), reset("c4"), say("again")],
    });
    const first = await collect(h.session.send("hello"));
    expect(resets(first)).toHaveLength(1);
    expect(resultOf(first, "c3")).toContain("limit of 1");
    const second = await collect(h.session.send("next message"));
    expect(resets(second)).toHaveLength(1);

    // A steer drained mid-turn is a user message: the count restarts.
    let released: (() => void) | undefined;
    const steered = harness({
      maxPerMessage: 1,
      script: [reset("s1"), other("s2"), reset("s3"), say("done")],
      answer: async (req) => {
        if (req.tool === CONTEXT_RESET_TOOL_NAME && released === undefined) {
          await new Promise<void>((r) => {
            released = r;
          });
        }
        return { allowed: true };
      },
    });
    const run = collect(steered.session.send("hello"));
    await until(() => released !== undefined);
    steered.session.enqueue("a steer");
    released?.();
    expect(resets(await run)).toHaveLength(2);
  });

  test("(e) denied: nothing replaced, nothing refreshed, the call answered as denied", async () => {
    const h = harness({
      script: [reset("c1"), say("ok")],
      answer: async () => ({ allowed: false }),
    });
    const events = await collect(h.session.send("hello"));
    expect(resultOf(events, "c1")).toContain("Permission denied");
    expect(resets(events)).toHaveLength(0);
    expect(h.refreshes.count).toBe(0);
    expect(h.session.messages[0]?.content).toBe("OLD SYSTEM");
    assertPaired(h.session.messages);
  });

  test("(f) cancel during a hanging refresh: turn cancelled, history AND skill tool untouched", async () => {
    const before = skillSet({ old: "old body" });
    const controller = new AbortController();
    const h = harness({
      skills: before,
      script: [reset("c1")],
      refresh: () => {
        controller.abort();
        return new Promise(() => {}); // never settles
      },
    });
    const events = await collect(h.session.send("hello", controller.signal));
    expect(turnEnd(events)).toBe("cancelled");
    expect(resets(events)).toHaveLength(0);
    expect(before.tool).toBeDefined();
    expect(h.tools.get(SKILL_TOOL_NAME) === before.tool).toBe(true);
    expect(h.session.messages[0]?.content).toBe("OLD SYSTEM");
    expect(h.session.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
    assertPaired(h.session.messages);
  });

  test("(f') a refresh that throws: error result, context NOT reset, the model carries on", async () => {
    const h = harness({
      script: [reset("c1"), say("carried on")],
      refresh: () => Promise.reject(new Error("PROMPT.md is gone")),
    });
    const events = await collect(h.session.send("hello"));
    expect(resultOf(events, "c1")).toContain("the context was NOT reset");
    expect(resultOf(events, "c1")).toContain("PROMPT.md is gone");
    expect(resets(events)).toHaveLength(0);
    expect(turnEnd(events)).toBe("end_turn");
    expect(h.session.messages[0]?.content).toBe("OLD SYSTEM");
    assertPaired(h.session.messages);
  });

  test("(g) a steer queued during the reset lands AFTER the restart message, in the new context", async () => {
    let release: ((v: { systemPrompt: string; skills: SessionSkills }) => void) | undefined;
    const h = harness({
      script: [reset("c1"), say("ok")],
      refresh: () =>
        new Promise((r) => {
          release = r;
        }),
    });
    const run = collect(h.session.send("hello"));
    await until(() => release !== undefined);
    h.session.enqueue("also do Y");
    release?.({ systemPrompt: "FRESH SYSTEM", skills: {} });
    const events = await run;
    expect(h.model.seen[1]?.map((m) => m.content)).toEqual([
      "FRESH SYSTEM",
      restartMessage("next: step 2"),
      "also do Y",
    ]);
    const kinds = events.map((e) => e.type);
    expect(kinds.indexOf("steer")).toBeGreaterThan(kinds.indexOf("context_reset"));
  });

  test("(h) the approval shows the restart prompt; a blank prompt is refused WITHOUT asking", async () => {
    const h = harness({ script: [reset("c1", "my restart prompt"), say("ok")] });
    await collect(h.session.send("hello"));
    expect(h.asked).toHaveLength(1);
    expect(h.asked[0]).toMatchObject({
      tool: CONTEXT_RESET_TOOL_NAME,
      title: "Reset the context (the model restarts from its prompt)",
      detail: "my restart prompt",
    });

    const blank = harness({ script: [reset("c1", "   "), say("ok")] });
    const events = await collect(blank.session.send("hello"));
    expect(resultOf(events, "c1")).toContain("empty");
    expect(blank.asked).toHaveLength(0);
    expect(blank.refreshes.count).toBe(0);
  });

  test("(h') a tool_call hook that blanks the prompt: refused after the gate, nothing replaced", async () => {
    const env: ExecutionEnvironment = {
      ...noopEnv,
      exec: async (): Promise<ExecResult> => ({
        stdout: JSON.stringify({ decision: "allow", input: { prompt: " " } }),
        stderr: "",
        exitCode: 0,
      }),
    };
    const hooks = new HookRunner({
      specs: [{ event: "tool_call", command: "rewrite", matcher: CONTEXT_RESET_TOOL_NAME }],
      env,
      cwd: "/w",
    });
    const h = harness({ script: [reset("c1", "real prompt"), say("ok")], extra: { hooks } });
    const events = await collect(h.session.send("hello"));
    expect(resets(events)).toHaveLength(0);
    expect(resultOf(events, "c1")).toContain("empty");
    expect(h.session.messages[0]?.content).toBe("OLD SYSTEM");
  });

  test("(i) the skill set is swapped: the next round offers the new skill and it loads; a removed active one is carried", async () => {
    const before = skillSet({ old: "old body" });
    const after = skillSet({ added: "added body" });
    const h = harness({
      skills: before,
      script: [
        calls(call("k1", SKILL_TOOL_NAME, { name: "old" })),
        reset("c1"),
        calls(call("k2", SKILL_TOOL_NAME, { name: "added" })),
        say("done"),
      ],
      refresh: async () => ({ systemPrompt: "FRESH SYSTEM", skills: after }),
    });
    const events = await collect(h.session.send("hello"));
    const skillEnum = (req: ChatRequest | undefined) =>
      (
        req?.tools?.find((t) => t.name === SKILL_TOOL_NAME)?.parameters as {
          properties: { name: { enum: string[] } };
        }
      )?.properties.name.enum;
    expect(skillEnum(h.model.requests[1])).toEqual(["old"]);
    expect(skillEnum(h.model.requests[2])).toEqual(["added"]);
    expect(resultOf(events, "k2")).toContain('<skill_content name="added">');
    expect(resultOf(events, "c1")).toContain("skills: + added, − old");
    // "old" was active: carried with its stored copy, named unavailable.
    const restart = h.model.seen[2]?.[1]?.content ?? "";
    expect(restart).toContain('No longer in the Skills list: "old".');
    expect(h.model.seen[2]?.[2]?.toolCalls?.[0]?.id).toBe("k1");
    expect(h.agent.canActivateForUser("added")).toBe(true);
    expect(h.agent.canActivateForUser("old")).toBe(false);
    assertPaired(h.session.messages);
  });

  test("(j) an accepted reset restarts the round budget; a refused one does not", async () => {
    const ok = harness({
      maxIterations: 2,
      script: [other("c1"), reset("c2"), other("c3"), say("done")],
    });
    expect(turnEnd(await collect(ok.session.send("hello")))).toBe("end_turn");

    const refused = harness({
      maxIterations: 2,
      script: [other("c1"), reset("c2", ""), other("c3"), say("done")],
    });
    expect(turnEnd(await collect(refused.session.send("hello")))).toBe("max_iterations");
  });

  test("(k) model_request hook: after a reset, new_messages is the whole fresh history", async () => {
    const inputs: Record<string, unknown>[] = [];
    const env: ExecutionEnvironment = {
      ...noopEnv,
      exec: async (_command, opts): Promise<ExecResult> => {
        inputs.push(JSON.parse(opts?.stdin ?? "{}") as Record<string, unknown>);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    };
    const hooks = new HookRunner({
      specs: [{ event: "model_request", command: "mr" }],
      env,
      cwd: "/w",
      modelRequestHooks: true,
    });
    // Carried skill rounds make the fresh history as long as the old one (4 → 4).
    const both = skillSet({ a: "A", b: "B" });
    const h = harness({
      skills: both,
      extra: { hooks },
      script: [calls(call("k1", SKILL_TOOL_NAME, { name: "a" })), reset("c1"), say("done")],
      refresh: async () => ({ systemPrompt: "FRESH SYSTEM", skills: both }),
    });
    const tick = () => Bun.sleep(5);
    const run = h.session.send("hello");
    const out: AgentEvent[] = [];
    for await (const e of run) {
      out.push(e);
      await tick(); // let each notification finish (one in flight per session)
    }
    await tick();
    const last = inputs.at(-1);
    expect(last?.message_count).toBe(4);
    expect((last?.new_messages as { content: string }[]).map((m) => m.content)).toEqual(
      (h.model.seen.at(-1) ?? []).map((m) => m.content),
    );
  });

  test("F2: context_reset is a commit point — the history it names is never popped after it", async () => {
    // After the reset the model stalls once (an empty round: pushed then popped).
    const h = harness({ script: [other("c0"), reset("c1"), [], say("done")] });
    const snapshots: ChatMessage[][] = [];
    const events: AgentEvent[] = [];
    for await (const e of h.session.send("hello")) {
      events.push(e);
      if (e.type === "context_reset") {
        // At the event, the live history IS the event's history (no pending pop).
        expect(h.session.messages).toEqual([...e.messages]);
        snapshots.push([...h.session.messages]);
      }
    }
    expect(turnEnd(events)).toBe("end_turn");
    expect(snapshots).toHaveLength(1);
    const cut = snapshots[0] ?? [];
    // Append-only past the cut: every element behind it is still there, identical.
    expect(h.session.messages.slice(0, cut.length)).toEqual(cut);
    for (let i = 0; i < cut.length; i++) {
      expect(h.session.messages[i]).toBe(cut[i] as ChatMessage);
    }
    // The empty round's nudge came after the cut.
    expect(events.findIndex((e) => e.type === "context_note")).toBeGreaterThan(
      events.findIndex((e) => e.type === "context_reset"),
    );
  });

  test("context awareness: the fresh context gets its line at once, counted from the fresh history", async () => {
    const h = harness({
      script: [other("c0"), reset("c1"), say("done")],
      extra: { contextAwareness: { window: 1000, stepPercent: 10 } },
    });
    await collect(h.session.send("hello"));
    const fresh = h.model.seen[2] ?? [];
    const restart = fresh[1]?.content ?? "";
    // The model's copy carries the line; the stored restart message stays parseable.
    expect(restart).toMatch(/\n\n\[context: \d+ \/ 1k tokens \(\d+%\)\]$/);
    expect(restartPromptOf(restart)).toBe("next: step 2");
  });

  test("tool absent (disabled) or no reset config: the loop does not intercept", async () => {
    const tools = new ToolRegistry().register(otherTool).register(createContextResetTool());
    const model = new ScriptedProvider([reset("c1"), say("ok")]);
    const agent = new Agent({ model, tools, env: noopEnv, systemPrompt: "S" });
    const events = await collect(new Session(agent, "s").send("hello"));
    expect(resultOf(events, "c1")).toContain("handled by the agent loop");
    expect(resets(events)).toHaveLength(0);
  });
});
