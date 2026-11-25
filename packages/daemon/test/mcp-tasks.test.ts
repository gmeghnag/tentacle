/**
 * docs/feat/serve-mcp-server.md slice M4: MCP tasks (the ext-tasks extension,
 * 2026-07-28) as a PROJECTION of the turn's work unit — no MCP store. A
 * `tools/call` from a request that declared the extension gets a
 * `CreateTaskResult` only once the turn's start is on disk (assumption 3);
 * `tasks/get|update|cancel` read and drive the same session a phone does.
 * Real `SessionHost`/`Agent`/`LogSessionStore`/`SessionPersister`, the HTTP face
 * a real `startWsServer` on loopback `port: 0`. Each test names its mutation (§9).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
  type Tool,
  WORKFLOW_APPROVE_TOOL,
} from "@tentacle/core";
import { type KnownSessionUpdateParams, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { z } from "zod";
import { Connection } from "../src/connection.ts";
import type { AskMode } from "../src/external/asks.ts";
import { MCP_PATH, createMcpRoute } from "../src/mcp/http.ts";
import { McpTools } from "../src/mcp/tools.ts";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { startWsServer } from "../src/ws-server.ts";

const CWD = "/tmp/mcp-tasks";
const env = {} as ExecutionEnvironment;

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

/**
 * Answers by the prompt's last line: `ask` calls the asking `run` tool,
 * `approve` the owner-only workflow approval tool, `hang` waits until aborted,
 * `fail` throws; anything else → `answer: <text>`. After a tool result: `answer: ran`.
 */
class Scripted implements ModelProvider {
  readonly id = "m";
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield { type: "text", delta: "answer: ran" };
      yield { type: "done" };
      return;
    }
    const last = [...request.messages].reverse().find((m) => m.role === "user");
    const text = (typeof last?.content === "string" ? last.content : "").split("\n").at(-1) ?? "";
    if (text === "ask" || text === "approve") {
      const name = text === "ask" ? "run" : WORKFLOW_APPROVE_TOOL;
      yield { type: "tool_call", toolCall: { id: "c1", name, arguments: "{}" } };
      yield { type: "done" };
      return;
    }
    if (text === "hang") {
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve());
      });
    }
    if (text === "fail") {
      throw new Error("the model broke");
    }
    yield { type: "text", delta: `answer: ${text}` };
    yield { type: "done" };
  }
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mcp-tasks-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let n = 0;

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const MCP_TOKEN = "mcp-token";

interface RigOptions {
  readonly mode?: AskMode;
  readonly durable?: (sessionId: string, turnId: string) => Promise<boolean>;
  /** Every store write rejects (a full disk): the persister reports it, never throws. */
  readonly failWrites?: boolean;
}

/** A `serve`-shaped host on a real store under `root`, its MCP route on loopback. */
function rig(root: string, opts: RigOptions = {}) {
  const store = new LogSessionStore(root);
  if (opts.failWrites) {
    store.write = () => Promise.reject(new Error("disk full"));
  }
  const reported: string[] = [];
  const persister = new SessionPersister({
    store,
    cwd: CWD,
    model: "m",
    onError: (e) => reported.push(e.message),
  });
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
  const host = new SessionHost({
    defaultCwd: CWD,
    persister,
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model: new Scripted(),
        tools: new ToolRegistry().register(tool("run")).register(tool(WORKFLOW_APPROVE_TOOL)),
        env,
        systemPrompt: "sys",
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const tools = new McpTools({
    host,
    version: "0.0.1",
    ...(opts.mode !== undefined ? { callerAsks: () => opts.mode } : {}),
    ...(opts.durable !== undefined ? { durable: opts.durable } : {}),
  });
  const audit: string[] = [];
  const route = createMcpRoute({
    tools,
    callers: [
      { name: "default", token: MCP_TOKEN },
      { name: "other", token: "other-token" },
    ],
    serverInfo: { name: "tentacle", version: "0.0.1" },
    onAudit: (l) => audit.push(l),
  });
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: host,
    token: "ws-token",
    mcp: route,
  });
  cleanups.push(() => {
    server.stop();
    tools.dispose();
  });
  const base = new URL(server.url.replace(/^ws/, "http")).origin;
  return { host, tools, persister, ran, audit, base, reported };
}

const META_VERSION = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
const TASKS = { extensions: { "io.modelcontextprotocol/tasks": {} } };
const FORM = { elicitation: { form: {} } };
type Caps = Record<string, unknown> | null;

