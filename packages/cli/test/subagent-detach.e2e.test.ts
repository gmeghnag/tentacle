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
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

// docs/feat/subagent-detach.md T31/T32, end to end over the REAL
// `createLocalRuntime` ↔ `Connection` stack: a steer typed while a foreground
// `agent_task` runs moves it to the background, and the person's text reaches
// the model in the same round — with the moved result BEFORE it.
//
// Mutation (red, verified): move `detachForeground()` in `enqueue` after the
// `session.enqueue` but onto a microtask (`queueMicrotask`) → T31's
// "one commit later" order breaks; drop it entirely → the whole file fails.

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await macro();
}
const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const fgTask = (id: string): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id,
    name: "agent_task",
    arguments: JSON.stringify({ description: "map repo", prompt: "go" }),
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

function rig() {
  const parent = new Model();
  const child = new Model();
  const runtimes: AgentJobs[] = [];
  const host = new SessionHost({
    defaultCwd: "/w",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const requestPermission = permissions.request.bind(permissions);
      const agentJobs = new AgentJobs(2);
      runtimes.push(agentJobs);
      const { run, types } = createSubagentRunner({
        model: child,
        env,
        tools: new ToolRegistry(),
        requestPermission,
      });
      const tools = new ToolRegistry().register(
        createTaskTool(run, types, { background: agentJobs }),
      );
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
  return { parent, child, host, runtimes };
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
  return { runtime, connection, store };
}

test("T31: a steer over RPC moves the running foreground child; the model sees the moved result then the steer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-detach-e2e-"));
  try {
    const r = rig();
    const { runtime, connection } = await runtimeOf(r.host, dir);
    const controller = runtime.createSession();
    const gate = Promise.withResolvers<void>();
    r.parent.steps.push([fgTask("c1"), done], [text("carried on"), done]);
    r.child.steps.push({ gate: gate.promise, events: [text("THE REPORT"), done] });

    const events: string[] = [];
    const sending = (async () => {
      for await (const e of controller.send("go")) {
        events.push(e.type);
      }
    })();
    // The child holds the round: ONE model request so far.
    await settle();
    expect(r.parent.seen).toHaveLength(1);

    // The person writes while it runs. The real client → daemon path.
    await controller.enqueue("steer text");
    await settle(6);

    // The client saw the move: `subagent_end{background}` and the tool result.
    expect(events).toContain("subagent_end");
    // The model's next request carries the moved result, then the steer — in that order.
    const tail = roles(r.parent.seen.at(-1) as ChatRequest).slice(-2);
    expect(tail[0]).toContain("moved to background as sa-1: map repo");
    expect(tail[1]).toBe("user:steer text");
    // The child runs in the background now, and `subagents` lists it.
    expect(r.runtimes[0]?.rows().map((row) => row.id)).toEqual(["sa-1"]);

    gate.resolve();
    await settle(14);
    await sending;
    // The child ended after the turn did: the exit note reaches the NEXT model
    // request (the same delivery 6a gives a background child).
    r.parent.steps.push([text("ok"), done]);
    for await (const _ of controller.send("anything else")) {
      // drain
    }
    await settle(6);
    const note = roles(r.parent.seen.at(-1) as ChatRequest).at(-1) ?? "";
    expect(note).toContain("THE REPORT");
    runtime.dispose();
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("T32: send-now keeps the child's work; its report still arrives", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-detach-e2e-"));
  try {
    const r = rig();
    const { runtime, connection } = await runtimeOf(r.host, dir);
    const controller = runtime.createSession();
    const gate = Promise.withResolvers<void>();
    r.parent.steps.push([fgTask("c1"), done], [text("carried on"), done], [text("ok"), done]);
    r.child.steps.push({ gate: gate.promise, events: [text("THE REPORT"), done] });

    const sending = (async () => {
      for await (const _ of controller.send("go")) {
        // drain
      }
    })();
    await settle();
    expect(r.parent.seen).toHaveLength(1);

    const next = await controller.sendNow([{ id: "m1", text: "do this instead" }], "turn");
    const fresh: string[] = [];
    for await (const e of next) {
      fresh.push(e.type);
    }
    await settle(6);
    // The child SURVIVED the cancel: it was unlinked from the turn first.
    expect(r.runtimes[0]?.rows().map((row) => row.id)).toEqual(["sa-1"]);
    // The successor's prompt reached the model, right after the moved tool result.
    const tail = roles(r.parent.seen.at(-1) as ChatRequest).slice(-2);
    expect(tail[0]).toContain("moved to background as sa-1");
    expect(tail[1]).toBe("user:do this instead");
    gate.resolve();
    await settle(14);
    await sending;
    // The child ended after the turn did: the exit note reaches the NEXT model
    // request, as for any background child (6a).
    r.parent.steps.push([text("ok"), done]);
    for await (const _ of controller.send("anything else")) {
      // drain
    }
    await settle(6);
    const note = roles(r.parent.seen.at(-1) as ChatRequest).at(-1) ?? "";
    expect(note).toContain("THE REPORT");
    runtime.dispose();
    connection.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
