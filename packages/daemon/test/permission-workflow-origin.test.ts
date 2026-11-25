/**
 * docs/fix/mobile-ask-surfaces.md S1b — the daemon FORWARDS the requester's
 * structured `workflow` origin on BOTH ask paths: a turn's own ask
 * (`awaitDecision`) and a background child's (`awaitBackgroundDecision`, where
 * every workflow step's ask lands: `stepRequester` always sets `agent.id`).
 * Mutation: drop the new argument at either `toPermissionRequestUpdate` call →
 * the frame loses `workflow` and that surface falls back to parsing the label.
 */
import { describe, expect, test } from "bun:test";
import { Agent, Session } from "@tentacle/agent";
import { type ExecutionEnvironment, PermissionBroker, type Tool } from "@tentacle/core";
import type { KnownSessionUpdateParams, PermissionRequestUpdate } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import { HostedSession } from "../src/hosted-session.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** Drain macrotasks: the ask's write path is async (`persisted().then`). */
async function settle(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 2));
}

const WF = { name: "rassegna", runId: "wf-1", stepId: "generate", index: 1, count: 5 };

/**
 * A session whose one tool asks for permission with a `workflow` in its options
 * (and, with `agentId`, the way a step's ask arrives: tagged as a child's).
 */
function rig(agentId?: string) {
  const permissions = new PermissionBroker();
  // A background child's ask settles with the CHILD's signal (H3): without one
  // it is refused at once, never shown.
  const child = new AbortController();
  const asker: Tool = {
    name: "asker",
    description: "asks",
    inputSchema: z.object({}).passthrough(),
    permission: "none",
    execute: async () => {
      void permissions.request(
        { tool: "shell", level: "ask", title: "Run", input: {} },
        {
          toolCallId: "c1",
          ...(agentId !== undefined
            ? {
                agent: { type: "workflow", description: "rassegna/generate", id: agentId },
                signal: child.signal,
              }
            : {}),
          workflow: WF,
        },
      );
      return { content: "asked" };
    },
  };
  const agent = new Agent({
    model: {
      id: "one",
      async *stream() {
        yield {
          type: "tool_call" as const,
          toolCall: { id: "c1", name: "asker", arguments: "{}" },
        };
        yield { type: "done" as const };
      },
    },
    tools: new ToolRegistry().register(asker),
    env,
    requestPermission: (req, options) => permissions.request(req, options),
  });
  const hosted = new HostedSession("s1", new Session(agent), permissions);
  const frames: KnownSessionUpdateParams[] = [];
  hosted.attach({ send: (p) => frames.push(p) });
  const asks = (): PermissionRequestUpdate[] =>
    frames.flatMap((p) => (p.update.type === "permission_request" ? [p.update] : []));
  return { hosted, frames, asks };
}

describe("both ask paths carry the workflow origin", () => {
  test("a turn's own ask (`awaitDecision`): the frame names the workflow, its run, step and position", async () => {
    const r = rig();
    await r.hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await settle();
    const [ask] = r.asks();
    if (!ask) throw new Error("no permission_request");
    expect(ask.workflow).toEqual(WF);
    // No sub-agent label on this path: the origin is the only attribution.
    expect(ask.agent).toBeUndefined();
    r.hosted.close();
  });

  test("a background child's ask (`awaitBackgroundDecision`): the same, beside its agent label", async () => {
    const r = rig("wf-1.generate");
    await r.hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await settle();
    const [ask] = r.asks();
    if (!ask) throw new Error("no permission_request");
    expect(ask.workflow).toEqual(WF);
    expect(ask.agent).toEqual({
      type: "workflow",
      description: "rassegna/generate",
      id: "wf-1.generate",
    });
    r.hosted.close();
  });

  test("an ask with no workflow in its options emits no `workflow` key at all", async () => {
    // Mutation: a default `{ name: "" }` on either path → the key appears on
    // every ask, and a client draws a workflow glyph for the main agent.
    const r = rigNoWorkflow();
    await r.hosted.prompt("T1", [{ type: "text", text: "go" }]);
    await settle();
    const [ask] = r.asks();
    if (!ask) throw new Error("no permission_request");
    expect("workflow" in ask).toBe(false);
    r.hosted.close();
  });
});

/** The same rig, minus the origin: today's ask. */
function rigNoWorkflow() {
  const permissions = new PermissionBroker();
  const asker: Tool = {
    name: "asker",
    description: "asks",
    inputSchema: z.object({}).passthrough(),
    permission: "none",
    execute: async () => {
      void permissions.request({ tool: "shell", level: "ask", title: "Run", input: {} });
      return { content: "asked" };
    },
  };
  const agent = new Agent({
    model: {
      id: "one",
      async *stream() {
        yield {
          type: "tool_call" as const,
          toolCall: { id: "c1", name: "asker", arguments: "{}" },
        };
        yield { type: "done" as const };
      },
    },
    tools: new ToolRegistry().register(asker),
    env,
    requestPermission: (req, options) => permissions.request(req, options),
  });
  const hosted = new HostedSession("s1", new Session(agent), permissions);
  const frames: KnownSessionUpdateParams[] = [];
  hosted.attach({ send: (p) => frames.push(p) });
  const asks = (): PermissionRequestUpdate[] =>
    frames.flatMap((p) => (p.update.type === "permission_request" ? [p.update] : []));
  return { hosted, frames, asks };
}