/** One JSON-RPC call to /mcp: modern with `caps` (null = legacy, no `_meta`). */
async function mcp(
  base: string,
  method: string,
  params: Record<string, unknown>,
  caps: Caps = { ...TASKS, ...FORM },
  token = MCP_TOKEN,
): Promise<{ result?: Record<string, unknown>; error?: { code: number; message: string } }> {
  const meta =
    caps === null
      ? {}
      : { _meta: { ...META_VERSION, "io.modelcontextprotocol/clientCapabilities": caps } };
  const res = await fetch(`${base}${MCP_PATH}`, {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, ...meta } }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(caps === null ? {} : { "mcp-protocol-version": "2026-07-28" }),
    },
  });
  return (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

const callTool = (base: string, name: string, args: Record<string, unknown>, caps?: Caps) =>
  mcp(base, "tools/call", { name, arguments: args }, caps);

/** `session_start` as a task: the CreateTaskResult. */
async function startTask(base: string, prompt: string, caps?: Caps) {
  const r = await callTool(base, "session_start", { prompt }, caps);
  if (r.result?.resultType !== "task") throw new Error(`not a task: ${JSON.stringify(r)}`);
  return r.result as Record<string, unknown> & { taskId: string };
}

const getTask = async (base: string, taskId: string, caps?: Caps) =>
  (await mcp(base, "tasks/get", { taskId }, caps)).result ?? {};

const sessionOf = (taskId: string, caller = "default") =>
  `mcp-${caller}-${taskId.slice(0, taskId.indexOf("."))}`;

async function untilStatus(base: string, taskId: string, status: string, caps?: Caps) {
  await untilAsync(async () => (await getTask(base, taskId, caps)).status === status);
  return getTask(base, taskId, caps);
}

/** Every file under the store root with its bytes (archived read-only check). */
async function snapshot(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        // A lock released between the listing and the read is simply not there.
        const bytes = await readFile(p, "utf8").catch(() => undefined);
        if (bytes !== undefined) out.set(p, bytes);
      }
    }
  };
  await walk(root);
  return out;
}

/** Every `RpcPeer.request` method + params while the spy is on. */
function spyRequests(): Array<{ method: string; params: unknown }> {
  const seen: Array<{ method: string; params: unknown }> = [];
  const original = RpcPeer.prototype.request;
  RpcPeer.prototype.request = function (this: RpcPeer, method: string, ...rest: unknown[]) {
    seen.push({ method, params: rest[0] });
    return (original as (...a: unknown[]) => Promise<unknown>).call(this, method, ...rest);
  } as typeof original;
  cleanups.push(() => {
    RpcPeer.prototype.request = original;
  });
  return seen;
}

const root = () => join(dir, `r${++n}`);

/** A phone attaches to the session and reads its pending ask's requestId (replayed on attach). */
async function phoneAsk(host: SessionHost, sessionId: string): Promise<string> {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const asks: string[] = [];
  const peer = new RpcPeer(c, {
    onNotification: (method, params) => {
      const u = (params as KnownSessionUpdateParams).update;
      if (method === "session/update" && u.type === "permission_request") asks.push(u.requestId);
    },
    onRequest: async (method) => {
      throw new Error(`unexpected ${method}`);
    },
  });
  cleanups.push(() => peer.close());
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
    clientInfo: { name: "phone", version: "1", host: "iPhone" },
  });
  await peer.request("session/open", { sessionId });
  await until(() => asks.length > 0);
  return asks[0] ?? "";
}

