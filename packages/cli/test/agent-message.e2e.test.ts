import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createSubagentRunner } from "@tentacle/agent";
import {
  AgentJobs,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore, SessionHost } from "@tentacle/daemon";
import { ToolRegistry, createAgentControlTool, createTaskTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

// docs/feat/agent-message.md T14/T15, end to end over the REAL
// `createLocalRuntime` ↔ `Connection` stack: the agent launches a background
// child, writes into it with `agent_message`, and the child reads the text at
// its next model step. One-way: no extra parent turn is started by the message
// (no wake, eval B3).
//
// Mutation (non-vacuity, AGENTS §9): wire the tool to a FRESH `AgentJobs`
// instead of the session's → T14 fails (the id is unknown there).

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await macro();
}
const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const bgTask = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_task",
    arguments: JSON.stringify({ description: "map repo", prompt: "go", background: true }),
  },
});
// docs/feat/agent-status.md ("Merge into agent_control"): the parent writes into
// the child with `agent_control{action:"message"}` — the same delivery path.
const message = (id: string, agentId: string, body: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_control",
    arguments: JSON.stringify({ action: "message", agent_id: agentId, text: body }),
  },
});
type Step = readonly StreamEvent[] | { gate: Promise<void>; events: readonly StreamEvent[] };
class Model implements ModelProvider {
  readonly id = "m";
  readonly steps: Step[] = [];
  readonly seen: ChatRequest[] = [];
  async *stream(req: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(req);
    const s = this.steps.shift() ?? [text("ok"), done];
    if ("gate" in s) {
      await s.gate;
      for (const e of s.events) yield e;
      return;
    }
    for (const e of s) yield e;
  }
}
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
const roles = (req: ChatRequest) => req.messages.map((m) => `${m.role}:${String(m.content)}`);

function rig(freshJobsForTool = false) {
  const parent = new Model();
  const child = new Model();
  const runtimes: AgentJobs[] = [];
  // The session's runtime, recorded the moment the agent is built, so a
  // MUTATION can hand the tool a different one (non-vacuity check).
  let sessionJobs: AgentJobs | undefined;
  const host = new SessionHost({
    defaultCwd: "/w",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const requestPermission = permissions.request.bind(permissions);
      const agentJobs = new AgentJobs(2);
      sessionJobs = agentJobs;
      runtimes.push(agentJobs);
      const { run, types } = createSubagentRunner({
        model: child,
        env,
        tools: new ToolRegistry(),
        requestPermission,
      });
      const tools = new ToolRegistry()
        .register(createTaskTool(run, types, { background: agentJobs }))
        .register(createAgentControlTool(freshJobsForTool ? new AgentJobs(2) : agentJobs));
      return {
        agent: new Agent({
          model: parent,
          tools,
          env,
          agentJobs,
          systemPrompt: "s",
          maxIterations: 8,
          requestPermission,
        }),
        permissions,
        agentJobs,
      };
    },
  });
  return { parent, child, host, runtimes, sessionJobs: () => sessionJobs };
}

async function runtimeOf(host: SessionHost, dir: string) {
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const store = new LogSessionStore(join(dir, "sessions"));
  const saver = new SessionSaver(store, () => {});
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver,
    cwd: dir,
    model: "m",
    resume: null,
  });
  return { runtime, connection };
}

test("T14: agent_message reaches the running child; no parent turn is started", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-message-e2e-"));
  try {
    const r = rig();
    const { runtime, connection } = await runtimeOf(r.host, dir);
    const controller = runtime.createSession();
    const childGate = Promise.withResolvers<void>();
    // Parent: launch the child, then message it, then end.
    r.parent.steps.push([bgTask("c1"), done], [message("c2", "sa-1", "also check X"), done]);
    // The child holds its first round until released: exactly the window in
    // which an agent's `agent_message` is useful.
    r.child.steps.push({ gate: childGate.promise, events: [text("THE REPORT"), done] });

    const results: string[] = [];
    const sending = (async () => {
      for await (const e of controller.send("go")) {
        if (e.type === "tool_result") {
          results.push(e.result.content);
        }
      }
    })();
    await settle();
    // The parent's SECOND request carries the launch result and runs the message.
    expect(r.parent.seen.length).toBeGreaterThanOrEqual(2);
    expect(r.runtimes[0]?.rows().map((row) => row.id)).toEqual(["sa-1"]);

    childGate.resolve();
    await settle(16);
    await sending;
    // The client saw "queued for sa-1 …", never "delivered".
    expect(
      results.some(
        (c) =>
          c ===
          "queued for sa-1: it reads it before its next model step. No reply comes back; its report still arrives as a [background] note.",
      ),
    ).toBe(true);
    // The CHILD's next request carries the text, as a user message.
    expect(r.child.seen.length).toBeGreaterThanOrEqual(2);
    expect(roles(r.child.seen.at(-1) as ChatRequest)).toContain(
      "user:[message from the parent agent] also check X",
    );
    expect((r.child.seen.at(-1) as ChatRequest).messages.at(-1)?.role).toBe("user");

    // The child ended after the parent's turn did: its report reaches the NEXT
    // parent request as the ordinary `[background]` note (6a's delivery).
    r.parent.steps.push([text("ok"), done]);
    const before = r.parent.seen.length;
    for await (const _ of controller.send("anything else")) {
      // drain
    }
    await settle(8);
    const note = roles(r.parent.seen.at(-1) as ChatRequest).at(-1) ?? "";
    expect(note).toContain("THE REPORT");
    expect(note).toContain("[background]");
    // NO WAKE: the message started no extra parent turn — the parent ran the
    // two rounds the script gave it and no more (3 requests: 2 rounds + the
    // one the person's second `send` added).
    expect(r.parent.seen.length).toBe(before + 1);
    runtime.dispose();
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T15: agent_message to an id that is not running is a tool ERROR saying nothing was sent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-message-e2e-"));
  try {
    const r = rig();
    const { runtime, connection } = await runtimeOf(r.host, dir);
    const controller = runtime.createSession();
    r.parent.steps.push([bgTask("c1"), done], [message("c2", "sa-9", "hi"), done]);
    r.child.steps.push([text("THE REPORT"), done]);

    const results: { content: string; isError?: boolean }[] = [];
    for await (const e of controller.send("go")) {
      if (e.type === "tool_result") {
        results.push({ content: e.result.content, isError: e.result.isError });
      }
    }
    await settle(8);
    const refused = results.find((x) => x.content.includes("sa-9"));
    expect(refused?.content).toContain(
      "sa-9 is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.",
    );
    expect(refused?.isError).toBe(true);
    runtime.dispose();
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
