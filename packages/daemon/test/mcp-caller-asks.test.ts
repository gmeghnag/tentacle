/**
 * docs/feat/serve-mcp-server.md slice M3: asks the MCP caller may answer
 * (`--mcp-asks owner|both`), on A2A's protocol-neutral caller-asks code
 * (`external/asks.ts`). Real `SessionHost`/`Agent` with a scripted model; the
 * "phone" is a second `Connection`; the push side is the real
 * `createPushNotifier` with manual timers. Each test names its mutation (§9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  BROWSER_ACTION_TOOL,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
  WORKFLOW_APPROVE_TOOL,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
  encodeBase64Url,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { publicKeyOf } from "@tentacle/transport/push";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import type { AskMode } from "../src/external/asks.ts";
import { MCP_TOOLS, McpTools } from "../src/mcp/tools.ts";
import type { CallToolResult } from "../src/mcp/wire.ts";
import { type PushDelivery, createPushNotifier } from "../src/push-notifier.ts";
import { readPushRegistrations, writePushRegistration } from "../src/push-store.ts";
import { SessionHost } from "../src/session-host.ts";

const env = {} as ExecutionEnvironment;
const DEVICE = "aaaaaaaaaaaaaaaa";

async function until(pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`until: timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function untilAsync(pred: () => Promise<boolean>, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`untilAsync: timed out: ${String(pred)}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

class Scripted implements ModelProvider {
  readonly id = "scripted";
  constructor(private readonly rounds: (readonly StreamEvent[])[]) {}
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield* this.rounds.shift() ?? [{ type: "text", delta: "idle" }];
    yield { type: "done" };
  }
}

const text = (delta: string): StreamEvent => ({ type: "text", delta });
const call = (id: string, name: string): StreamEvent => ({
  type: "tool_call",
  toolCall: { id, name, arguments: "{}" },
});

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

/** Manual timers: the push grace fires only when the test says so. */
function manualTimers() {
  const pending: { fn: () => void; cancelled: boolean }[] = [];
  return {
    setTimeout: (fn: () => void, _ms: number) => {
      const entry = { fn, cancelled: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle: unknown) => {
      const entry = handle as { cancelled: boolean } | undefined;
      if (entry !== undefined) entry.cancelled = true;
    },
    fire(): void {
      for (const entry of pending.splice(0)) if (!entry.cancelled) entry.fn();
    },
  };
}

function pushSide() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-caller-asks-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const deliveries: PushDelivery[] = [];
  const audit: string[] = [];
  const timers = manualTimers();
  const written = writePushRegistration(dir, {
    deviceId: DEVICE,
    token: "a".repeat(64),
    env: "sandbox",
    key: encodeBase64Url(publicKeyOf(new Uint8Array(32).fill(3))),
    registeredAt: 1,
  });
  if (!written.ok) throw new Error(written.reason);
  const read = (id: string) => readPushRegistrations(dir).registrations.get(id);
  let t = 1_000;
  const notifier = createPushNotifier({
    now: () => t,
    registrations: { registered: () => [DEVICE], read, forget: () => {} },
    describe: () => ({ title: "t", cwd: "/proj" }),
    computer: () => ({ privateKey: new Uint8Array(32).fill(9), name: "mac" }),
    sink: (delivery) => {
      deliveries.push(delivery);
      return Promise.resolve("sent");
    },
    timers,
    onAudit: (line) => audit.push(line),
    graceMs: 30_000,
    random: (n) => new Uint8Array(n).fill(7),
  });
  /** The grace runs out: the clock passes the deadline and its timer fires. */
  const graceEnds = () => {
    t += 31_000;
    timers.fire();
  };
  return { dir, deliveries, audit, graceEnds, notifier };
}

function rig(
  rounds: (readonly StreamEvent[])[],
  mode: AskMode | undefined,
  opts: { push?: ReturnType<typeof pushSide> } = {},
) {
  const ran: string[] = [];
  const tool = (name: string): Tool => ({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permission: "ask",
    execute: async () => {
      ran.push(name);
      return { content: "ok" };
    },
  });
  const model = new Scripted(rounds);
  const host = new SessionHost({
    defaultCwd: "/tmp/mcp-caller-asks",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry()
          .register(tool("run"))
          .register(tool(WORKFLOW_APPROVE_TOOL))
          .register(tool(BROWSER_ACTION_TOOL)),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
    ...(opts.push !== undefined
      ? {
          push: {
            observer: opts.push.notifier,
            storeDir: opts.push.dir,
            graceSeconds: 30,
            status: () => "on" as const,
          },
        }
      : {}),
  });
  const tools = new McpTools({
    host,
    version: "0.0.1",
    ...(mode !== undefined
      ? { callerAsks: (caller: string) => (caller === "default" ? mode : undefined) }
      : {}),
  });
  cleanups.push(() => tools.dispose());
  return { host, tools, ran };
}

function ok(r: CallToolResult): Record<string, unknown> {
  if (r.isError === true) throw new Error(`tool error: ${r.content[0]?.text}`);
  return r.structuredContent ?? {};
}

