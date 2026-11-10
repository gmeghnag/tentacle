/**
 * feat/subagent-panel (task 7) daemon half: `HostedSession.messageSubagent` /
 * `killSubagent` — the user's text into a running child's inbox, its notice to
 * every attached client, its `[user → sa-N]` note for the parent, and a stop.
 *
 * Both are synchronous and hold no lock (AGENTS §7), so the last case pins that
 * one answers while a `session/prompt` is in flight.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session, createSubagentRunner } from "@tentacle/agent";
import {
  AGENT_INBOX_MAX,
  AgentJobs,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import type { KnownSessionUpdateParams } from "@tentacle/protocol";
import { ToolRegistry, createTaskTool } from "@tentacle/tools";
import { z } from "zod";
import { HostedSession } from "../src/hosted-session.ts";

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) await macro();
}
const text = (delta: string): StreamEvent => ({ type: "text", delta });
const done: StreamEvent = { type: "done" };
const call = (id: string, name: string, args: unknown = {}): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: JSON.stringify(args) },
});
const launch = (id: string, description: string): StreamEvent =>
  call(id, "agent_task", { description, prompt: "go", background: true });

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
const empty = z.object({});
const free: Tool = {
  name: "free_read",
  description: "d",
  inputSchema: empty,
  permission: "none",
  execute: async () => ({ content: "read" }),
};

function rig(opts: { attach?: boolean; wake?: boolean } = {}) {
  const parent = new Model();
  const child = new Model();
  const permissions = new PermissionBroker();
  const requestPermission = permissions.request.bind(permissions);
  const agentJobs = new AgentJobs(2);
  const childTools = new ToolRegistry().register(free);
  const { run, types } = createSubagentRunner({
    model: child,
    env,
    tools: childTools,
    requestPermission,
  });
  const parentTools = new ToolRegistry()
    .register(free)
    .register(createTaskTool(run, types, { background: agentJobs }));
  const agent = new Agent({
    model: parent,
    tools: parentTools,
    env,
    agentJobs,
    systemPrompt: "s",
    maxIterations: 8,
    requestPermission,
  });
  const session = new Session(agent, "s1", {});
  const hosted = new HostedSession(
    "s1",
    session,
    permissions,
    undefined,
    {},
    undefined,
    Date.now,
    undefined,
    {},
    opts.wake === false ? undefined : {},
    {},
    agentJobs,
  );
  const frames: KnownSessionUpdateParams[] = [];
  const frames2: KnownSessionUpdateParams[] = [];
  if (opts.attach !== false) {
    hosted.attach({ send: (p) => frames.push(p) });
    hosted.attach({ send: (p) => frames2.push(p) });
  }
  return { parent, child, permissions, hosted, frames, frames2, agentJobs, session, agent };
}
type Rig = ReturnType<typeof rig>;

const prompt = (r: Rig, id: string, t = "go") => r.hosted.prompt(id, [{ type: "text", text: t }]);
const notes = (f: readonly KnownSessionUpdateParams[]) =>
  f.flatMap((p) => (p.update.type === "subagent_message" ? [p.update] : []));
const typesOf = (f: readonly KnownSessionUpdateParams[]) => f.map((p) => p.update.type);

/** Start sa-1 in the background and leave it running, held by `gate`. */
async function runningChild(r: Rig, gate: Promise<void>): Promise<void> {
  r.parent.steps.push([launch("c1", "map repo"), done], [text("started"), done]);
  r.child.steps.push({ gate, events: [text("CHILD DONE"), done] });
  prompt(r, "T1");
  await settle();
}

