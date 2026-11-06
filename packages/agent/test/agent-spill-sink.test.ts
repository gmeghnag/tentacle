// docs/fix/tool-output-location.md: the spill goes through its own sink, never
// the workspace-confined env, and never collides.
import { describe, expect, test } from "bun:test";
import type {
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  StreamEvent,
  Tool,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { Agent, type AgentEvent } from "../src/agent.ts";
import { spillLargeOutput } from "../src/result-pipeline.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const big = "LINE\n".repeat(5000);
const noisy: Tool = {
  name: "noisy",
  description: "returns a lot",
  inputSchema: z.object({}),
  permission: "none",
  execute: async () => ({ content: big, isError: false }),
};
const call = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name: "noisy", arguments: "{}" },
});
const done: StreamEvent[] = [{ type: "text", delta: "done" }, { type: "done" }];

type Write = (sid: string, tool: string, id: string, contents: string) => Promise<string | null>;

function rig(script: readonly (readonly StreamEvent[])[], write?: Write) {
  const envWrites: string[] = [];
  const env: ExecutionEnvironment = {
    id: "fake",
    exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
    readFile: () => Promise.resolve(""),
    writeFile: async (path) => {
      envWrites.push(path);
    },
  };
  const agent = new Agent({
    model: new ScriptedProvider(script),
    tools: new ToolRegistry().register(noisy),
    env,
    ...(write ? { toolOutput: { write } } : {}),
    resultTransforms: [spillLargeOutput({ maxInlineChars: 500 })],
  });
  return { agent, envWrites };
}

async function drain(agent: Agent): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.run("sess-1", [{ role: "user", content: "go" }])) {
    events.push(event);
  }
  return events;
}

function firstResult(events: AgentEvent[]): string {
  const result = events.find((e) => e.type === "tool_result");
  return result?.type === "tool_result" ? result.result.content : "";
}

describe("Agent spills through a ToolOutputSink", () => {
  test("the sink gets (session, tool, call id, full output); env is not written", async () => {
    const seen: string[][] = [];
    const { agent, envWrites } = rig([[call("c1")], done], async (sid, tool, id, contents) => {
      seen.push([sid, tool, id, contents]);
      return "/cache/x/noisy-c1.txt";
    });
    const events = await drain(agent);
    expect(seen).toEqual([["sess-1", "noisy", "c1", big]]);
    expect(envWrites).toEqual([]);
    expect(firstResult(events)).toContain("/cache/x/noisy-c1.txt");
  });

  test("a sink that rejects: the turn completes with the 'could not be saved' truncation", async () => {
    const { agent } = rig([[call("c1")], done], () => Promise.reject(new Error("disk full")));
    const events = await drain(agent);
    expect(firstResult(events)).toContain("could not be saved");
    expect(events.some((e) => e.type === "turn_end" && e.reason === "end_turn")).toBe(true);
  });

  // Task-7 review NIT 5: a server may reuse a call id; two calls of one
  // message (or of two turns) with one id must not share a file.
  test("two calls with the same id in one message reach the sink under two names", async () => {
    const ids: string[] = [];
    const { agent } = rig([[call("dup"), call("dup")], done], async (_sid, _tool, id) => {
      ids.push(id);
      return `/cache/${id}`;
    });
    await drain(agent);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });

  test("the first use of an id keeps the plain name (no churn for the common case)", async () => {
    const ids: string[] = [];
    const { agent } = rig([[call("c1")], done], async (_sid, _tool, id) => {
      ids.push(id);
      return `/cache/${id}`;
    });
    await drain(agent);
    expect(ids).toEqual(["c1"]);
  });

  test("the same collision on the env fallback path is avoided too", async () => {
    const { agent, envWrites } = rig([[call("dup"), call("dup")], done]);
    await drain(agent);
    expect(envWrites).toHaveLength(2);
    expect(new Set(envWrites).size).toBe(2);
  });
});
