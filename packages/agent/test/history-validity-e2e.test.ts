/**
 * docs/feat/history-validity-invariant.md, Part A end-to-end (T3).
 *
 * The live incident: llama.cpp answers 500 "Failed to parse tool call
 * arguments as JSON" on EVERY request once one `tool_calls[].function.
 * arguments` is not a JSON object. The fake server here behaves like it, so a
 * history holding one invalid call poisons the session unless the model's copy
 * is repaired. The stored history stays verbatim (the server only sees the
 * request body).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  type ExecutionEnvironment,
  type ModelProvider,
  type StreamEvent,
  type Tool,
  invalidArgumentsNote,
  repairHistory,
  validateHistory,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { OpenAIProvider } from "../../providers/src/index.ts";
import { Agent, type AgentConfig, type AgentEvent, Session } from "../src/index.ts";

const BAD = '{"path":"a.txt","content":"line1\nunterminated';
const BAD_BYTES = new TextEncoder().encode(BAD).length;
const marker = (n: number) => `{"_invalid_arguments":true,"bytes":${n}}`;

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

interface Poison {
  readonly path: string;
  readonly body: string;
}

/** The wire shape the tests read back out of a captured request body. */
interface WireMessage {
  readonly role: string;
  readonly content?: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly { readonly function: { readonly arguments: string } }[];
}

/** The llama.cpp-shaped complaint, for any request holding an invalid call. */
function findPoison(body: string): Poison | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const messages = (parsed as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return undefined;
  }
  for (const [index, m] of messages.entries()) {
    const calls = (m as { tool_calls?: unknown }).tool_calls;
    if (!Array.isArray(calls)) {
      continue;
    }
    for (const c of calls) {
      const args = (c as { function?: { arguments?: unknown } }).function?.arguments;
      if (typeof args !== "string") {
        return { path: `messages[${index}].tool_calls[].function.arguments`, body: "not a string" };
      }
      let value: unknown;
      try {
        value = JSON.parse(args);
      } catch {
        return { path: `messages[${index}].tool_calls[].function.arguments`, body: args };
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return { path: `messages[${index}].tool_calls[].function.arguments`, body: args };
      }
    }
  }
  return undefined;
}

/**
 * A llama.cpp-shaped server: 500 on a request holding a non-object call
 * argument (the incident), SSE text otherwise. Every request body is kept, so
 * a test can assert what the model was actually sent.
 */
interface FakeServer {
  readonly baseURL: string;
  readonly promptBodies: string[];
  readonly templateBodies: string[];
  /** What the next rounds answer, in order: a tool call, then text. */
  stop(): void;
}