describe("mcp tasks — negotiated per request, durable before the ack", () => {
  test("a declaring request gets a CreateTaskResult; a non-declaring or legacy one a plain result", async () => {
    // Mutation: always answer with a task → the plain cases go red.
    const r = rig(root());
    const task = await startTask(r.base, "hello");
    // The unit's state at the ack: a fast turn may already have ended.
    expect(task).toMatchObject({
      resultType: "task",
      status: expect.stringMatching(/^(working|completed)$/),
      ttlMs: null,
    });
    expect(task.result).toBeUndefined();
    expect(task.pollIntervalMs).toBe(2000);
    expect(typeof task.createdAt).toBe("string");
    expect(typeof task.lastUpdatedAt).toBe("string");
    expect(task.taskId).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}$/);
    const done = await untilStatus(r.base, task.taskId, "completed");
    // tasks/get and its inner CallToolResult are modern results: both say "complete".
    expect(done.resultType).toBe("complete");
    expect(done.result).toEqual({
      resultType: "complete",
      content: [{ type: "text", text: "answer: hello" }],
      structuredContent: { turnId: task.taskId, result: "answer: hello" },
    });
    // Modern without the extension: a plain result, stamped; legacy: never stamped.
    for (const [caps, kind] of [
      [{ ...FORM }, "complete"],
      [null, undefined],
    ] as const) {
      const plain = await callTool(r.base, "session_start", { prompt: "plain" }, caps);
      expect(plain.result?.resultType).toBe(kind);
      expect(plain.result?.structuredContent).toMatchObject({ sessionId: expect.any(String) });
    }
  });

  test("durable before the ack: a kill right after it, a reload → tasks/get finds the task", async () => {
    // Mutation: skip `durable` (return the task right after the prompt) → the reload finds no file.
    const dirA = root();
    const first = rig(dirA);
    const task = await startTask(first.base, "hang");
    expect(task.status).toBe("working");
    // The "kill": no stop, no further flush — read what is on disk NOW.
    const second = rig(dirA);
    const loaded = await second.persister.load(sessionOf(task.taskId));
    if (!loaded.ok) throw new Error(`not on disk: ${loaded.reason}`);
    second.host.restore(loaded.record);
    const got = await getTask(second.base, task.taskId);
    expect(got.taskId).toBe(task.taskId);
    // The reload closes the cut turn: completed + isError, never `failed` (JSON-RPC only).
    expect(got.status).toBe("completed");
    expect((got.result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(got.result)).toContain("interrupted");
  });

  test("a durable write that fails → isError, and the turn is cancelled (no unrecorded task)", async () => {
    // Mutation: ignore `durable`'s false → a task is handed out.
    const r = rig(root(), { durable: async () => false });
    const res = await callTool(r.base, "session_start", { prompt: "hang" });
    expect(res.result?.resultType).toBe("complete");
    expect(res.result?.isError).toBe(true);
    expect(JSON.stringify(res.result)).toContain("could not record the task");
    const s = [...r.host.values()][0];
    if (s === undefined) throw new Error("no session");
    await until(() => s.workUnits()[0]?.state === "canceled");
  });

  test("the DEFAULT durable sees a real write fail → isError, reported, the turn cancelled", async () => {
    // Mutation: the default `durable` returns true once the write settled (the
    // old `persisted()` → true) → a task is handed out for a turn not on disk.
    const r = rig(root(), { failWrites: true });
    const res = await callTool(r.base, "session_start", { prompt: "hang" });
    expect(res.result?.resultType).toBe("complete");
    expect(res.result?.isError).toBe(true);
    expect(JSON.stringify(res.result)).toContain("could not record the task");
    expect(r.reported.join("\n")).toContain("disk full");
    const s = [...r.host.values()][0];
    if (s === undefined) throw new Error("no session");
    await until(() => s.workUnits()[0]?.state === "canceled");
  });

  test("tasks/* without the declaration → -32021", async () => {
    const r = rig(root());
    const task = await startTask(r.base, "hello");
    for (const caps of [{ ...FORM }, null]) {
      const res = await mcp(r.base, "tasks/get", { taskId: task.taskId }, caps);
      expect(res.error?.code).toBe(-32021);
    }
  });

  test("session_send: idle → a new task; a running turn is steered (plain, no new task)", async () => {
    const r = rig(root());
    const task = await startTask(r.base, "hello");
    await untilStatus(r.base, task.taskId, "completed");
    const sessionId = sessionOf(task.taskId);
    const next = await callTool(r.base, "session_send", { sessionId, text: "hang" });
    expect(next.result?.resultType).toBe("task");
    const nextId = String(next.result?.taskId);
    expect(nextId.startsWith(`${task.taskId.slice(0, 36)}.`)).toBe(true);
    const steer = await callTool(r.base, "session_send", { sessionId, text: "more" });
    expect(steer.result?.resultType).toBe("complete");
    expect(steer.result?.structuredContent).toEqual({ turnId: nextId, steered: true });
    await mcp(r.base, "tasks/cancel", { taskId: nextId });
    await untilStatus(r.base, nextId, "cancelled");
  });
});

