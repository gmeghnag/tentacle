import { describe, expect, test } from "bun:test";
import type {
  BackgroundJob,
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  PermissionRequest,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent, ResumeShapeError } from "../src/agent.ts";
import { suspendedCalls } from "../src/resume.ts";
import { Session } from "../src/session.ts";

// A turn suspended on a permission is continued after a `serve` restart
// (docs/feat/suspended-turn-resume.md). The load-bearing property (S1): the
// resumed turn ends with the history an uninterrupted run would have had.
// Each test names the mutation that must turn it red (AGENTS §9).

/** Plays one scripted round per model call; keeps a copy of each request. */
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
const ROUND1: StreamEvent[] = [
  call("c1", "look"),
  call("c2", "run", { n: 2 }),
  call("c3", "run", { n: 3 }),
  { type: "done" },
];
const ROUND2: StreamEvent[] = [{ type: "text", delta: "all done" }, { type: "done" }];

const env = {} as ExecutionEnvironment;

function tools(runs: string[]): ToolRegistry {
  const tool = (name: string, permission: Tool["permission"]): Tool => ({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permission,
    async execute(input) {
      runs.push(`${name}:${JSON.stringify(input)}`);
      return { content: `${name} ok ${JSON.stringify(input)}` };
    },
  });
  return new ToolRegistry().register(tool("look", "none")).register(tool("run", "ask"));
}

const shape = (messages: readonly ChatMessage[]): string[] =>
  messages.map((m) =>
    m.role === "assistant" && m.toolCalls
      ? `assistant[${m.toolCalls.map((c) => c.id).join(",")}]`
      : m.role === "tool"
        ? `tool(${m.toolCallId})`
        : `${m.role}:${m.content}`,
  );