async function start(tools: McpTools, caller = "default") {
  const r = ok(await tools.call(caller, "session_start", { prompt: "hello" }));
  return String(r.sessionId);
}

const status = async (tools: McpTools, sessionId: string, caller = "default") =>
  ok(await tools.call(caller, "session_status", { sessionId }));

async function waiting(tools: McpTools, sessionId: string, caller = "default") {
  await untilAsync(async () => (await status(tools, sessionId, caller)).state === "waiting");
  return status(tools, sessionId, caller);
}

const answer = (
  tools: McpTools,
  sessionId: string,
  requestId: string,
  decision: string,
  extra: Record<string, unknown> = {},
  caller = "default",
) => tools.call(caller, "session_answer", { sessionId, requestId, decision, ...extra });

async function phone(host: SessionHost, sessionId: string) {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const updates: KnownSessionUpdateParams[] = [];
  const peer = new RpcPeer(c, {
    onNotification: (method, params) => {
      if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
    },
    onRequest: async (method) => {
      throw new Error(`unexpected ${method}`);
    },
  });
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
    clientInfo: { name: "phone", version: "1", host: "iPhone" },
  });
  await peer.request("session/open", { sessionId });
  cleanups.push(() => peer.close());
  const asks = () =>
    updates
      .map((u) => u.update)
      .filter((u): u is PermissionRequestUpdate => u.type === "permission_request");
  const resolved = (requestId: string) =>
    updates.some(
      (u) => u.update.type === "permission_resolved" && u.update.requestId === requestId,
    );
  return { peer, asks, resolved };
}

/** Every `session/resolve_permission` any peer sends while the spy is on. */
function spyResolves(): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  const original = RpcPeer.prototype.request;
  RpcPeer.prototype.request = function (this: RpcPeer, method: string, params?: unknown) {
    if (method === "session/resolve_permission") seen.push(params as Record<string, unknown>);
    return (original as (m: string, p?: unknown) => Promise<unknown>).call(this, method, params);
  } as typeof original;
  cleanups.push(() => {
    RpcPeer.prototype.request = original;
  });
  return seen;
}

interface ListedAsk {
  requestId: string;
  title: string;
  options: string[];
}
const asksOf = (s: Record<string, unknown>) => (s.asks ?? []) as ListedAsk[];