describe("T-D1: an accepted message", () => {
  test("the child's inbox holds `[message from the user] …`, both clients get the update, the agent holds the note", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    expect(r.agentJobs.list().map((j) => j.agentId)).toEqual(["sa-1"]);

    const result = r.hosted.messageSubagent("sa-1", "skip the tests folder");
    expect(result).toEqual({ ok: true });

    // 1. The child's own inbox text: the SAME seam the model's tool uses.
    const childInbox = (
      r.agentJobs as unknown as { running: Map<string, { inbox: { drain(): string[] } }> }
    ).running.get("sa-1")?.inbox;
    expect(childInbox?.drain()).toEqual(["[message from the user] skip the tests folder"]);

    // 2. Every attached client gets one display update (the sender too: one render path).
    expect(notes(r.frames)).toEqual([
      { type: "subagent_message", agentId: "sa-1", text: "skip the tests folder" },
    ]);
    expect(notes(r.frames2)).toHaveLength(1);

    // 3. The parent agent holds the note, and it wakes nobody.
    expect(r.agent.pendingExitCount).toBe(0);

    // 4. At the NEXT turn the model reads it, right after the user's message.
    //    (The child is still running: the flush point is a turn's start.)
    r.parent.steps.push([text("ok"), done]);
    prompt(r, "T2", "and update the README");
    await settle(10);
    const last = r.parent.seen.at(-1)?.messages.map((m) => m.content) ?? [];
    const at = last.findIndex((c) => c === "and update the README");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(last[at + 1]?.split("\n")[0]).toBe("[user → sa-1] skip the tests folder");
    gate.resolve();
    await settle(12);
  });
});

describe("T-D2: a refused message", () => {
  test("an unknown id → the reason, no update, no note", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    const before = notes(r.frames).length;
    const result = r.hosted.messageSubagent("sa-9", "hello");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not a running background sub-agent");
    expect(notes(r.frames)).toHaveLength(before);
    expect(r.agent.pendingExitCount).toBe(0);
    gate.resolve();
    await settle(10);
  });

  test("a full inbox → the reason, no update, no note", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    // Fill the child's inbox to its cap (through the same seam).
    for (let i = 0; i < AGENT_INBOX_MAX; i++) {
      expect(r.hosted.messageSubagent("sa-1", `m${i}`).ok).toBe(true);
    }
    const before = notes(r.frames).length;
    const result = r.hosted.messageSubagent("sa-1", "one too many");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("unread messages");
    // Nothing was emitted for the refused one (the accepted ones still were).
    expect(notes(r.frames)).toHaveLength(before);
    gate.resolve();
    await settle(10);
  });

  test("no runtime (a mode without background sub-agents) → a typed refusal", async () => {
    const permissions = new PermissionBroker();
    const agent = new Agent({
      model: new Model(),
      tools: new ToolRegistry().register(free),
      env,
      systemPrompt: "s",
    });
    const hosted = new HostedSession(
      "s2",
      new Session(agent, "s2", {}),
      permissions,
      undefined,
      {},
      undefined,
      Date.now,
      undefined,
      {},
      {},
      {},
    );
    const result = hosted.messageSubagent("sa-1", "hi");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not available");
    expect(hosted.killSubagent("sa-1")).toEqual({ killed: false });
  });
});

describe("T-D3: agent_kill", () => {
  test("the child is aborted, `{killed: true}`, and a second call is `{killed: false}`", async () => {
    const r = rig({ wake: false });
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    expect(r.hosted.killSubagent("sa-1")).toEqual({ killed: true });
    gate.resolve();
    await settle(12);
    expect(r.hosted.agentJobsRunning()).toEqual([]);
    expect(r.hosted.killSubagent("sa-1")).toEqual({ killed: false });
    // The exit still follows the existing path (its note, its row's death).
    const exit = r.frames.map((p) => p.update).find((u) => u.type === "background_exit");
    expect(exit).toMatchObject({ jobId: "sa-1", agent: { stopReason: "cancelled" } });
  });
});

describe("T-D4: neither handler waits on a turn (AGENTS §7: the peer is not serialized)", () => {
  test("messageSubagent answers while a session/prompt is in flight", async () => {
    const r = rig();
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    // A turn is now running (the wake turn over the child's end is not: hold a
    // prompt instead) — start one whose model round never settles.
    const hold = Promise.withResolvers<void>();
    r.parent.steps.push({ gate: hold.promise, events: [text("late"), done] });
    prompt(r, "T3", "a long one");
    await settle();
    expect(r.hosted.running).toBe(true);
    // Synchronous, never awaited: it returns even with the turn stuck.
    expect(r.hosted.messageSubagent("sa-1", "while you work")).toEqual({ ok: true });
    expect(r.hosted.killSubagent("sa-1")).toEqual({ killed: true });
    expect(typesOf(r.frames)).toContain("subagent_message");
    hold.resolve();
    gate.resolve();
    await settle(12);
  });
});