function fakeLlama(script: readonly (readonly StreamEvent[])[]): FakeServer {
  const promptBodies: string[] = [];
  const templateBodies: string[] = [];
  let turn = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      if (url.pathname.endsWith("/chat/completions")) {
        promptBodies.push(body);
        const poison = findPoison(body);
        if (poison !== undefined) {
          return Response.json(
            {
              error: {
                code: 500,
                message: `Failed to parse tool call arguments as JSON: ${poison.body.slice(0, 40)}`,
              },
            },
            { status: 500 },
          );
        }
        return new Response(sse(script[turn++] ?? [{ type: "done" }]), {
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (url.pathname.endsWith("/apply-template")) {
        templateBodies.push(body);
        const poison = findPoison(body);
        if (poison !== undefined) {
          return Response.json(
            { error: { code: 500, message: "Failed to parse tool call arguments as JSON" } },
            { status: 500 },
          );
        }
        return Response.json({ prompt: "<|im_start|>fake prompt" });
      }
      if (url.pathname.endsWith("/tokenize")) {
        return Response.json({ tokens: [1, 2, 3, 4] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    baseURL: `http://localhost:${server.port}/v1`,
    promptBodies,
    templateBodies,
    stop: () => server.stop(true),
  };
}

/** `events` as an OpenAI-compatible SSE body (the provider's own shapes). */
function sse(events: readonly StreamEvent[]): string {
  const chunks: unknown[] = [];
  let calls = 0;
  for (const event of events) {
    if (event.type === "text") {
      chunks.push({ choices: [{ delta: { content: event.delta } }] });
    } else if (event.type === "tool_call") {
      const call = event.toolCall;
      chunks.push({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: calls,
                  id: call.id,
                  function: { name: call.name, arguments: call.arguments },
                },
              ],
            },
          },
        ],
      });
      calls++;
    }
  }
  chunks.push({ choices: [{ delta: {}, finish_reason: calls > 0 ? "tool_calls" : "stop" }] });
  const frames = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`);
  return frames.join("");
}

/** The incident's tool: `fs_write`. */
const fsWrite: Tool<{ path: string; content: string }> = {
  name: "fs_write",
  description: "write a file",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  permission: "none",
  async execute(input) {
    return { content: `wrote ${input.path} (${input.content.length} bytes)` };
  },
};

/** An invalid `fs_write` call, exactly the incident's shape. */
function badWrite(id: string): StreamEvent {
  return { type: "tool_call", toolCall: { id, name: "fs_write", arguments: BAD } };
}

const textEvent = (delta: string): StreamEvent => ({ type: "text", delta });

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const seen: AgentEvent[] = [];
  for await (const event of gen) {
    seen.push(event);
  }
  return seen;
}

function newAgent(baseURL: string, extra: Partial<AgentConfig> = {}): Agent {
  const tools = new ToolRegistry();
  tools.register(fsWrite);
  const model = new OpenAIProvider({ baseURL, model: "fake" });
  return new Agent({ model, tools, env: noopEnv, ...extra });
}

describe("T3a: the incident — one invalid call no longer poisons the session", () => {
  test("the same turn continues and the next turn works; stored bytes unchanged", async () => {
    const fake = fakeLlama([[badWrite("c1")], [textEvent("reply 2")], [textEvent("reply 3")]]);
    try {
      const agent = newAgent(fake.baseURL);
      const session = new Session(agent);

      const first = await drain(session.send("write a file"));
      expect(first.some((e) => e.type === "turn_end")).toBe(true);
      // The Agent does not deduplicate: it reports one repair per repaired round.
      const repaired = first.filter((e) => e.type === "history_repaired");
      expect(repaired).toHaveLength(1);
      expect(repaired[0]).toEqual({
        type: "history_repaired",
        invalidArguments: 1,
        unansweredCalls: 0,
        orphanResults: 0,
      });

      const second = await drain(session.send("hey"));
      expect(second.some((e) => e.type === "turn_end")).toBe(true);
      expect(fake.promptBodies).toHaveLength(3);

      // The round-2 request carries the marker, and the paired result says so.
      const round2 = JSON.parse(fake.promptBodies[1] ?? "{}").messages as WireMessage[];
      const call = round2.flatMap((m) => m.tool_calls ?? [])[0];
      expect(call?.function.arguments).toBe(marker(BAD_BYTES));
      const paired = round2.find((m) => m.role === "tool" && m.tool_call_id === "c1");
      expect(paired?.content).toContain(invalidArgumentsNote(BAD_BYTES));

      // The STORED history keeps the model's original bytes (non-destructive),
      // and the repair is idempotent over it.
      const stored = session.messages.flatMap((m) => m.toolCalls ?? []);
      expect(stored.find((c) => c.id === "c1")?.arguments).toBe(BAD);
      expect(validateHistory(repairHistory(session.messages).messages)).toEqual([]);
    } finally {
      fake.stop();
    }
  });
});

/** The owner's poisoned session, offline: the bad call, its registry error, two failed turns. */
function poisonedHistory(): ChatMessage[] {
  return [
    { role: "user", content: "write a file" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "fs_write", arguments: BAD }] },
    { role: "tool", content: "invalid JSON arguments for fs_write", toolCallId: "c1" },
    { role: "assistant", content: "Failed: ModelRequestError: status 500" },
    { role: "user", content: "hey" },
    { role: "assistant", content: "Failed: ModelRequestError: status 500" },
  ];
}

describe("T3b: the owner's poisoned session, offline", () => {
  test("send() over the stored poisoned history succeeds", async () => {
    const fake = fakeLlama([[textEvent("hi")]]);
    try {
      const agent = newAgent(fake.baseURL);
      const session = new Session(agent, "s", { messages: poisonedHistory() });
      const events = await drain(session.send("hey"));
      expect(events.some((e) => e.type === "turn_end")).toBe(true);
      // The stored bytes are still the model's originals.
      const stored = session.messages.flatMap((m) => m.toolCalls ?? []);
      expect(stored.find((c) => c.id === "c1")?.arguments).toBe(BAD);
    } finally {
      fake.stop();
    }
  });
});

describe("T3d: the exact count over a poisoned history", () => {
  test("contextUsage is exact and leaves session.messages untouched", async () => {
    const fake = fakeLlama([]);
    try {
      const agent = newAgent(fake.baseURL);
      const session = new Session(agent, "s", { messages: poisonedHistory() });
      const before = structuredClone(session.messages);
      const usage = await agent.contextUsage(session.messages);
      expect(usage.exact).toBe(true);
      expect(usage.used).toBe(4);
      expect(fake.templateBodies).toHaveLength(1);
      // The count is taken over the SAME repaired copy the model would be sent
      // (the note proves it: the provider guard only sanitizes bytes).
      const counted = JSON.parse(fake.templateBodies[0] ?? "{}").messages as WireMessage[];
      const paired = counted.find((m) => m.role === "tool" && m.tool_call_id === "c1");
      expect(paired?.content).toContain(invalidArgumentsNote(BAD_BYTES));
      expect(session.messages).toEqual(before);
    } finally {
      fake.stop();
    }
  });
});

describe("T3c: the final no-tools round at max_iterations", () => {
  test("it follows an invalid call and still succeeds", async () => {
    // Round 1 is the bad call; maxIterations 1 makes round 2 the final,
    // tool-free round (the other history site).
    const fake = fakeLlama([[badWrite("c1")], [textEvent("final report")]]);
    try {
      const agent = newAgent(fake.baseURL, { maxIterations: 1 });
      const session = new Session(agent);
      const events = await drain(session.send("write a file"));
      const end = events.find((e) => e.type === "turn_end");
      expect(end).toEqual({ type: "turn_end", reason: "max_iterations" });
      const finalBody = JSON.parse(fake.promptBodies[1] ?? "{}").messages as WireMessage[];
      const call = finalBody.flatMap((m) => m.tool_calls ?? [])[0];
      expect(call?.function.arguments).toBe(marker(BAD_BYTES));
      // The note proves THIS site repaired the copy (the provider guard alone
      // would only sanitize the bytes).
      const paired = finalBody.find((m) => m.role === "tool" && m.tool_call_id === "c1");
      expect(paired?.content).toContain(invalidArgumentsNote(BAD_BYTES));
    } finally {
      fake.stop();
    }
  });
});
