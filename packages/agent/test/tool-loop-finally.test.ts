/**
 * docs/feat/history-validity-invariant.md, Part B (T5): an abnormal exit of
 * the tool loop — a throw, or a consumer that stops at a yield — never leaves
 * a stored `assistant[tool_calls]` with no `tool` message answering it.
 *
 * Every case asserts the FULL `session.messages` (roles, ids, contents) and
 * that the history is well-formed by the wire rule (`validateHistory` over the
 * repair is empty).
 */
import { describe, expect, test } from "bun:test";
import {
  type ChatMessage,
  type ExecutionEnvironment,
  type ModelProvider,
  type PermissionRequester,
  type StreamEvent,
  type Tool,
  type ToolResult,
  repairHistory,
  validateHistory,
} from "@tentacle/core";
import {
  CONTEXT_RESET_TOOL_NAME,
  ToolRegistry,
  createContextResetTool,
  createSkillActivator,
} from "@tentacle/tools";
import { z } from "zod";
import {
  Agent,
  type AgentConfig,
  type AgentEvent,
  type ResultTransform,
  Session,
} from "../src/index.ts";

const NOT_RUN =
  "Not run: the turn stopped unexpectedly before this call started. Ask again if it is still needed.";
const INTERRUPTED =
  "Interrupted: the turn stopped unexpectedly after this tool started; its result was not recorded. It may have completed — check before retrying.";

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

function call(id: string, name: string, path = "a.ts"): StreamEvent {
  return { type: "tool_call", toolCall: { id, name, arguments: JSON.stringify({ path }) } };
}

/** A read-class tool that records every run. */
function readTool(ran: string[]): Tool<{ path: string }> {
  return {
    name: "read",
    description: "read",
    inputSchema: z.object({ path: z.string() }),
    permission: "none",
    // Read-class and disjoint by path: the plan may group these in parallel.
    concurrency: (input: unknown) => [
      { mode: "read" as const, resource: `path:${(input as { path: string }).path}` },
    ],
    async execute(input) {
      ran.push(`read ${input.path}`);
      return { content: `content of ${input.path}` };
    },
  };
}

/** The compact shape every case asserts: roles, ids, contents. */
function shape(messages: readonly ChatMessage[]): string[] {
  return messages.map((m) => {
    const calls = (m.toolCalls ?? []).map((c) => c.id).join(",");
    return [m.role, calls, m.toolCallId ?? "", m.content].join("|");
  });
}

