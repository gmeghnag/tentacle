/**
 * docs/feat/serve-mcp-server.md slice M2: the MCP session tools drive a session
 * on the single session path (AGENTS §7) through A2A's protocol-neutral driver.
 * Real `SessionHost`/`Agent` with a scripted model; a "phone" is a second
 * `Connection` over `createChannelPair`, as a socket would be; the HTTP face is
 * a real `startWsServer` on loopback `port: 0`. Each test names its mutation (§9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  PROTOCOL_VERSION,
  type PermissionRequestUpdate,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import { MCP_PATH, createMcpRoute } from "../src/mcp/http.ts";
import { MCP_MAX_LIVE_SESSIONS, MCP_TOOLS, McpTools, UNKNOWN_SESSION } from "../src/mcp/tools.ts";
import type { CallToolResult } from "../src/mcp/wire.ts";
import { SessionHost } from "../src/session-host.ts";
import { type RunningServer, startWsServer } from "../src/ws-server.ts";

const CWD = "/tmp/mcp-tools";
const env = {} as ExecutionEnvironment;

/** Throws on a timeout, so an ignored wait never passes vacuously (§9). */
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

type Round = readonly StreamEvent[] | "hang";

/** One script shared by every session of a rig: each model call takes the next round. */
class Scripted implements ModelProvider {
  readonly id = "scripted";
  /** The user messages each model call saw (a steer is one more). */
  readonly users: number[] = [];
  constructor(private readonly rounds: Round[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.users.push(request.messages.filter((m) => m.role === "user").length);
    const round = this.rounds.shift() ?? [{ type: "text", delta: "idle" }];
    if (round === "hang") {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve());
      });
    } else {
      yield* round;
    }
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

function rig(rounds: Round[], opts: { detachAfterMs?: number; audit?: string[] } = {}) {
  const model = new Scripted(rounds);
  const ran: string[] = [];
  /** `gate` blocks until the test opens it: a turn held at a round boundary. */
  let open = () => {};
  const gate = new Promise<void>((r) => {
    open = r;
  });
  const tool = (name: string, permission: "ask" | "none", wait = false): Tool => ({
    name,
    description: name,
    inputSchema: z.object({}).passthrough(),
    permission,
    execute: async () => {
      if (wait) await gate;
      ran.push(name);
      return { content: "ok" };
    },
  });
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry()
          .register(tool("run", "ask"))
          .register(tool("note", "none"))
          .register(tool("gate", "none", true)),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const tools = new McpTools({
    host,
    version: "0.0.1",
    ...(opts.detachAfterMs !== undefined ? { detachAfterMs: opts.detachAfterMs } : {}),
    ...(opts.audit !== undefined ? { onAudit: (l: string) => opts.audit?.push(l) } : {}),
  });
  cleanups.push(() => tools.dispose());
  return { host, tools, model, ran, openGate: () => open() };
}

/** The structured result, or a throw naming the error text. */
function ok(r: CallToolResult): Record<string, unknown> {
  if (r.isError === true) throw new Error(`tool error: ${r.content[0]?.text}`);
  return r.structuredContent ?? {};
}

async function startTask(tools: McpTools, prompt = "hello", caller = "default") {
  const r = ok(await tools.call(caller, "session_start", { prompt }));
  return { sessionId: String(r.sessionId), turnId: String(r.turnId) };
}

async function statusOf(tools: McpTools, sessionId: string, extra: Record<string, unknown> = {}) {
  return ok(await tools.call("default", "session_status", { sessionId, ...extra }));
}

/** A phone: a second client on the same host, exactly as a socket would be. */
async function phone(host: SessionHost) {
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
  const asks = () =>
    updates
      .map((u) => u.update)
      .filter((u): u is PermissionRequestUpdate => u.type === "permission_request");
  cleanups.push(() => peer.close());
  return { peer, updates, asks };
}

/** Every `RpcPeer.request` method name while the spy is on (restored after the test). */
function spyRequests(): string[] {
  const seen: string[] = [];
  const original = RpcPeer.prototype.request;
  RpcPeer.prototype.request = function (this: RpcPeer, method: string, ...rest: unknown[]) {
    seen.push(method);
    return (original as (...a: unknown[]) => Promise<unknown>).call(this, method, ...rest);
  } as typeof original;
  cleanups.push(() => {
    RpcPeer.prototype.request = original;
  });
  return seen;
}

