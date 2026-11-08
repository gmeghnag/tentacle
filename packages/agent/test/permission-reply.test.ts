import { describe, expect, test } from "bun:test";
import type {
  ChatMessage,
  ChatRequest,
  ExecutionEnvironment,
  ModelProvider,
  PermissionResponse,
  StreamEvent,
  ToolResult,
} from "@tentacle/core";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { Agent, type AgentEvent } from "../src/agent.ts";
import type { ResultTransform } from "../src/result-pipeline.ts";
import { Session } from "../src/session.ts";
import { createSubagentRunner } from "../src/subagent.ts";

// docs/feat/permission-reply.md: a refusal WITH the person's reply — the
// model gets both in the call's `tool` result and the turn goes on.

const PLAIN = "Permission denied by the user: `shell` was not run.";
const REPLIED = [
  "Permission denied by the user: `shell` was not run. The user replied:",
  "why? try bun run build first",
  "Answer the user or change your approach; request this tool again only if you still need it.",
].join("\n");

function scripted(seen: ChatRequest[]): ModelProvider {
  const script: StreamEvent[][] = [
    [
      {
        type: "tool_call",
        toolCall: { id: "c1", name: "shell", arguments: '{"command":"rm -rf build"}' },
      },
      { type: "done" },
    ],
    [{ type: "text", delta: "ok, trying bun run build" }, { type: "done" }],
  ];
  let i = 0;
  return {
    id: "scripted",
    async *stream(req) {
      seen.push(req);
      for (const e of script[i++] ?? [{ type: "done" }]) yield e;
    },
  };
}

function env(ran: string[]): ExecutionEnvironment {
  return {
    id: "fake",
    async exec(command) {
      ran.push(command);
      return { stdout: "ran", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return "";
    },
    async writeFile() {},
  };
}

async function run(
  response: PermissionResponse,
  resultTransforms?: ResultTransform[],
): Promise<{ seen: ChatRequest[]; events: AgentEvent[]; history: ChatMessage[]; ran: string[] }> {
  const seen: ChatRequest[] = [];
  const ran: string[] = [];
  const agent = new Agent({
    model: scripted(seen),
    tools: new ToolRegistry().register(shellTool),
    env: env(ran),
    requestPermission: async () => response,
    ...(resultTransforms ? { resultTransforms } : {}),
  });
  const session = new Session(agent, "s1");
  const events: AgentEvent[] = [];
  for await (const e of session.send("go")) events.push(e);
  return { seen, events, history: [...session.messages], ran };
}

const toolMsg = (req: ChatRequest | undefined): ChatMessage | undefined =>
  req?.messages.find((m) => m.role === "tool");
const resultOf = (events: AgentEvent[]): ToolResult | undefined =>
  events.flatMap((e) => (e.type === "tool_result" ? [e.result] : []))[0];

describe("a refusal with the person's reply", () => {
  test("the model's second round sees the pinned denial + reply; the turn ends normally", async () => {
    const { seen, events, ran } = await run({
      allowed: false,
      message: "why? try bun run build first",
    });
    expect(seen.length).toBe(2);
    expect(toolMsg(seen[1])?.content).toBe(REPLIED);
    expect(ran).toEqual([]);
    const end = events.find((e) => e.type === "turn_end");
    expect(end?.type === "turn_end" ? end.reason : undefined).toBe("end_turn");
  });

  test("the result and the history carry the reply as data (denialReply)", async () => {
    const { events, history } = await run({ allowed: false, message: "try bun run build" });
    expect(resultOf(events)?.denialReply).toBe("try bun run build");
    const tool = history.find((m) => m.role === "tool");
    expect(tool?.denialReply).toBe("try bun run build");
  });

  test("a plain refusal stays byte-identical and carries no denialReply", async () => {
    const { seen, events, history } = await run({ allowed: false });
    expect(toolMsg(seen[1])?.content).toBe(PLAIN);
    expect(resultOf(events)?.denialReply).toBeUndefined();
    expect(history.some((m) => "denialReply" in m)).toBe(false);
  });

  test("a message with an approval is ignored: the tool runs, the text goes nowhere", async () => {
    const { seen, events, history, ran } = await run({
      allowed: true,
      scope: "once",
      message: "SHOULD-NOT-APPEAR",
    });
    expect(ran).toEqual(["rm -rf build"]);
    expect(JSON.stringify(seen)).not.toContain("SHOULD-NOT-APPEAR");
    expect(JSON.stringify(events)).not.toContain("SHOULD-NOT-APPEAR");
    expect(JSON.stringify(history)).not.toContain("SHOULD-NOT-APPEAR");
  });

  test("a transform that rewrites the denial drops the structured copy (the row never shows what the model did not see)", async () => {
    const redact: ResultTransform = (r) => ({
      ...r,
      content: r.content.replace("hunter2", "[REDACTED]"),
    });
    const { seen, events, history } = await run({ allowed: false, message: "pw is hunter2" }, [
      redact,
    ]);
    expect(toolMsg(seen[1])?.content).toContain("pw is [REDACTED]");
    expect(resultOf(events)?.denialReply).toBeUndefined();
    expect(history.find((m) => m.role === "tool")?.denialReply).toBeUndefined();
  });

  test("an identity transform keeps it", async () => {
    const same: ResultTransform = (r) => ({ ...r });
    const { history } = await run({ allowed: false, message: "nope" }, [same]);
    expect(history.find((m) => m.role === "tool")?.denialReply).toBe("nope");
  });

  test("a sub-agent's refusal with a reply: the CHILD's model gets the person's words (fix round 1 F3)", async () => {
    const seen: ChatRequest[] = [];
    const ran: string[] = [];
    const { run: runChild } = createSubagentRunner({
      model: scripted(seen),
      env: env(ran),
      tools: new ToolRegistry().register(shellTool),
      requestPermission: async () => ({ allowed: false, message: "why? try bun run build first" }),
    });
    await runChild({ description: "d", prompt: "clean", type: "general" });
    expect(ran).toEqual([]);
    expect(toolMsg(seen[1])?.content).toBe(REPLIED);
    expect(toolMsg(seen[1])?.denialReply).toBe("why? try bun run build first");
  });
});