describe("mcp caller asks (--mcp-asks)", () => {
  test("session_answer is listed after session_status", () => {
    const names = MCP_TOOLS.map((t) => t.name);
    expect(names).toContain("session_answer");
  });

  // Mutation: `onceOption` picking `allow_always` (the caller's choice passed
  // through as a lasting approval) → the sent optionId is not `*_once` → red.
  test("both: the tool ask is listed; allow → that ask's allow_once, never *_always", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]], "both");
    const sent = spyResolves();
    const sessionId = await start(r.tools);
    const w = await waiting(r.tools, sessionId);
    const listed = asksOf(w);
    expect(listed).toHaveLength(1);
    const ask = listed[0];
    if (ask === undefined) throw new Error("no ask");
    expect(ask.options).toEqual(["allow", "deny"]);
    expect(ask.title).toBeTruthy();
    expect(String(w.statusMessage)).toContain("session_answer");
    const res = ok(await answer(r.tools, sessionId, ask.requestId, "allow"));
    expect(res.answered).toBe(true);
    expect(sent).toEqual([{ sessionId, requestId: ask.requestId, optionId: "allow_once" }]);
    await untilAsync(async () => (await status(r.tools, sessionId)).state === "completed");
    expect(r.ran).toEqual(["run"]);
    expect((await status(r.tools, sessionId)).result).toBe("ran");
  });

  test("both: deny → reject_once with the cleaned reply; the tool never runs", async () => {
    const r = rig([[call("c1", "run")], [text("refused")]], "both");
    const sent = spyResolves();
    const sessionId = await start(r.tools);
    const ask = asksOf(await waiting(r.tools, sessionId))[0];
    if (ask === undefined) throw new Error("no ask");
    ok(await answer(r.tools, sessionId, ask.requestId, "deny", { message: "  not now\u0007 " }));
    expect(sent).toHaveLength(1);
    expect(sent[0]?.optionId).toBe("reject_once");
    await untilAsync(async () => (await status(r.tools, sessionId)).state === "completed");
    expect(r.ran).toEqual([]);
  });

  // Mutation: `callerMayAnswer` without the kind check (mode only) → the
  // owner-only asks are listed and the crafted answer is sent → red.
  test("an owner-only ask (workflow approval, browser action) is never listed; a crafted answer is refused, the ask untouched", async () => {
    for (const owned of [WORKFLOW_APPROVE_TOOL, BROWSER_ACTION_TOOL]) {
      const r = rig([[call("c1", owned)], [text("done")]], "both");
      const sent = spyResolves();
      const sessionId = await start(r.tools);
      const w = await waiting(r.tools, sessionId);
      expect(asksOf(w)).toEqual([]);
      expect(String(w.statusMessage)).toContain("waiting for the owner");
      const p = await phone(r.host, sessionId);
      await until(() => p.asks().length === 1);
      const requestId = p.asks()[0]?.requestId ?? "";
      for (const decision of ["allow", "deny"]) {
        const refused = await answer(r.tools, sessionId, requestId, decision);
        expect(refused.isError).toBe(true);
      }
      expect(sent).toEqual([]);
      expect(p.resolved(requestId)).toBe(false);
      expect((await status(r.tools, sessionId)).state).toBe("waiting");
      expect(r.ran).toEqual([]);
      for (const c of cleanups.splice(0)) c();
    }
  });

  // Mutation: the ask's turn not required to be one the caller started
  // (`ownTurn` = any running turn) → the owner's own turn's ask is answerable → red.
  test("an ask of a turn the OWNER started in the caller's session is the owner's", async () => {
    const r = rig([[text("first")], [call("c1", "run")], [text("done")]], "both");
    const sent = spyResolves();
    const sessionId = await start(r.tools);
    await untilAsync(async () => (await status(r.tools, sessionId)).state === "completed");
    const p = await phone(r.host, sessionId);
    await p.peer.request("session/prompt", {
      sessionId,
      turnId: "owner-turn-1",
      content: [{ type: "text", text: "mine" }],
    });
    await until(() => p.asks().length === 1);
    const w = await waiting(r.tools, sessionId);
    expect(asksOf(w)).toEqual([]);
    const requestId = p.asks()[0]?.requestId ?? "";
    expect((await answer(r.tools, sessionId, requestId, "allow")).isError).toBe(true);
    expect(sent).toEqual([]);
    expect(r.ran).toEqual([]);
  });

  test("the phone answers first: the caller's late answer has no effect", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]], "both");
    const sessionId = await start(r.tools);
    const ask = asksOf(await waiting(r.tools, sessionId))[0];
    if (ask === undefined) throw new Error("no ask");
    const p = await phone(r.host, sessionId);
    await until(() => p.asks().length === 1);
    await p.peer.request("session/resolve_permission", {
      sessionId,
      requestId: ask.requestId,
      optionId: "allow_once",
    });
    await untilAsync(async () => (await status(r.tools, sessionId)).state === "completed");
    const late = await answer(r.tools, sessionId, ask.requestId, "deny");
    expect(late.isError).toBe(true);
    expect(r.ran).toEqual(["run"]);
    expect((await status(r.tools, sessionId)).result).toBe("ran");
  });

  test("owner mode (and no mode set): no asks listed, session_answer refused, nothing sent", async () => {
    for (const mode of ["owner", undefined] as const) {
      const r = rig([[call("c1", "run")], [text("ran")]], mode);
      const sent = spyResolves();
      const sessionId = await start(r.tools);
      const w = await waiting(r.tools, sessionId);
      expect(asksOf(w)).toEqual([]);
      const p = await phone(r.host, sessionId);
      await until(() => p.asks().length === 1);
      const refused = await answer(r.tools, sessionId, p.asks()[0]?.requestId ?? "", "allow");
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toContain("owner");
      expect(sent).toEqual([]);
      expect(r.ran).toEqual([]);
      for (const c of cleanups.splice(0)) c();
    }
  });

  test("another caller's session, an unknown session, bad arguments", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]], "both");
    const sessionId = await start(r.tools);
    const ask = asksOf(await waiting(r.tools, sessionId))[0];
    if (ask === undefined) throw new Error("no ask");
    const foreign = await answer(r.tools, sessionId, ask.requestId, "allow", {}, "other");
    expect(foreign.isError).toBe(true);
    expect(foreign.content[0]?.text).toBe("unknown session");
    await expect(answer(r.tools, sessionId, ask.requestId, "allow_always")).rejects.toThrow();
    await expect(
      r.tools.call("default", "session_answer", { sessionId, decision: "allow" }),
    ).rejects.toThrow();
    expect((await status(r.tools, sessionId)).state).toBe("waiting");
    expect(r.ran).toEqual([]);
  });

  // Control first: an unanswered ask IS pushed once its grace ends (so the
  // silent case below is not vacuous). Mutation: the answer not sent → pushed → red.
  test("the caller answers inside the push grace → the phone is not pushed", async () => {
    const control = pushSide();
    const c = rig([[call("c1", "run")], [text("ran")]], "both", { push: control });
    const cs = await start(c.tools);
    await waiting(c.tools, cs);
    control.graceEnds();
    await until(() => control.deliveries.length === 1).catch((e) => {
      throw new Error(`${e} audit=${JSON.stringify(control.audit)}`);
    });

    const side = pushSide();
    const r = rig([[call("c1", "run")], [text("ran")]], "both", { push: side });
    const sessionId = await start(r.tools);
    const ask = asksOf(await waiting(r.tools, sessionId))[0];
    if (ask === undefined) throw new Error("no ask");
    ok(await answer(r.tools, sessionId, ask.requestId, "allow"));
    await untilAsync(async () => (await status(r.tools, sessionId)).state === "completed");
    side.graceEnds();
    for (let i = 0; i < 300; i++) await Promise.resolve();
    expect(side.deliveries).toEqual([]);
  });
});
