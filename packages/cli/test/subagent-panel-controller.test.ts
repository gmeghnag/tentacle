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
import { type RemoteClient, RemoteSession } from "@tentacle/client";
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
import { autoAcceptTest, ownRequest } from "@tentacle/tui";
import ts from "typescript";
import { createLocalRuntime, persistingController } from "../src/local-runtime.ts";
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

/**
 * `autoAcceptsTurn` is the ONE `SessionController` member a `RemoteSession` has
 * that the wrapper must NOT forward, for TWO reasons: the inner test is WIDER
 * than the wrapper's `ownsTurn` on a trusted `serve` (`daemonWakes`, set only by
 * `connect`: it also accepts the session's own wake turns), AND NARROWER on an
 * adopted run turn (`adoptTurn`): `ownsTurn` is `turnId === adoptedTurn ||
 * inner.ownsTurn(turnId)` (`local-runtime.ts:594-595`), while
 * `RemoteSession.autoAcceptsTurn` knows nothing of the adopted turn. The only
 * safe wiring shape is therefore `ownsTurn(t) || inner.autoAcceptsTurn(t)` —
 * never a plain forward, which `autoAcceptTest` (`permission-ui.ts:97`) would
 * PREFER over `ownsTurn`, holding every ask of the run's own turn for a human
 * who is not there. This pins the adopted-turn half on the REAL wrapper.
 */
test("auto-accept answers the adopted run turn's asks through the REAL wrapper (a plain `autoAcceptsTurn` forward would not)", () => {
  // A run turn this client did not mint (its relay did: `attach-run.ts:368`).
  const runTurn = "77777777-7777-4777-8777-777777777777";
  const inner = {
    ownsTurn: () => false, // a bare `RemoteSession` under `attach`: a foreign turn
    autoAcceptsTurn: (turnId: string) => inner.ownsTurn(turnId), // as the REAL one: `ownsTurn || …`
    onTitle: () => () => {},
    watch: () => () => {},
    readBack: async () => null,
  } as unknown as RemoteSession;
  const ctl = persistingController(
    inner,
    () => {},
    () => {},
    { source: "auto" },
    runTurn,
  );
  // Whatever the App feeds the broker (`App.tsx:695`): the WIDEST test offered.
  const test = autoAcceptTest(ctl);
  if (!test) {
    throw new Error("the runtime's controller offers no own-vs-foreign test at all");
  }
  expect(ctl.ownsTurn(runTurn)).toBe(true);
  expect(inner.autoAcceptsTurn(runTurn)).toBe(false);
  expect(test(runTurn)).toBe(true);
  expect(ownRequest(runTurn, test)).toBe(true);
  // A turn nobody here owns is still foreign: auto-accept must not answer it.
  expect(test("88888888-8888-4888-8888-888888888888")).toBe(false);
});