/** The history is well-formed by the wire rule: the repair finds nothing to do. */
function expectWellFormed(messages: readonly ChatMessage[]): void {
  expect(validateHistory(repairHistory(messages).messages)).toEqual([]);
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function build(script: readonly (readonly StreamEvent[])[], extra: Partial<AgentConfig>): Agent {
  return new Agent({
    model: new ScriptedProvider(script),
    tools: new ToolRegistry().register(readTool([])),
    env: noopEnv,
    ...extra,
  });
}

describe("T5a (A): the permission requester throws", () => {
  test("the call is answered 'Not run' and the turn rejects", async () => {
    const ran: string[] = [];
    const askTool: Tool<{ path: string }> = {
      name: "edit",
      description: "edit",
      inputSchema: z.object({ path: z.string() }),
      permission: "ask",
      async execute(input) {
        ran.push(`edit ${input.path}`);
        return { content: "edited" };
      },
    };
    const requester: PermissionRequester = async () => {
      throw new Error("authorize boom");
    };
    const agent = new Agent({
      model: new ScriptedProvider([[call("c1", "edit")]]),
      tools: new ToolRegistry().register(askTool),
      env: noopEnv,
      requestPermission: requester,
    });
    const session = new Session(agent);

    await expect(collect(session.send("go"))).rejects.toThrow("authorize boom");
    expect(ran).toEqual([]);
    expect(shape(session.messages)).toEqual(["user|||go", "assistant|c1||", `tool||c1|${NOT_RUN}`]);
    expectWellFormed(session.messages);
  });
});

describe("T5b (B): a result transform throws on a call alone", () => {
  test("the call is 'Interrupted' (it started) and its raw output is not in the history", async () => {
    const ran: string[] = [];
    const leaking: Tool<{ path: string }> = {
      name: "read",
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      async execute(input) {
        ran.push(`read ${input.path}`);
        return { content: "SECRET-RAW-OUTPUT" };
      },
    };
    const transform: ResultTransform = () => {
      throw new Error("transform boom");
    };
    const agent = new Agent({
      model: new ScriptedProvider([[call("c1", "read")]]),
      tools: new ToolRegistry().register(leaking),
      env: noopEnv,
      resultTransforms: [transform],
    });
    const session = new Session(agent);

    await expect(collect(session.send("go"))).rejects.toThrow("transform boom");
    expect(ran).toEqual(["read a.ts"]);
    expect(shape(session.messages)).toEqual([
      "user|||go",
      "assistant|c1||",
      `tool||c1|${INTERRUPTED}`,
    ]);
    expect(JSON.stringify(session.messages)).not.toContain("SECRET-RAW-OUTPUT");
    expectWellFormed(session.messages);
  });
});

describe("T5c (C): the consumer breaks out right after the first tool_start", () => {
  test("neither call started, so both are 'Not run'", async () => {
    const ran: string[] = [];
    const tools = new ToolRegistry().register(readTool(ran));
    const agent = new Agent({
      model: new ScriptedProvider([[call("c1", "read", "a.ts"), call("c2", "read", "b.ts")]]),
      tools,
      env: noopEnv,
    });
    const session = new Session(agent);

    for await (const event of session.send("go")) {
      if (event.type === "tool_start") {
        break;
      }
    }
    expect(ran).toEqual([]);
    expect(shape(session.messages)).toEqual([
      "user|||go",
      "assistant|c1,c2||",
      `tool||c1|${NOT_RUN}`,
      `tool||c2|${NOT_RUN}`,
    ]);
    expectWellFormed(session.messages);
  });
});

describe("T5d (H): the consumer throws on the first tool_result", () => {
  test("the REAL transformed result is in the history, not a note", async () => {
    const ran: string[] = [];
    const tools = new ToolRegistry().register(readTool(ran));
    const agent = new Agent({
      model: new ScriptedProvider([[call("c1", "read")]]),
      tools,
      env: noopEnv,
    });
    const session = new Session(agent);

    await expect(
      (async () => {
        for await (const event of session.send("go")) {
          if (event.type === "tool_result") {
            throw new Error("sink boom");
          }
        }
      })(),
    ).rejects.toThrow("sink boom");

    expect(ran).toEqual(["read a.ts"]);
    expect(shape(session.messages)).toEqual([
      "user|||go",
      "assistant|c1||",
      "tool||c1|content of a.ts",
    ]);
    expectWellFormed(session.messages);
  });
});

describe("T5h (suspension untouched): the ask never settles", () => {
  test("stopping the pull leaves the dangling call dangling; nothing is synthesized", async () => {
    const askTool: Tool<{ path: string }> = {
      name: "edit",
      description: "edit",
      inputSchema: z.object({ path: z.string() }),
      permission: "ask",
      async execute() {
        return { content: "edited" };
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([[call("c1", "edit")]]),
      tools: new ToolRegistry().register(askTool),
      env: noopEnv,
      // Never settles: the turn stays suspended on the ask, as on `serve`.
      requestPermission: () => new Promise(() => {}),
    });
    const session = new Session(agent);

    // Pull until the ask is raised, then STOP pulling — without `return()`: a
    // `break` in `for await` would call `return()` and close the generator,
    // which is exactly the abnormal exit this case must not be.
    const gen = session.send("go");
    while (true) {
      const next = await gen.next();
      if (next.done === true || next.value.type === "tool_start") {
        break;
      }
    }
    expect(shape(session.messages)).toEqual(["user|||go", "assistant|c1||"]);
  });
});

describe("T5e (parallel): the consumer throws on the first phase-2 result", () => {
  test("the seen result is kept; the group leaves no call unanswered", async () => {
    const ran: string[] = [];
    const agent = new Agent({
      model: new ScriptedProvider([
        [call("c1", "read", "a.ts"), call("c2", "read", "b.ts"), call("c3", "read", "c.ts")],
      ]),
      tools: new ToolRegistry().register(readTool(ran)),
      env: noopEnv,
      toolExecution: { mode: "read-only", maxParallel: 2 },
    });
    const session = new Session(agent);

    let results = 0;
    await expect(
      (async () => {
        for await (const event of session.send("go", undefined, { beforeRun: async () => true })) {
          if (event.type === "tool_result") {
            results++;
            throw new Error("sink boom");
          }
        }
      })(),
    ).rejects.toThrow("sink boom");

    expect(results).toBe(1);
    expectWellFormed(session.messages);
    expect(shape(session.messages)[1]).toBe("assistant|c1,c2,c3||");
    const answers = session.messages.filter((m) => m.role === "tool");
    expect(answers).toHaveLength(3);
    // The result the client already saw is in the history (the group's
    // finally); the other calls are answered, never left dangling.
    expect(answers[0]?.content).toBe("content of a.ts");
    // c2 had started (`runPrepared`), c3 never did: each note says which.
    expect(answers[1]?.content).toBe(INTERRUPTED);
    expect(answers[2]?.content).toBe(NOT_RUN);
  });
});

describe("T5i (context reset): a throw at the context_reset yield", () => {
  test("the FRESH history gets no synthesized answer (the owner is gone)", async () => {
    const other: Tool<Record<string, never>> = {
      name: "other",
      description: "another",
      inputSchema: z.object({}),
      permission: "none",
      async execute() {
        return { content: "ok" };
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([
        [
          {
            type: "tool_call",
            toolCall: {
              id: "c1",
              name: CONTEXT_RESET_TOOL_NAME,
              arguments: JSON.stringify({ prompt: "next" }),
            },
          },
        ],
        [{ type: "text", delta: "done" }],
      ]),
      tools: new ToolRegistry().register(other).register(createContextResetTool()),
      env: noopEnv,
      systemPrompt: "OLD",
      contextReset: {
        maxPerMessage: -1,
        refresh: async () => ({ systemPrompt: "FRESH", skills: {} }),
      },
    });
    const session = new Session(agent);

    await expect(
      (async () => {
        for await (const event of session.send("go")) {
          if (event.type === "context_reset") {
            throw new Error("reset boom");
          }
        }
      })(),
    ).rejects.toThrow("reset boom");

    // The history was REPLACED: no tool message answers the old call.
    expect(session.messages.filter((m) => m.role === "tool")).toEqual([]);
    expect(session.messages.some((m) => m.content.includes("Not run"))).toBe(false);
    expect(session.messages.some((m) => m.content.includes("Interrupted"))).toBe(false);
  });
});

describe("T5j (user skill): the consumer throws at the skill's tool_result", () => {
  test("the REAL activator result is in the history", async () => {
    const entry = {
      name: "deploy-app",
      location: "/s/deploy-app/SKILL.md",
      dir: "/s/deploy-app",
      files: [],
      filesTruncated: false,
      userInvocable: true,
    };
    const read = async (s: { name: string }) => ({ body: `STEPS for ${s.name}`, bodyLine: 1 });
    const agent = new Agent({
      model: new ScriptedProvider([[{ type: "text", delta: "deploying" }]]),
      tools: new ToolRegistry(),
      env: noopEnv,
      systemPrompt: "SYS",
      skills: createSkillActivator([entry], read),
    });
    const session = new Session(agent);

    await expect(
      (async () => {
        for await (const event of session.send("x", undefined, { skill: "deploy-app" })) {
          if (event.type === "tool_result") {
            throw new Error("skill boom");
          }
        }
      })(),
    ).rejects.toThrow("skill boom");

    const answers = session.messages.filter((m) => m.role === "tool");
    expect(answers).toHaveLength(1);
    expect(answers[0]?.content).toContain("STEPS for deploy-app");
    expect(answers[0]?.content).not.toBe(INTERRUPTED);
    expectWellFormed(session.messages);
  });
});

describe("T5f (cancel, a guard): an abort mid-tool adds NO Part B note", () => {
  test("the history is the cancel path's own: CANCELLED notes only", async () => {
    const CANCELLED = "Cancelled by the user before this tool ran.";
    const controller = new AbortController();
    const tool: Tool<{ path: string }> = {
      name: "read",
      description: "read",
      inputSchema: z.object({ path: z.string() }),
      permission: "none",
      async execute() {
        // The user cancels while this runs: the next call never starts.
        controller.abort();
        return { content: "content of a.ts" };
      },
    };
    const agent = new Agent({
      model: new ScriptedProvider([[call("c1", "read", "a.ts"), call("c2", "read", "b.ts")]]),
      tools: new ToolRegistry().register(tool),
      env: noopEnv,
    });
    const session = new Session(agent);
    const events = await collect(session.send("go", controller.signal));

    expect(events.some((e) => e.type === "turn_end" && e.reason === "cancelled")).toBe(true);
    expect(shape(session.messages)).toEqual([
      "user|||go",
      "assistant|c1,c2||",
      "tool||c1|content of a.ts",
      `tool||c2|${CANCELLED}`,
    ]);
    expect(JSON.stringify(session.messages)).not.toContain("Interrupted:");
    expect(JSON.stringify(session.messages)).not.toContain("Not run:");
  });
});