async function drain(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** The record a daemon captures at the ask for `c2`: history + steering, as JSON. */
async function suspendOnC2(): Promise<{ messages: ChatMessage[]; steering: string[] }> {
  const runs: string[] = [];
  const ref: { session?: Session } = {};
  let captured: ChatMessage[] | undefined;
  const agent = new Agent({
    model: new Scripted([ROUND1, ROUND2]),
    tools: tools(runs),
    env,
    requestPermission: () => {
      captured = structuredClone([...(ref.session?.snapshot().messages ?? [])]);
      return new Promise(() => {}); // the process "dies" here
    },
  });
  const s = new Session(agent, "S");
  ref.session = s;
  void drain(s.send("go"));
  for (let i = 0; i < 20 && !captured; i++) await tick();
  s.enqueue("steer-1");
  if (!captured) throw new Error("never suspended");
  expect(runs).toEqual(["look:{}"]);
  return JSON.parse(JSON.stringify({ messages: captured, steering: s.pendingSteering() }));
}

describe("resume a suspended turn (agent seam)", () => {
  test("S1 the resumed turn ends with the uninterrupted history: one model round, each call asked and run once", async () => {
    // Mutations: `resume` as `send("")` → c2/c3 never run, history differs;
    // resume from calls[0] → c1 runs twice; `resume` resets steering → steer-1 missing.

    // A: uninterrupted, the steer queued while c2 waits for approval.
    const runsA: string[] = [];
    const asksA: string[] = [];
    const refA: { session?: Session } = {};
    const agentA = new Agent({
      model: new Scripted([ROUND1, ROUND2]),
      tools: tools(runsA),
      env,
      requestPermission: async (r: PermissionRequest) => {
        asksA.push(JSON.stringify(r.input));
        if (asksA.length === 1) refA.session?.enqueue("steer-1");
        return { allowed: true };
      },
    });
    const sessionA = new Session(agentA, "S");
    refA.session = sessionA;
    await drain(sessionA.send("go"));
    expect(shape(sessionA.messages)).toEqual([
      "user:go",
      "assistant[c1,c2,c3]",
      "tool(c1)",
      "tool(c2)",
      "tool(c3)",
      "user:steer-1",
      "assistant:all done",
    ]);

    // B: suspended on c2, the process dies, a fresh agent resumes from the record.
    const record = await suspendOnC2();
    const runs: string[] = [];
    const asks: string[] = [];
    const model = new Scripted([ROUND2]);
    const agent = new Agent({
      model,
      tools: tools(runs),
      env,
      requestPermission: async (r: PermissionRequest) => {
        asks.push(JSON.stringify(r.input));
        return { allowed: true };
      },
    });
    const session = new Session(agent, "S", { messages: record.messages });
    for (const text of record.steering) session.enqueue(text);
    const events = await drain(session.resume("c2"));

    expect(session.messages).toEqual(sessionA.messages);
    expect(runs).toEqual(['run:{"n":2}', 'run:{"n":3}']);
    expect(asks).toEqual(asksA);
    expect(model.calls).toHaveLength(1);
    expect(shape(model.calls[0]?.messages ?? []).slice(-3)).toEqual([
      "tool(c2)",
      "tool(c3)",
      "user:steer-1",
    ]);
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "end_turn" });
    expect(events[0]).toMatchObject({ type: "tool_start", id: "c2" });
  });

  test("S2 a history not suspended before the call → ResumeShapeError; nothing yielded, run or asked", async () => {
    // Mutation: skip the shape check → a call that may have run is run again.
    const base: ChatMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "c1", name: "look", arguments: "{}" },
          { id: "c2", name: "run", arguments: "{}" },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ];
    const cases: Array<[string, ChatMessage[], string]> = [
      ["unknown id", base, "zz"],
      ["already answered", base, "c1"],
      ["an earlier call unanswered", base.slice(0, 2), "c2"],
      ["a later call answered", [...base, { role: "tool", content: "x", toolCallId: "c2" }], "c2"],
      ["a stray user message", [...base, { role: "user", content: "hi" }], "c2"],
      ["no assistant", [{ role: "user", content: "go" }], "c1"],
    ];
    for (const [label, messages, id] of cases) {
      const runs: string[] = [];
      let asked = 0;
      const model = new Scripted([ROUND2]);
      const agent = new Agent({
        model,
        tools: tools(runs),
        env,
        requestPermission: async () => {
          asked++;
          return { allowed: true };
        },
      });
      const history = structuredClone(messages);
      const yielded: AgentEvent[] = [];
      let thrown: unknown;
      try {
        for await (const e of agent.runMessages(history, "S", undefined, undefined, {
          resumeFrom: id,
        })) {
          yielded.push(e);
        }
      } catch (error) {
        thrown = error;
      }
      expect({ label, isShapeError: thrown instanceof ResumeShapeError }).toEqual({
        label,
        isShapeError: true,
      });
      expect({ label, yielded: yielded.length, runs, asked, model: model.calls.length }).toEqual({
        label,
        yielded: 0,
        runs: [],
        asked: 0,
        model: 0,
      });
      expect(history).toEqual(messages);
    }
  });

  test("S3 a background exit noticed before the resume is surfaced AFTER the resumed round", async () => {
    // Mutation: flush the exits before the resumed calls → a user note sits inside the round.
    const listeners = new Set<(job: BackgroundJob) => void>();
    const jobs: JobController = {
      start: () => {
        throw new Error("unused");
      },
      read: () => undefined,
      kill: () => false,
      list: () => [],
      dispose: () => {},
      onExit(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    const record = await suspendOnC2();
    const runs: string[] = [];
    const agent = new Agent({
      model: new Scripted([ROUND2]),
      tools: tools(runs),
      env,
      jobs,
      requestPermission: async () => ({ allowed: true }),
    });
    for (const l of listeners) {
      l({ id: "bg-1", command: "serve", startedAt: 0, status: "exited", exitCode: 0 });
    }
    const session = new Session(agent, "S", { messages: record.messages });
    await drain(session.resume("c2"));
    expect(shape(session.messages).slice(1, 6)).toEqual([
      "assistant[c1,c2,c3]",
      "tool(c1)",
      "tool(c2)",
      "tool(c3)",
      expect.stringMatching(/^user:\[background\] job bg-1/) as unknown as string,
    ]);
  });

  test("S4 aborted before the resume: the round is answered 'cancelled', nothing is asked or run", async () => {
    // Mutation: run the resumed calls without the abort branch → c2 is asked.
    const record = await suspendOnC2();
    const runs: string[] = [];
    let asked = 0;
    const model = new Scripted([ROUND2]);
    const agent = new Agent({
      model,
      tools: tools(runs),
      env,
      requestPermission: async () => {
        asked++;
        return { allowed: true };
      },
    });
    const session = new Session(agent, "S", { messages: record.messages });
    const controller = new AbortController();
    controller.abort();
    const events = await drain(session.resume("c2", controller.signal));
    expect(shape(session.messages).slice(-2)).toEqual(["tool(c2)", "tool(c3)"]);
    expect(session.messages.at(-1)?.content).toBe("Cancelled by the user before this tool ran.");
    expect(events.at(-1)).toEqual({ type: "turn_end", reason: "cancelled" });
    expect({ runs, asked, model: model.calls.length }).toEqual({ runs: [], asked: 0, model: 0 });
  });

  test("S5 suspendedCalls: the calls from the id on, only for the exact suspended shape", () => {
    // Mutation: accept an "answered" SET instead of the exact in-order prefix → the out-of-order case passes.
    const a: ChatMessage = {
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "c1", name: "a", arguments: "{}" },
        { id: "c2", name: "b", arguments: "{}" },
        { id: "c3", name: "c", arguments: "{}" },
      ],
    };
    const t = (id: string): ChatMessage => ({ role: "tool", content: "", toolCallId: id });
    const ids = (m: ChatMessage[], id: string) => suspendedCalls(m, id)?.map((c) => c.id) ?? null;
    expect(ids([a], "c1")).toEqual(["c1", "c2", "c3"]);
    expect(ids([a, t("c1")], "c2")).toEqual(["c2", "c3"]);
    expect(ids([a, t("c1"), t("c2")], "c3")).toEqual(["c3"]);
    expect(ids([a, t("c2"), t("c1")], "c3")).toBeNull(); // out of order
    expect(ids([a, t("c1")], "c3")).toBeNull(); // c2 unanswered
    expect(ids([a, t("c1"), t("c2"), t("c3")], "c3")).toBeNull(); // answered
    expect(ids([a, { role: "user", content: "x" }], "c1")).toBeNull();
    expect(ids([{ role: "assistant", content: "hi" }], "c1")).toBeNull();
    expect(ids([], "c1")).toBeNull();
  });
});