describe("mcp tools — sessions on the single session path", () => {
  test("start: self-locating ids, the turn runs, no result while working", async () => {
    const r = rig([[text("thinking "), call("c1", "gate")], [text("final answer")]]);
    const { sessionId, turnId } = await startTask(r.tools);
    expect(sessionId).toMatch(/^mcp-default-[0-9a-f-]{36}$/);
    expect(turnId.startsWith(`${sessionId.slice("mcp-default-".length)}.`)).toBe(true);
    expect(turnId.length).toBeLessThanOrEqual(128);
    await until(() => r.model.users.length === 1);
    const working = await statusOf(r.tools, sessionId);
    expect(working.state).toBe("working");
    expect(working.result).toBeUndefined();
    r.openGate();
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "completed");
    expect((await statusOf(r.tools, sessionId)).result).toBe("final answer");
  });

  // Mutation: project `result` as every turn's result joined → the second
  // turn's status carries "one" → red.
  test("the final round, per turn; status by turnId; recent", async () => {
    const r = rig([[text("thinking "), call("c1", "note")], [text("one")], [text("two")]]);
    const { sessionId, turnId } = await startTask(r.tools);
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "completed");
    const first = await statusOf(r.tools, sessionId);
    expect(first.turnId).toBe(turnId);
    expect(first.result).toBe("one");
    expect(JSON.stringify(first)).not.toContain("thinking");
    const sent = ok(await r.tools.call("default", "session_send", { sessionId, text: "again" }));
    expect(sent.steered).toBe(false);
    await untilAsync(
      async () =>
        (await statusOf(r.tools, sessionId)).turnId === sent.turnId &&
        (await statusOf(r.tools, sessionId)).state === "completed",
    );
    const second = await statusOf(r.tools, sessionId);
    expect(second.result).toBe("two");
    expect((await statusOf(r.tools, sessionId, { turnId })).result).toBe("one");
    expect(second.recent).toEqual([
      { turnId: sent.turnId, state: "completed" },
      { turnId, state: "completed" },
    ]);
    const unknown = await r.tools.call("default", "session_status", { sessionId, turnId: "nope" });
    expect(unknown.isError).toBe(true);
  });

  // Mutation: ignore `key` (a fresh enqueue id each time) → the model sees the
  // steer twice (3 user messages) → red.
  test("send while a turn runs steers it; a retried key steers once", async () => {
    const r = rig([[call("c1", "gate")], [text("steered")]]);
    const { sessionId, turnId } = await startTask(r.tools);
    await until(() => r.model.users.length === 1);
    const args = { sessionId, text: "also this", key: "k1" };
    const a = ok(await r.tools.call("default", "session_send", args));
    const b = ok(await r.tools.call("default", "session_send", args));
    expect(a).toEqual({ turnId, steered: true });
    expect(b).toEqual({ turnId, steered: true });
    r.openGate();
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "completed");
    // The prompt + ONE steer.
    expect(r.model.users[1]).toBe(2);
  });

  test("cancel ends the running turn as canceled; nothing running → cancelled:false", async () => {
    const r = rig(["hang"]);
    const { sessionId, turnId } = await startTask(r.tools);
    await until(() => r.model.users.length === 1);
    const other = ok(
      await r.tools.call("default", "session_cancel", { sessionId, turnId: "not-this-one" }),
    );
    expect(other.cancelled).toBe(false);
    expect(ok(await r.tools.call("default", "session_cancel", { sessionId }))).toEqual({
      sessionId,
      turnId,
      cancelled: true,
    });
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "canceled");
    expect(ok(await r.tools.call("default", "session_cancel", { sessionId })).cancelled).toBe(
      false,
    );
  });

  // Mutation: `own()` ignoring the prefix (any id is the caller's) → the
  // phone's session is read and its turn cancelled → red.
  test("a foreign id (phone, a2a-…, another caller) is unknown and untouched", async () => {
    const r = rig([[call("c1", "gate")], [text("phone done")], [text("other done")]]);
    const p = await phone(r.host);
    await p.peer.request("session/open", { sessionId: "phone-1", create: true });
    await p.peer.request("session/prompt", {
      sessionId: "phone-1",
      turnId: "phone-turn",
      content: [{ type: "text", text: "mine" }],
    });
    await until(() => r.model.users.length === 1);
    await p.peer.request("session/open", { sessionId: "a2a-default-ctx", create: true });
    const theirs = await startTask(r.tools, "theirs", "other");
    for (const sessionId of ["phone-1", "a2a-default-ctx", theirs.sessionId, "mcp-default-none"]) {
      for (const [name, args] of [
        ["session_status", { sessionId }],
        ["session_send", { sessionId, text: "x" }],
        ["session_cancel", { sessionId }],
      ] as const) {
        const res = await r.tools.call("default", name, args);
        expect(res.isError).toBe(true);
        expect(res.content[0]?.text).toBe(UNKNOWN_SESSION);
      }
    }
    // Untouched: the phone's turn still runs, saw no steer, and no new turn.
    expect(r.host.get("phone-1")?.workUnits().at(-1)?.state).toBe("working");
    r.openGate();
    await until(() => r.host.get("phone-1")?.workUnits().at(-1)?.state === "completed");
    expect(r.model.users[1]).toBe(1);
    const listed = ok(await r.tools.call("default", "session_list", {})).sessions as {
      sessionId: string;
    }[];
    expect(listed).toEqual([]);
    const theirList = ok(await r.tools.call("other", "session_list", {})).sessions as {
      sessionId: string;
    }[];
    expect(theirList.map((s) => s.sessionId)).toEqual([theirs.sessionId]);
  });

  // Mutation: the driver declaring no `permission_request` (session-driver
  // `updates: []`) → the host denies the ask at once → `run` never runs → red.
  test("owner mode: the phone sees the session, answers its ask; the held status returns; the adapter never answers", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]]);
    const requests = spyRequests();
    const { sessionId } = await startTask(r.tools);
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "waiting");
    const waiting = await statusOf(r.tools, sessionId);
    expect(waiting.waitingFor).toBe("permission");
    expect(String(waiting.statusMessage)).toContain("waiting for the owner's approval");
    const p = await phone(r.host);
    const list = (await p.peer.request("session/list", {})) as {
      sessions: { sessionId: string; title: string }[];
    };
    expect(list.sessions.map((s) => s.sessionId)).toContain(sessionId);
    expect(list.sessions.find((s) => s.sessionId === sessionId)?.title).toBe("MCP: hello");
    await p.peer.request("session/open", { sessionId });
    await until(() => p.asks().length === 1);
    const held = r.tools.call("default", "session_status", { sessionId, waitSeconds: 30 });
    // No answer from the adapter: only the phone's own resolve below.
    expect(requests.filter((m) => m === "session/resolve_permission")).toEqual([]);
    const ask = p.asks()[0];
    if (ask === undefined) throw new Error("no ask");
    const started = Date.now();
    await p.peer.request("session/resolve_permission", {
      sessionId,
      requestId: ask.requestId,
      optionId: "allow_once",
    });
    const after = ok(await held);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(after.state === "working" || after.state === "completed").toBe(true);
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "completed");
    expect((await statusOf(r.tools, sessionId)).result).toBe("ran");
    expect(r.ran).toEqual(["run"]);
    expect(requests.filter((m) => m === "session/resolve_permission")).toHaveLength(1);
  });

  test("the phone's cancel ends the MCP turn as canceled", async () => {
    const r = rig(["hang"]);
    const { sessionId } = await startTask(r.tools);
    await until(() => r.model.users.length === 1);
    const p = await phone(r.host);
    await p.peer.request("session/open", { sessionId });
    p.peer.notify("session/cancel", { sessionId });
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "canceled");
  });

  test("at most 8 live sessions per caller; another caller is not counted; a cancel frees a slot", async () => {
    // Mutation: count every loaded session (the old `liveCount`) → the 9th after the cancel is red.
    const r = rig(Array.from({ length: 12 }, () => "hang" as const));
    const started: { sessionId: string; turnId: string }[] = [];
    for (let i = 0; i < MCP_MAX_LIVE_SESSIONS; i++) started.push(await startTask(r.tools, `t${i}`));
    const ninth = await r.tools.call("default", "session_start", { prompt: "one more" });
    expect(ninth.isError).toBe(true);
    expect(ninth.content[0]?.text).toContain("too many live sessions");
    expect(r.host.size).toBe(MCP_MAX_LIVE_SESSIONS);
    await startTask(r.tools, "other's", "other");
    const first = started[0];
    if (first === undefined) throw new Error("no session");
    ok(await r.tools.call("default", "session_cancel", { sessionId: first.sessionId }));
    await untilAsync(async () => (await statusOf(r.tools, first.sessionId)).state === "canceled");
    await startTask(r.tools, "after the cancel");
  });

  test("the cap holds under concurrent starts: no start passes the check while another attaches", async () => {
    // Mutation: check without reserving (the old check-then-await) → all 12 pass, red.
    const r = rig(Array.from({ length: 12 }, () => "hang" as const));
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        r.tools.call("default", "session_start", { prompt: `c${i}` }),
      ),
    );
    expect(results.filter((x) => x.isError !== true).length).toBe(MCP_MAX_LIVE_SESSIONS);
    expect(r.host.size).toBe(MCP_MAX_LIVE_SESSIONS);
  });

  test("session_send cannot bring a 9th session back to life past the cap", async () => {
    // Mutation: drop the cap check from `send` → the idle session is re-attached and runs, red.
    const rounds: Round[] = [[text("done")], ...Array.from({ length: 9 }, () => "hang" as const)];
    const r = rig(rounds, { detachAfterMs: 10 });
    const idle = await startTask(r.tools, "first");
    await untilAsync(async () => (await statusOf(r.tools, idle.sessionId)).state === "completed");
    for (let i = 0; i < MCP_MAX_LIVE_SESSIONS; i++) await startTask(r.tools, `t${i}`);
    const sent = await r.tools.call("default", "session_send", {
      sessionId: idle.sessionId,
      text: "wake up",
    });
    expect(sent.isError).toBe(true);
    expect(sent.content[0]?.text).toContain("too many live sessions");
    expect(r.model.users.length).toBe(1 + MCP_MAX_LIVE_SESSIONS);
  });

  test("ended delegations still held do not block a new one (idle held attachments are let go)", async () => {
    // Mutation: never release idle held attachments in `admit` → the 9th is refused, red.
    const r = rig([]);
    for (let i = 0; i < MCP_MAX_LIVE_SESSIONS; i++) {
      const { sessionId } = await startTask(r.tools, `t${i}`);
      await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "completed");
    }
    await startTask(r.tools, "the ninth");
  });

  test("bad arguments throw before anything is opened", async () => {
    const r = rig([]);
    for (const args of [{}, { prompt: "" }, { prompt: "x".repeat(64 * 1024 + 1) }, { prompt: 1 }]) {
      await expect(r.tools.call("default", "session_start", args)).rejects.toThrow();
    }
    await expect(
      r.tools.call("default", "session_status", { sessionId: "x", waitSeconds: 121 }),
    ).rejects.toThrow();
    await expect(r.tools.call("default", "nope", {})).rejects.toThrow();
    expect(r.host.size).toBe(0);
  });

  // Mutation: `settle` arming the detach timer while a turn runs → the
  // attachment is gone while the ask waits → red.
  test("the attachment is held while a turn runs and released after it ends", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]], { detachAfterMs: 30 });
    const { sessionId } = await startTask(r.tools);
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "waiting");
    await new Promise((res) => setTimeout(res, 120));
    expect(r.tools.attachedSessionIds()).toEqual([sessionId]);
    const p = await phone(r.host);
    await p.peer.request("session/open", { sessionId });
    await until(() => p.asks().length === 1);
    const ask = p.asks()[0];
    if (ask === undefined) throw new Error("no ask");
    await p.peer.request("session/resolve_permission", {
      sessionId,
      requestId: ask.requestId,
      optionId: "allow_once",
    });
    await until(() => r.tools.attachedSessionIds().length === 0);
    // Re-attached lazily: a later send still works.
    const sent = ok(await r.tools.call("default", "session_send", { sessionId, text: "more" }));
    expect(sent.steered).toBe(false);
  });

  test("tools/list order is deterministic", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual([
      "session_start",
      "session_send",
      "session_status",
      "session_answer",
      "session_cancel",
      "session_list",
    ]);
  });
});

