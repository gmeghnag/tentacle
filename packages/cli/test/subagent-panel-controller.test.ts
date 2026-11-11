/**
 * fix/local-subagent-panel-unwired: the controller the TUI gets from
 * `createLocalRuntime` (plain `tentacle`'s worker, and `run`/`attach`) must
 * carry the sub-agent panel's three members the plain `RemoteSession` has —
 * `messageSubagent`, `killSubagent`, `onSubagentMessage`
 * (docs/feat/subagent-panel.md). The persisting wrapper dropped them, so the
 * App's guards (`App.tsx:1516`, `:1427`) refused every write to a child in
 * every local mode; only `connect` (a bare `RemoteSession`) worked.
 *
 * RED first (AGENTS §9): on the unfixed wrapper both the end-to-end cases and
 * the structural guard fail on the missing member, never on a compile error.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createSubagentRunner } from "@tentacle/agent";
import { RemoteSession } from "@tentacle/client";
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
import type { SessionController } from "@tentacle/tui";
import ts from "typescript";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

const macro = () => new Promise((r) => setTimeout(r, 2));
async function settle(n = 12): Promise<void> {
  for (let i = 0; i < n; i++) await macro();
}
async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out: ${String(pred)}`);
    }
    await macro();
  }
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
const roles = (req: ChatRequest | undefined) =>
  (req?.messages ?? []).map((m) => `${m.role}:${String(m.content)}`);

/** The real stack of plain `tentacle`: a real `Connection` + `createLocalRuntime`. */
async function runtimeOf(dir: string) {
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
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host);
  const store = new LogSessionStore(join(dir, "sessions"));
  const runtime = await createLocalRuntime({
    channel: clientCh,
    disposeTransport: () => connection.close(),
    permissions: new PermissionBroker(),
    saver: new SessionSaver(store, () => {}),
    cwd: dir,
    model: "m",
    resume: null,
  });
  const controller = runtime.createSession();
  return {
    parent,
    child,
    runtimes,
    controller,
    rows: () => runtimes[0]?.rows().map((row) => row.id) ?? [],
    close: () => {
      runtime.dispose();
      connection.close();
    },
  };
}

/** Launch sa-1 in the background and leave it running, held by `gate`. */
async function runningChild(
  r: Awaited<ReturnType<typeof runtimeOf>>,
  gate: Promise<void>,
): Promise<void> {
  r.parent.steps.push([bgTask("c1"), done]);
  r.child.steps.push({ gate, events: [text("still working"), done] });
  for await (const _ of r.controller.send("go")) {
    // drain
  }
  await until(() => r.rows().length === 1);
}

/**
 * The member is OPTIONAL on `SessionController`, so a missing one is a runtime
 * refusal (the App's guard), never a type error. Fail on that refusal by name.
 */
function required<K extends keyof SessionController>(
  session: SessionController,
  member: K,
): NonNullable<SessionController[K]> {
  const value = session[member];
  if (typeof value !== "function") {
    throw new Error(
      `the runtime's controller has no ${String(member)}: the sub-agent panel refuses every call here`,
    );
  }
  return value as NonNullable<SessionController[K]>;
}

test("the runtime's controller messages the running child, and the notice reaches onSubagentMessage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-panel-ctl-"));
  const r = await runtimeOf(dir);
  try {
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    expect(r.rows()).toEqual(["sa-1"]);

    const seen: { agentId: string; text: string }[] = [];
    const subscribe = required(r.controller, "onSubagentMessage");
    subscribe((n) => seen.push({ agentId: n.agentId, text: n.text }));

    const send = required(r.controller, "messageSubagent");
    expect(await send("sa-1", "skip the tests folder")).toEqual({ ok: true });
    // The daemon emits one `subagent_message` for every attached client, the
    // sender's included: the drawer's own row comes from here, not a local echo.
    await until(() => seen.length > 0);
    expect(seen[0]).toEqual({ agentId: "sa-1", text: "skip the tests folder" });

    // The child reads it at its next model step, as the user's message.
    gate.resolve();
    await until(() => r.child.seen.length >= 2);
    expect(roles(r.child.seen.at(-1))).toContain(
      "user:[message from the user] skip the tests folder",
    );
    // A refusal is a typed result, never a throw at the TUI.
    const refused = await send("sa-9", "hi");
    expect(refused.ok).toBe(false);
    await settle(6);
  } finally {
    r.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("the runtime's controller stops the running child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-panel-ctl-"));
  const r = await runtimeOf(dir);
  try {
    const gate = Promise.withResolvers<void>();
    await runningChild(r, gate.promise);
    const kill = required(r.controller, "killSubagent");
    expect(await kill("sa-1")).toEqual({ killed: true });
    // The abort the daemon raised ends the child's run (its held step resolves
    // as cancelled); the row leaves on the daemon's next list update.
    gate.resolve();
    await until(() => r.rows().length === 0);
    // The same decision the model's `agent_control{action:"kill"}` makes.
    expect(await kill("sa-1")).toEqual({ killed: false });
    await settle(8);
  } finally {
    r.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("GUARD: every `SessionController` member a `RemoteSession` has is on the runtime's controller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-panel-ctl-"));
  const r = await runtimeOf(dir);
  try {
    // Read the DECLARATION, not a copy: `SessionController` is what the App
    // holds, so a member added there must reach this wrapper too (the next
    // `messageSubagent` cannot be forgotten). Syntactic: no type checker needed,
    // and `in RemoteSession.prototype` handles an optional member either way.
    const file = new URL("../../tui/src/App.tsx", import.meta.url);
    const source = ts.createSourceFile(
      file.pathname,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );
    let iface: ts.InterfaceDeclaration | undefined;
    ts.forEachChild(source, (node) => {
      if (ts.isInterfaceDeclaration(node) && node.name.text === "SessionController") {
        iface = node;
      }
    });
    if (!iface) {
      throw new Error("no SessionController in packages/tui/src/App.tsx");
    }
    const declared: string[] = [];
    for (const member of (iface as ts.InterfaceDeclaration).members) {
      if ((ts.isPropertySignature(member) || ts.isMethodSignature(member)) && member.name) {
        if (ts.isIdentifier(member.name)) declared.push(member.name.text);
      }
    }
    // `settings`/`updateSettings` are the controller's own (a `run`/`attach`
    // laptop setting), not a `RemoteSession` member: only those the session has
    // are the wrapper's to forward.
    // The three exclusions are CONNECT-ONLY by construction, never forgotten
    // forwards: `sessions` (the `/sessions` directory, `connect.ts:253`) is what
    // reaches `detach`/`stayingRows` (`App.tsx:3135,3141`), and `daemonWakes`
    // (`connect.ts:188`) is what makes `autoAcceptsTurn` wider than the
    // `ownsTurn` the wrapper does forward. Adding one of them here without
    // wiring it is the only way this list may change; anything ELSE that falls
    // out of `forwarded` is a real gap and fails below.
    const connectOnly = new Set(["autoAcceptsTurn", "detach", "stayingRows"]);
    const forwarded = declared.filter(
      (name) => name in RemoteSession.prototype && !connectOnly.has(name),
    );
    expect(forwarded.length).toBeGreaterThan(20);
    // Presence, not `typeof function`: `sessionId` is a string and `open` a
    // method — an optional member that is present at all is wired.
    const missing = forwarded.filter(
      (name) => (r.controller as unknown as Record<string, unknown>)[name] === undefined,
    );
    expect(missing).toEqual([]);
  } finally {
    r.close();
    await rm(dir, { recursive: true, force: true });
  }
});
