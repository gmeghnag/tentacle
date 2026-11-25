import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { withStatusLine } from "../src/context-awareness.ts";
import { Session } from "../src/session.ts";
import { createSubagentRunner } from "../src/subagent.ts";

// docs/feat/workflow-run-awareness.md S2 (T2/T3): the live status line rides
// on every REQUEST of the main session, at the tail, never in the history.

const LINE = "[workflow wf-3 demo-note: step 2/4 test running · 1/4 ok · 4.1k tok]";

/** Plays one scripted round per model call; keeps a deep copy of each request. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  readonly calls: ChatRequest[] = [];
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.calls.push({ ...request, messages: structuredClone([...request.messages]) });
    for (const event of this.script[this.calls.length - 1] ?? [{ type: "done" }]) yield event;
  }
}

const call = (id: string, name: string, args: Record<string, unknown> = {}): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});
const TOOL_ROUND: StreamEvent[] = [call("c1", "look"), { type: "done" }];
const TEXT_ROUND: StreamEvent[] = [{ type: "text", delta: "done" }, { type: "done" }];

const env = {} as ExecutionEnvironment;

function tools(): ToolRegistry {
  const tool = (name: string, permission: Tool["permission"]): Tool => ({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permission,
    async execute() {
      return { content: `${name} ok` };
    },
  });
  return new ToolRegistry().register(tool("look", "none")).register(tool("run", "ask"));
}

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const hasLine = (messages: readonly ChatMessage[]): boolean =>
  messages.some((m) => m.content.includes("[workflow wf-3"));

describe("withStatusLine (pure)", () => {
  const sys: ChatMessage = { role: "system", content: "sys" };
  const user: ChatMessage = { role: "user", content: "hi" };
  const tool: ChatMessage = { role: "tool", content: "ok", toolCallId: "c1" };
  const assistant: ChatMessage = { role: "assistant", content: "hello" };

  test("after a user or a tool message: the line is the last user message", () => {
    expect(withStatusLine([sys, user], LINE)).toEqual([sys, user, { role: "user", content: LINE }]);
    expect(withStatusLine([sys, user, tool], LINE).at(-1)).toEqual({ role: "user", content: LINE });
  });

  test("undefined line, an assistant tail or an empty list → unchanged, never the input array", () => {
    const input = [sys, user];
    const out = withStatusLine(input, undefined);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    expect(withStatusLine([sys, user, assistant], LINE)).toEqual([sys, user, assistant]);
    expect(withStatusLine([], LINE)).toEqual([]);
  });
});

describe("RunOptions.statusLine via Session (T2)", () => {
  test("every round's request ends with the line; the history never holds it; round 2 extends round 1's prefix", async () => {
    const model = new Scripted([TOOL_ROUND, TEXT_ROUND]);
    const session = new Session(new Agent({ model, tools: tools(), env }), "S");
    let reads = 0;
    session.setStatusLine(() => {
      reads++;
      return LINE;
    });
    await drain(session.send("go"));

    expect(model.calls).toHaveLength(2);
    for (const request of model.calls) {
      expect(request.messages.at(-1)).toEqual({ role: "user", content: LINE });
    }
    expect(reads).toBe(2);
    expect(hasLine(session.messages)).toBe(false);
    expect(hasLine(session.snapshot().messages)).toBe(false);
    // The cache: round 1's request minus its line is a prefix of round 2's.
    const round1 = model.calls[0]?.messages ?? [];
    const round2 = model.calls[1]?.messages ?? [];
    expect(round2.slice(0, round1.length - 1)).toEqual(round1.slice(0, -1));
    // Round 2 is round 1's history + the assistant call + its tool result + the line.
    expect(round2.length).toBe(round1.length + 2);
  });

  test("a provider returning undefined (no live run) → no extra message", async () => {
    const withNone = new Scripted([TOOL_ROUND, TEXT_ROUND]);
    const none = new Session(new Agent({ model: withNone, tools: tools(), env }), "S");
    none.setStatusLine(() => undefined);
    await drain(none.send("go"));
    const plain = new Scripted([TOOL_ROUND, TEXT_ROUND]);
    await drain(new Session(new Agent({ model: plain, tools: tools(), env }), "S").send("go"));
    expect(withNone.calls.map((c) => c.messages)).toEqual(plain.calls.map((c) => c.messages));
  });

  test("setStatusLine(undefined) clears it", async () => {
    const model = new Scripted([TEXT_ROUND]);
    const session = new Session(new Agent({ model, tools: tools(), env }), "S");
    session.setStatusLine(() => LINE);
    session.setStatusLine(undefined);
    await drain(session.send("go"));
    expect(hasLine(model.calls[0]?.messages ?? [])).toBe(false);
  });

  test("a continuation over a history ending in an assistant message gets no line", async () => {
    const model = new Scripted([TEXT_ROUND]);
    const session = new Session(new Agent({ model, tools: tools(), env }), "S", {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    });
    session.setStatusLine(() => LINE);
    await drain(session.send(""));
    expect(model.calls).toHaveLength(1);
    expect(hasLine(model.calls[0]?.messages ?? [])).toBe(false);
  });

  test("the forced final report carries the line, before the nudge", async () => {
    const model = new Scripted([TOOL_ROUND, TEXT_ROUND]);
    const session = new Session(new Agent({ model, tools: tools(), env, maxIterations: 1 }), "S");
    session.setStatusLine(() => LINE);
    await drain(session.send("go"));
    expect(model.calls).toHaveLength(2);
    const final = model.calls[1];
    expect(final?.tools).toBeUndefined();
    const messages = final?.messages ?? [];
    expect(messages.at(-2)).toEqual({ role: "user", content: LINE });
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.filter((m) => m.content === LINE)).toHaveLength(1);
    expect(hasLine(session.messages)).toBe(false);
  });
});

describe("statusLine scope (T3)", () => {
  test("replaceAgent keeps the provider", async () => {
    const first = new Scripted([TEXT_ROUND]);
    const session = new Session(new Agent({ model: first, tools: tools(), env }), "S");
    session.setStatusLine(() => LINE);
    const next = new Scripted([TEXT_ROUND]);
    session.replaceAgent(new Agent({ model: next, tools: tools(), env }));
    await drain(session.send("go"));
    expect(first.calls).toHaveLength(0);
    expect(next.calls[0]?.messages.at(-1)).toEqual({ role: "user", content: LINE });
  });

  test("resume passes it", async () => {
    // Suspend on `run` (an ask), capture the history, resume it on a fresh agent.
    let captured: ChatMessage[] | undefined;
    const ref: { session?: Session } = {};
    const s = new Session(
      new Agent({
        model: new Scripted([[call("c1", "run"), { type: "done" }]]),
        tools: tools(),
        env,
        requestPermission: () => {
          captured = structuredClone([...(ref.session?.snapshot().messages ?? [])]);
          return new Promise(() => {});
        },
      }),
      "S",
    );
    ref.session = s;
    void drain(s.send("go"));
    for (let i = 0; i < 20 && !captured; i++) await tick();
    if (!captured) throw new Error("never suspended");

    const model = new Scripted([TEXT_ROUND]);
    const session = new Session(
      new Agent({ model, tools: tools(), env, requestPermission: async () => ({ allowed: true }) }),
      "S",
      { messages: captured },
    );
    session.setStatusLine(() => LINE);
    await drain(session.resume("c1"));
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]?.messages.at(-1)).toEqual({ role: "user", content: LINE });
    expect(hasLine(session.messages)).toBe(false);
  });

  test("a sub-agent run from the session never sees the line", async () => {
    const child = new Scripted([TEXT_ROUND]);
    const { run, types } = createSubagentRunner({ model: child, env, tools: tools() });
    const parent = new Scripted([
      [
        call("task-1", "agent_task", { description: "look", prompt: "look around" }),
        { type: "done" },
      ],
      TEXT_ROUND,
    ]);
    const session = new Session(
      new Agent({
        model: parent,
        tools: new ToolRegistry().register(createTaskTool(run, types)),
        env,
      }),
      "S",
    );
    session.setStatusLine(() => LINE);
    await drain(session.send("go"));
    expect(child.calls.length).toBeGreaterThan(0);
    for (const request of child.calls) {
      expect(hasLine(request.messages)).toBe(false);
    }
    // The parent's requests do carry it (the test is not vacuous).
    expect(parent.calls.every((c) => c.messages.at(-1)?.content === LINE)).toBe(true);
  });
});