const MCP_TOKEN = "mcp-token";
const WS_TOKEN = "ws-token";

function serve(r: ReturnType<typeof rig>, audit: string[] = []) {
  const route = createMcpRoute({
    tools: r.tools,
    callers: [{ name: "default", token: MCP_TOKEN }],
    serverInfo: { name: "tentacle", version: "0.0.1" },
    progressMs: 25,
    onAudit: (l) => audit.push(l),
  });
  const server: RunningServer = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: r.host,
    token: WS_TOKEN,
    mcp: route,
  });
  cleanups.push(() => server.stop());
  return new URL(server.url.replace(/^ws/, "http")).origin;
}

const rpc = (method: string, params: unknown = {}, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const post = (
  base: string,
  body: string,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) =>
  fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    body,
    headers: {
      authorization: `Bearer ${MCP_TOKEN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    ...(signal !== undefined ? { signal } : {}),
  });

/** The JSON-RPC messages of an SSE body, in order. */
const sseMessages = (body: string) =>
  body
    .split("\n\n")
    .flatMap((ev) => ev.split("\n").filter((l) => l.startsWith("data: ")))
    .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);

const MODERN = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };

describe("mcp http route — /mcp on the external entry", () => {
  test("guards: Origin 403 before auth; no/wrong/WS token 401 + WWW-Authenticate; GET 405; 413; the MCP token opens nothing else", async () => {
    const r = rig([]);
    const audit: string[] = [];
    const base = serve(r, audit);
    expect((await post(base, rpc("ping"), { origin: "https://evil.example" })).status).toBe(403);
    for (const authorization of ["", "Bearer nope", `Bearer ${WS_TOKEN}`]) {
      const res = await post(base, rpc("ping"), { authorization });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    const failures = audit.filter((l) => l.startsWith("mcp-auth-failure"));
    expect(failures).toHaveLength(3);
    // The rejected peer is named (address + UA) and the token never is; the tokens
    // WERE presented, so this also proves the audit sink is wired (§9).
    for (const line of failures) {
      expect(line).toMatch(/^mcp-auth-failure at (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1) ua "/);
    }
    const refused = audit.find((l) => l.startsWith("mcp-origin-refused"));
    expect(refused).toMatch(/^mcp-origin-refused at (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1) ua "/);
    for (const line of audit) {
      for (const secret of ["nope", MCP_TOKEN, WS_TOKEN, "Bearer"]) {
        expect(line).not.toContain(secret);
      }
    }
    expect((await fetch(`${base}${MCP_PATH}`)).status).toBe(405);
    // The MCP token is not the WebSocket token: the plain route still says 401.
    const ws = await fetch(`${base}/`, { headers: { authorization: `Bearer ${MCP_TOKEN}` } });
    expect(ws.status).toBe(401);
    expect((await post(base, "x".repeat(1024 * 1024 + 1))).status).toBe(413);
  });

  // A serve with NO MCP token produces the plain route's own line for a probe of
  // `/mcp` — the other half of the observed evidence. Mutation: drop the peer from
  // ws-server's `auth-failure` → the prefix assertions still pass (they are the
  // property project-pairing.test.ts relies on) and the peer ones go red.
  test("no MCP token: the plain route's auth-failure names the peer, after the path", async () => {
    const r = rig([]);
    const audit: string[] = [];
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: r.host,
      token: WS_TOKEN,
      onAudit: (line) => audit.push(line),
    });
    cleanups.push(() => server.stop());
    const base = new URL(server.url.replace(/^ws/, "http")).origin;
    const res = await fetch(`${base}${MCP_PATH}`, {
      method: "POST",
      body: rpc("ping"),
      headers: { authorization: "Bearer nope", "user-agent": "probe/9" },
    });
    expect(res.status).toBe(401);
    await until(() => audit.some((l) => l.startsWith("auth-failure /mcp")));
    const line = audit.find((l) => l.startsWith("auth-failure /mcp")) ?? "";
    expect(line).toMatch(
      /^auth-failure \/mcp at (127\.0\.0\.1|::1|::ffff:127\.0\.0\.1) ua "probe\/9"$/,
    );
    expect(line).not.toContain("nope");
  });

  test("legacy initialize, notification 202, tools/list, modern discover, bad params", async () => {
    const r = rig([]);
    const base = serve(r);
    const init = (await (
      await post(base, rpc("initialize", { protocolVersion: "2025-06-18" }))
    ).json()) as { result: { protocolVersion: string } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const note = await post(
      base,
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(note.status).toBe(202);
    const list = (await (await post(base, rpc("tools/list"))).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(list.result.tools.map((t) => t.name)).toContain("session_start");
    const discover = (await (
      await post(base, rpc("server/discover", { _meta: MODERN }), {
        "mcp-protocol-version": "2026-07-28",
      })
    ).json()) as { result: { capabilities: { extensions: Record<string, unknown> } } };
    expect(Object.keys(discover.result.capabilities.extensions)).toEqual([
      "io.modelcontextprotocol/tasks",
    ]);
    const big = (await (
      await post(
        base,
        rpc("tools/call", { name: "session_start", arguments: { prompt: "x".repeat(65537) } }),
      )
    ).json()) as { error: { code: number } };
    expect(big.error.code).toBe(-32602);
    expect(r.host.size).toBe(0);
    const unknown = (await (await post(base, rpc("nope"))).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32601);
  });

  test("tools/call over HTTP: a plain result with structuredContent", async () => {
    const r = rig([[text("done")]]);
    const base = serve(r);
    const res = (await (
      await post(base, rpc("tools/call", { name: "session_start", arguments: { prompt: "go" } }))
    ).json()) as { result: CallToolResult };
    expect(res.result.isError).toBeUndefined();
    const sessionId = String(res.result.structuredContent?.sessionId);
    expect(JSON.parse(res.result.content[0]?.text ?? "{}").sessionId).toBe(sessionId);
    expect(r.host.get(sessionId)).toBeDefined();
  });

  // Mutation: no progress interval in `progressStream` → only the result
  // arrives → red.
  test("a held session_status streams strictly increasing progress, then the result", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]]);
    const base = serve(r);
    const { sessionId } = await startTask(r.tools);
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "waiting");
    const res = await post(
      base,
      rpc("tools/call", {
        name: "session_status",
        arguments: { sessionId, waitSeconds: 1 },
        _meta: { progressToken: "p1" },
      }),
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const messages = sseMessages(await res.text());
    const progress = messages
      .filter((m) => m.method === "notifications/progress")
      .map((m) => m.params as { progressToken: string; progress: number });
    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.every((p) => p.progressToken === "p1")).toBe(true);
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i]?.progress ?? 0).toBeGreaterThan(progress[i - 1]?.progress ?? 0);
    }
    const last = messages.at(-1) as { id: number; result: CallToolResult };
    expect(last.id).toBe(1);
    expect(last.result.structuredContent?.state).toBe("waiting");
  });

  test("a client disconnect ends only the wait: the turn runs on, a new wait is admitted", async () => {
    const r = rig([[call("c1", "run")], [text("ran")]]);
    const base = serve(r);
    const { sessionId } = await startTask(r.tools);
    await untilAsync(async () => (await statusOf(r.tools, sessionId)).state === "waiting");
    const abort = new AbortController();
    const res = await post(
      base,
      rpc("tools/call", {
        name: "session_status",
        arguments: { sessionId, waitSeconds: 60 },
        _meta: { progressToken: 7 },
      }),
      {},
      abort.signal,
    );
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    await res.body?.getReader().read();
    // The wait really holds: one wait per session.
    const busy = await r.tools.call("default", "session_status", { sessionId, waitSeconds: 1 });
    expect(busy.isError).toBe(true);
    expect(busy.content[0]?.text).toContain("already running");
    abort.abort();
    // The wait flag clears once the server sees the disconnect: a new held wait is admitted.
    await untilAsync(async () => {
      const again = await r.tools.call("default", "session_status", { sessionId, waitSeconds: 1 });
      return again.isError !== true;
    }, 5000);
    expect((await statusOf(r.tools, sessionId)).state).toBe("waiting");
    expect(r.tools.attachedSessionIds()).toEqual([sessionId]);
  });
});

describe("mcp session_start replay — one retried start, one session", () => {
  /** One `tools/call session_start` over HTTP; the raw JSON-RPC reply. */
  const startCall = async (
    base: string,
    args: Record<string, unknown>,
  ): Promise<{ result?: CallToolResult; error?: { code: number; message: string } }> =>
    (await post(base, rpc("tools/call", { name: "session_start", arguments: args })).then((x) =>
      x.json(),
    )) as { result?: CallToolResult; error?: { code: number; message: string } };

  const ids = (res: { result?: CallToolResult }) => ({
    sessionId: String(res.result?.structuredContent?.sessionId),
    turnId: String(res.result?.structuredContent?.turnId),
  });

  // The observed 2026-11-25 duplicate: Claude Code retried ONE start (no `key`,
  // 3 s apart) and got two sessions. Mutation: mint a session per call (no memo)
  // → two ids, two sessions, no audit line → red.
  test("no key: the same prompt inside the window returns the same session and turn", async () => {
    const audit: string[] = [];
    const r = rig([[text("answer")], [text("second")]], { audit });
    const base = serve(r);
    const first = await startCall(base, { prompt: "Prova MCP 2", title: "t" });
    const again = await startCall(base, { prompt: "Prova MCP 2", title: "t" });
    expect(ids(again)).toEqual(ids(first));
    expect(r.tools.attachedSessionIds()).toEqual([ids(first).sessionId]);
    expect(audit.filter((l) => l.startsWith("mcp-start-replayed "))).toEqual([
      `mcp-start-replayed ${ids(first).sessionId}`,
    ]);
    const listed = ok(await r.tools.call("default", "session_list", {}));
    expect((listed.sessions as { sessionId: string }[]).map((s) => s.sessionId)).toEqual([
      ids(first).sessionId,
    ]);
    // One turn ran, never two.
    expect(r.model.users).toHaveLength(1);
  });

  // Non-vacuity of the replay: it is not a global dedupe. Mutation: key on the
  // caller only → the second, different prompt is swallowed → red.
  test("two different prompts are two sessions", async () => {
    const r = rig([[text("a")], [text("b")]]);
    const base = serve(r);
    const one = await startCall(base, { prompt: "one" });
    const two = await startCall(base, { prompt: "two" });
    expect(ids(two).sessionId).not.toBe(ids(one).sessionId);
    expect(r.host.size).toBe(2);
  });

  // Mutation: ignore the arguments on a memo hit → the wrong prompt runs silently → red.
  test("same key, different arguments: -32602 and nothing opened", async () => {
    const r = rig([[text("a")]]);
    const base = serve(r);
    await startCall(base, { prompt: "one", key: "k1" });
    const clash = await startCall(base, { prompt: "two", key: "k1" });
    expect(clash.error?.code).toBe(-32602);
    expect(clash.error?.message).toContain("key reused with different arguments");
    expect(r.host.size).toBe(1);
    // The same key with the same arguments is still a replay.
    const replay = await startCall(base, { prompt: "one", key: "k1" });
    expect(ids(replay).turnId).toBe(
      ids(await startCall(base, { prompt: "one", key: "k1" })).turnId,
    );
  });

  // The `:992` hole for identical args: both calls are in flight at once.
  // Mutation: look the map up before creating the memo (two attaches) → red.
  test("two identical calls awaited together: one session, both answered", async () => {
    const audit: string[] = [];
    const r = rig([[text("answer")]], { audit });
    const base = serve(r);
    const [a, b] = await Promise.all([
      startCall(base, { prompt: "same" }),
      startCall(base, { prompt: "same" }),
    ]);
    expect(ids(b)).toEqual(ids(a));
    expect(r.host.size).toBe(1);
    expect(audit.filter((l) => l.startsWith("mcp-start-replayed "))).toHaveLength(1);
    expect(r.model.users).toHaveLength(1);
  });

  // A distinct explicit key is the documented escape hatch (D3).
  test("two distinct keys: two sessions for the same prompt", async () => {
    const r = rig([[text("a")], [text("b")]]);
    const base = serve(r);
    const one = await startCall(base, { prompt: "same", key: "k1" });
    const two = await startCall(base, { prompt: "same", key: "k2" });
    expect(ids(two).sessionId).not.toBe(ids(one).sessionId);
    expect(r.host.size).toBe(2);
  });

  // The `:992` race for identical args, made deterministic: the FIRST call is held
  // inside `start` (its `session/prompt` parked) while the second one arrives, so
  // the memo — and its single-flight promise — must already be there for the second
  // to wait on. Mutation: move `this.starts.set(...)` after `await this.prompt(...)`
  // → the second call opens its own session and both run → red.
  test("two identical calls interleaved: the second waits on the first, one session", async () => {
    const audit: string[] = [];
    const r = rig([[text("answer")]], { audit });
    // The two awaits inside `start`: `session/open` = a session is being opened,
    // `session/prompt` = the call got as far as sending its prompt.
    const opens: string[] = [];
    let prompts = 0;
    let release = () => {};
    const held = new Promise<void>((res) => {
      release = res;
    });
    const original = RpcPeer.prototype.request;
    RpcPeer.prototype.request = function (this: RpcPeer, method: string, ...rest: unknown[]) {
      const pending = (original as (...a: unknown[]) => Promise<unknown>).call(
        this,
        method,
        ...rest,
      );
      if (method === "session/open") opens.push(method);
      if (method === "session/prompt") {
        prompts += 1;
        // Only the FIRST prompt is held; a second can exist only if the race re-opened.
        if (prompts === 1) return held.then(() => pending);
      }
      return pending;
    } as typeof original;
    cleanups.push(() => {
      RpcPeer.prototype.request = original;
      release();
    });
    const first = r.tools.call("default", "session_start", { prompt: "same" });
    await until(() => prompts === 1);
    const second = r.tools.call("default", "session_start", { prompt: "same" });
    // Settle once the second call is provably INSIDE `start`: it hit the memo (its
    // replay audit) — or, mutated, opened a session of its own.
    await until(() => audit.some((l) => l.startsWith("mcp-start-replayed ")) || opens.length === 2);
    expect(opens).toHaveLength(1);
    release();
    const [a, b] = [ok(await first), ok(await second)];
    expect(String(b.sessionId)).toBe(String(a.sessionId));
    expect(String(b.turnId)).toBe(String(a.turnId));
    expect(r.host.size).toBe(1);
    expect(r.model.users).toHaveLength(1);
  });

  // No caller may replay or hijack another's start: the caller is IN the key, in
  // both namespaces. Mutation: drop `${caller}` from the `k\0` form → Bob is
  // answered with Alice's ids (and silently gets no session) → red; the same
  // mutation on the `r\0` form → the no-key assertions go red.
  test("the replay key is per caller: the same prompt and key are the other caller's own", async () => {
    const audit: string[] = [];
    const r = rig([[text("a")], [text("b")], [text("c")], [text("d")]], { audit });
    const alice = ok(await r.tools.call("alice", "session_start", { prompt: "same", key: "k1" }));
    const bob = ok(await r.tools.call("bob", "session_start", { prompt: "same", key: "k1" }));
    expect(String(bob.sessionId)).not.toBe(String(alice.sessionId));
    expect(String(alice.sessionId)).toMatch(/^mcp-alice-/);
    expect(String(bob.sessionId)).toMatch(/^mcp-bob-/);
    // The no-key (implicit) namespace is per caller too.
    const aliceImplicit = ok(await r.tools.call("alice", "session_start", { prompt: "plain" }));
    const bobImplicit = ok(await r.tools.call("bob", "session_start", { prompt: "plain" }));
    expect(String(bobImplicit.sessionId)).not.toBe(String(aliceImplicit.sessionId));
    expect(r.host.size).toBe(4);
    expect(audit.filter((l) => l.startsWith("mcp-start-replayed "))).toHaveLength(0);
  });

  // A refusal is not a replay: the memo is dropped, so a retry really retries.
  // Mutation: keep the memo after a refusal → the retry is answered as a replay
  // (the audit line appears) → red.
  test("a refused start leaves no memo: the retry is not answered as a replay", async () => {
    const audit: string[] = [];
    const r = rig(Array<Round>(MCP_MAX_LIVE_SESSIONS).fill("hang"), { audit });
    const base = serve(r);
    for (let i = 0; i < MCP_MAX_LIVE_SESSIONS; i++) {
      await startCall(base, { prompt: `h${i}` });
    }
    const refused = await startCall(base, { prompt: "boom" });
    expect(refused.result?.isError).toBe(true);
    const retry = await startCall(base, { prompt: "boom" });
    expect(retry.result?.isError).toBe(true);
    expect(audit.filter((l) => l.startsWith("mcp-start-replayed "))).toHaveLength(0);
    expect(r.host.size).toBe(MCP_MAX_LIVE_SESSIONS);
  });
});