test("GUARD: every `SessionController` member a `RemoteSession` has is on the runtime's controller", async () => {
  const dir = await mkdtemp(join(tmpdir(), "subagent-panel-ctl-"));
  const r = await runtimeOf(dir);
  try {
    // Read the DECLARATION, not a copy: `SessionController` is what the App
    // holds, so a member added there must reach this wrapper too (the next
    // `messageSubagent` cannot be forgotten). Syntactic: no type checker needed.
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
    // are the wrapper's to forward (`undefined` for those two below).
    //
    // Selected off a real INSTANCE, never `RemoteSession.prototype`: a member
    // written as a constructor-bound arrow property — this repo's own fix for
    // the unbound-`this` class (docs/fix/clear-connect-unbound.md) — is absent
    // from the prototype but present on every session. Selecting by the
    // prototype would silently drop such a member from this guard, leaving the
    // original bug (a forward dropped, the App refusing every call) green.
    //
    // The three exclusions are CONNECT-ONLY by construction, never forgotten
    // forwards: `sessions` (the `/sessions` directory, `connect.ts:253`) is what
    // reaches `detach`/`stayingRows` (`App.tsx:3135,3141`); and
    // `autoAcceptsTurn` MUST NOT be forwarded (`remote-session.ts:293-295`: it is
    // wider than `ownsTurn` only under `daemonWakes`, `connect.ts:188`, and
    // NARROWER than the wrapper's `ownsTurn` under `adoptTurn`,
    // `local-runtime.ts:594-595`, `attach-run.ts:368` — `autoAcceptTest`
    // (`permission-ui.ts:97`) prefers it, so a naive forward stalls `attach`
    // auto-accept; pinned by the test below). Adding one of them here without
    // wiring it is the only way this list may change; anything ELSE that falls
    // out of `forwarded` is a real gap and fails below.
    // `settings`/`updateSettings` are the controller's own (a `run`/`attach`
    // laptop setting), not a `RemoteSession` member: only those the session has
    // are the wrapper's to forward (`undefined` for those two below).
    //
    // Selected off a real INSTANCE, never `RemoteSession.prototype`: a member
    // written as a constructor-bound arrow property — this repo's own fix for
    // the unbound-`this` class (docs/fix/clear-connect-unbound.md) — is absent
    // from the prototype but present on every session. Selecting by the
    // prototype would silently drop such a member from this guard, leaving the
    // original bug (a forward dropped, the App refusing every call) green.
    const session: RemoteSession = new RemoteSession({} as unknown as RemoteClient);
    expect(session).toBeInstanceOf(RemoteSession);
    //
    // The three exclusions are CONNECT-ONLY by construction, never forgotten
    // forwards: `sessions` (the `/sessions` directory, `connect.ts:253`) is what
    // reaches `detach`/`stayingRows` (`App.tsx:3135,3141`); and
    // `autoAcceptsTurn` MUST NOT be forwarded (`remote-session.ts:293-295`: it is
    // wider than `ownsTurn` only under `daemonWakes`, `connect.ts:188`, and
    // NARROWER than the wrapper's `ownsTurn` under `adoptTurn`,
    // `local-runtime.ts:594-595`, `attach-run.ts:368` — `autoAcceptTest`
    // (`permission-ui.ts:97`) prefers it, so a naive forward stalls `attach`
    // auto-accept; pinned by the test below). Adding one of them here without
    // wiring it is the only way this list may change; anything ELSE that falls
    // out of `forwarded` is a real gap and fails below.
    const connectOnly = new Set(["autoAcceptsTurn", "detach", "stayingRows"]);
    const forwarded = declared.filter((name) => name in session && !connectOnly.has(name));
    // The exact set, not a floor: a `> 20` threshold left four members of slack,
    // so a shrinking selection passed silently. A member added to
    // `SessionController` and `RemoteSession` is a deliberate new entry here.
    expect(forwarded).toEqual([
      "send",
      // The image seam (docs/feat/attachments-tui.md D4): the bytes go through
      // the session, and a runtime that forgets these hands the App an
      // image-less controller with no reason shown.
      "attachImage",
      "imageInput",
      "compact",
      "clear",
      "openForReset",
      "enqueue",
      "sendNow",
      "close",
      "skills",
      "context",
      "rename",
      "onReturned",
      "watch",
      "open",
      "ownsTurn",
      "onQueued",
      "onSubagents",
      "onSubagentNotify",
      "messageSubagent",
      "killSubagent",
      "onJobs",
      "jobOutput",
      "killJob",
      "onSubagentMessage",
      "sessionId",
    ]);
    // Presence, not `typeof function`: `sessionId` is a string and `open` a
    // method — an optional member that is present at all is wired.
    const seen = r.controller as unknown as Record<string, unknown>;
    expect(forwarded.filter((name) => seen[name] === undefined)).toEqual([]);
  } finally {
    r.close();
    await rm(dir, { recursive: true, force: true });
  }
});