describe("mcp tasks — projection of the turn", () => {
  test("both + elicitation: input_required → tasks/update accept → that ask's allow_once → completed", async () => {
    const r = rig(root(), { mode: "both" });
    const requests = spyRequests();
    const task = await startTask(r.base, "ask");
    const waiting = await untilStatus(r.base, task.taskId, "input_required");
    const inputs = waiting.inputRequests as Record<string, { method: string; params: unknown }>;
    const keys = Object.keys(inputs);
    expect(keys).toHaveLength(1);
    const key = keys[0] ?? "";
    expect(inputs[key]).toEqual({
      method: "elicitation/create",
      params: {
        mode: "form",
        message: expect.stringContaining("run"),
        requestedSchema: {
          type: "object",
          properties: { decision: { type: "string", enum: ["allow", "deny"] } },
          required: ["decision"],
        },
      },
    });
    const ack = await mcp(r.base, "tasks/update", {
      taskId: task.taskId,
      inputResponses: { [key]: { action: "accept", content: { decision: "allow" } } },
    });
    expect(ack.result).toEqual({ resultType: "complete" });
    const done = await untilStatus(r.base, task.taskId, "completed");
    expect((done.result as { content: { text: string }[] }).content[0]?.text).toBe("answer: ran");
    expect(r.ran).toEqual(["run"]);
    const resolves = requests.filter((q) => q.method === "session/resolve_permission");
    expect(resolves.map((q) => q.params)).toEqual([
      { sessionId: sessionOf(task.taskId), requestId: key, optionId: "allow_once" },
    ]);
  });

  test("decline / an ambiguous answer → deny (fail-closed)", async () => {
    for (const response of [
      { action: "decline" },
      { action: "cancel" },
      { action: "accept", content: { decision: "maybe" } },
    ]) {
      const r = rig(root(), { mode: "both" });
      const task = await startTask(r.base, "ask");
      const waiting = await untilStatus(r.base, task.taskId, "input_required");
      const key = Object.keys(waiting.inputRequests as object)[0] ?? "";
      await mcp(r.base, "tasks/update", {
        taskId: task.taskId,
        inputResponses: { [key]: response },
      });
      await untilStatus(r.base, task.taskId, "completed");
      expect(r.ran).toEqual([]);
    }
  });

  test("both without elicitation → working + the session_answer hint; owner mode → waiting for the owner", async () => {
    const both = rig(root(), { mode: "both" });
    const t1 = await startTask(both.base, "ask", { ...TASKS });
    await untilAsync(async () =>
      String((await getTask(both.base, t1.taskId, { ...TASKS })).statusMessage).includes(
        "session_answer requestId=",
      ),
    );
    expect((await getTask(both.base, t1.taskId, { ...TASKS })).status).toBe("working");
    const owner = rig(root());
    const t2 = await startTask(owner.base, "ask");
    await untilAsync(async () =>
      String((await getTask(owner.base, t2.taskId)).statusMessage).includes(
        "waiting for the owner's approval",
      ),
    );
    const got = await getTask(owner.base, t2.taskId);
    expect(got.status).toBe("working");
    expect(got.inputRequests).toBeUndefined();
  });

  test("an owner-only ask is never an input request; a crafted key is ignored + audited, the ask untouched", async () => {
    // Mutation: answer any pending key without the kind check → the approval resolves.
    const r = rig(root(), { mode: "both" });
    const requests = spyRequests();
    const task = await startTask(r.base, "approve");
    const s = r.host.get(sessionOf(task.taskId));
    await until(() => s?.workUnits()[0]?.state === "waiting");
    await untilAsync(async () =>
      String((await getTask(r.base, task.taskId)).statusMessage).includes("waiting for the owner"),
    );
    expect((await getTask(r.base, task.taskId)).status).toBe("working");
    const requestId = await phoneAsk(r.host, sessionOf(task.taskId));
    const ack = await mcp(r.base, "tasks/update", {
      taskId: task.taskId,
      inputResponses: {
        [requestId]: { action: "accept", content: { decision: "allow" } },
        unknown: { action: "accept", content: { decision: "allow" } },
      },
    });
    expect(ack.result).toEqual({ resultType: "complete" });
    expect(requests.filter((q) => q.method === "session/resolve_permission")).toEqual([]);
    expect(r.audit).toContain("mcp-answer-refused");
    expect(s?.workUnits()[0]?.state).toBe("waiting");
    expect(r.ran).toEqual([]);
  });

  test("a key answers only ITS task: another task's ask named through an ended task is refused", async () => {
    // Mutation: drop the per-task check (any pending caller ask of the session) → the ask resolves.
    const r = rig(root(), { mode: "both" });
    const requests = spyRequests();
    const first = await startTask(r.base, "hello");
    await untilStatus(r.base, first.taskId, "completed");
    const next = await callTool(r.base, "session_send", {
      sessionId: sessionOf(first.taskId),
      text: "ask",
    });
    const nextId = String(next.result?.taskId);
    const waiting = await untilStatus(r.base, nextId, "input_required");
    const key = Object.keys(waiting.inputRequests as object)[0] ?? "";
    const ack = await mcp(r.base, "tasks/update", {
      taskId: first.taskId,
      inputResponses: { [key]: { action: "accept", content: { decision: "allow" } } },
    });
    expect(ack.result).toEqual({ resultType: "complete" });
    expect(requests.filter((q) => q.method === "session/resolve_permission")).toEqual([]);
    expect(r.audit).toContain("mcp-answer-refused");
    expect((await getTask(r.base, nextId)).status).toBe("input_required");
    expect(r.ran).toEqual([]);
  });

  test("a failed turn → completed + isError, never failed", async () => {
    // Mutation: map the unit's `failed` to the task's `failed` → red.
    const r = rig(root());
    const task = await startTask(r.base, "fail");
    await untilAsync(async () => (await getTask(r.base, task.taskId)).status !== "working");
    const got = await getTask(r.base, task.taskId);
    expect(got.status).toBe("completed");
    expect((got.result as { isError?: boolean }).isError).toBe(true);
    expect(got.error).toBeUndefined();
  });

  test("tasks/cancel → cancelled; unknown → -32602", async () => {
    const r = rig(root());
    const task = await startTask(r.base, "hang");
    expect((await mcp(r.base, "tasks/cancel", { taskId: task.taskId })).result).toEqual({
      resultType: "complete",
    });
    await untilStatus(r.base, task.taskId, "cancelled");
    expect((await mcp(r.base, "tasks/cancel", { taskId: "nope.nope" })).error?.code).toBe(-32602);
  });

  test("a forged / foreign / malformed taskId → -32602, the same answer as a truly unknown one", async () => {
    // Mutation: resolve the session from the taskId WITHOUT the token's caller → the other caller reads it.
    const r = rig(root());
    const task = await startTask(r.base, "hello");
    await untilStatus(r.base, task.taskId, "completed");
    const asOther = await mcp(
      r.base,
      "tasks/get",
      { taskId: task.taskId },
      undefined,
      "other-token",
    );
    expect(asOther.error?.code).toBe(-32602);
    const s = task.taskId.slice(0, 36);
    const errors = [];
    for (const taskId of [`${s}.00000000-0000-0000-0000-000000000000`, "x", "", `${s}`]) {
      errors.push((await mcp(r.base, "tasks/get", { taskId })).error);
    }
    for (const e of [asOther.error, ...errors]) {
      expect(e).toEqual({ code: -32602, message: "unknown task" });
    }
    const upd = await mcp(
      r.base,
      "tasks/update",
      { taskId: task.taskId, inputResponses: {} },
      undefined,
      "other-token",
    );
    expect(upd.error?.code).toBe(-32602);
  });
});

describe("mcp tasks — durable records", () => {
  test("compaction and a restart → tasks/get unchanged", async () => {
    const dirA = root();
    const first = rig(dirA);
    const task = await startTask(first.base, "hello");
    const before = await untilStatus(first.base, task.taskId, "completed");
    const sessionId = sessionOf(task.taskId);
    const s = first.host.get(sessionId);
    if (s === undefined) throw new Error("no session");
    await s.compact();
    expect(await getTask(first.base, task.taskId)).toEqual(before);
    await s.persisted();
    await first.persister.stop();
    const second = rig(dirA);
    const loaded = await second.persister.load(sessionId);
    if (!loaded.ok) throw new Error(loaded.reason);
    second.host.restore(loaded.record);
    expect(await getTask(second.base, task.taskId)).toEqual(before);
  });

  test("an archived session is read-only: tasks/get answers, the store is byte-identical", async () => {
    const dirA = root();
    const r = rig(dirA);
    const task = await startTask(r.base, "hello");
    const before = await untilStatus(r.base, task.taskId, "completed");
    const sessionId = sessionOf(task.taskId);
    r.tools.dispose();
    expect(r.host.close(sessionId)).toBe(true);
    await until(() => r.host.archivedSessions().some((a) => a.id === sessionId));
    // At rest: the archive write landed and the session's lock is released.
    const atRest = async () => {
      await r.persister.flush(sessionId);
      let files = await snapshot(dirA);
      await untilAsync(async () => {
        files = await snapshot(dirA);
        return ![...files.keys()].some((f) => f.endsWith(".lock"));
      });
      return files;
    };
    const files = await atRest();
    const got = await getTask(r.base, task.taskId);
    expect(got).toEqual(before);
    expect(r.host.get(sessionId)).toBeUndefined();
    expect(await atRest()).toEqual(files);
  });
});
