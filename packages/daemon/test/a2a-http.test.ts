/**
 * docs/feat/a2a.md slice S9: the A2A HTTP route over a real `startWsServer`
 * (loopback, port 0). The request handler is a fake: this file pins the route
 * (auth, Origin, 413, version, SSE, timeout, fall-through), not the executor.
 * Each test names its mutation (§9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Role, type StreamResponse } from "@a2a-js/sdk";
import type { A2ARequestHandler as SdkRequestHandler } from "@a2a-js/sdk/server";
import { createA2ARoute } from "../src/a2a/http.ts";
import { buildAgentCard } from "../src/a2a/mapping.ts";
import { SessionHost } from "../src/session-host.ts";
import { type RunningServer, startWsServer } from "../src/ws-server.ts";

const TOKEN = "a2a-secret-token";
const card = buildAgentCard({ url: "http://127.0.0.1:1/a2a", version: "0.0.1" });
const seenCallers: (string | undefined)[] = [];
let gate: Promise<void> = Promise.resolve();

const reply = (text: string) => ({
  messageId: "m1",
  contextId: "c1",
  taskId: "",
  role: Role.ROLE_AGENT,
  parts: [
    { content: { $case: "text" as const, value: text }, mediaType: "", filename: "", metadata: {} },
  ],
  metadata: {},
  extensions: [],
  referenceTaskIds: [],
});

const fakeHandler = {
  getAgentCard: async () => card,
  async sendMessage(_p: unknown, ctx: { user?: { userName: string } }) {
    seenCallers.push(ctx.user?.userName);
    await gate;
    return reply("hi");
  },
  async *sendMessageStream(
    _p: unknown,
    ctx: { user?: { userName: string } },
  ): AsyncGenerator<StreamResponse> {
    seenCallers.push(ctx.user?.userName);
    yield { payload: { $case: "message", value: reply("one") } };
    await gate;
    yield { payload: { $case: "message", value: reply("two") } };
  },
  async getTask() {
    throw new Error("boom: internal detail");
  },
} as unknown as SdkRequestHandler;

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  gate = Promise.resolve();
  seenCallers.length = 0;
});

function start(
  extra: { a2a?: boolean; pingMs?: number; maxBodyBytes?: number; audit?: string[] } = {},
) {
  const host = new SessionHost({
    defaultCwd: "/tmp/a2a-http",
    createAgent: () => {
      throw new Error("no session in an http test");
    },
  });
  const route =
    extra.a2a === false
      ? undefined
      : createA2ARoute({
          requestHandler: fakeHandler,
          card,
          callers: [{ name: "default", token: TOKEN }],
          ...(extra.pingMs !== undefined ? { pingMs: extra.pingMs } : {}),
          ...(extra.maxBodyBytes !== undefined ? { maxBodyBytes: extra.maxBodyBytes } : {}),
          ...(extra.audit !== undefined ? { onAudit: (l: string) => extra.audit?.push(l) } : {}),
        });
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: host,
    ...(route !== undefined ? { a2a: route } : {}),
    ...(extra.audit !== undefined ? { onAudit: (l: string) => extra.audit?.push(l) } : {}),
  });
  servers.push(server);
  return new URL(server.url.replace(/^ws/, "http")).origin;
}

const rpc = (method: string, params: unknown = {}, id: number | string = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
const post = (base: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${base}/a2a`, {
    method: "POST",
    body,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
      "a2a-version": "1.0",
      ...headers,
    },
  });
const MSG = { message: { messageId: "x", role: "ROLE_USER", parts: [{ text: "hi" }] } };

describe("A2A http route", () => {
  test("card is public, GET only", async () => {
    // mutation: require the token on the card path → the first assertion fails
    const base = start();
    const res = await fetch(`${base}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; skills: { id: string }[] };
    expect(body.name).toBe("tentacle");
    expect(body.skills.map((s) => s.id)).toEqual(["tentacle-session"]);
    const bad = await fetch(`${base}/.well-known/agent-card.json`, { method: "POST" });
    expect(bad.status).toBe(405);
  });

  test("no / wrong token → 401 + audit; the handler never runs", async () => {
    // mutation: skip authenticateCaller → a call without a token reaches the handler (seenCallers non-empty)
    const audit: string[] = [];
    const base = start({ audit });
    const none = await fetch(`${base}/a2a`, { method: "POST", body: rpc("SendMessage", MSG) });
    const wrong = await post(base, rpc("SendMessage", MSG), { authorization: "Bearer nope" });
    const empty = await post(base, rpc("SendMessage", MSG), { authorization: "Bearer " });
    const inUrl = await fetch(`${base}/a2a?token=${TOKEN}`, {
      method: "POST",
      body: rpc("SendMessage", MSG),
    });
    expect([none.status, wrong.status, empty.status, inUrl.status]).toEqual([401, 401, 401, 401]);
    expect(audit.filter((l) => l === "a2a-auth-failure")).toHaveLength(4);
    expect(seenCallers).toEqual([]);
  });

  test("a browser Origin → 401 even with the right token", async () => {
    // mutation: drop the Origin check in authenticateCaller → 200
    const base = start();
    const res = await post(base, rpc("SendMessage", MSG), { origin: "https://evil.example" });
    expect(res.status).toBe(401);
    expect(seenCallers).toEqual([]);
  });

  test("a valid call reaches the handler with the token's caller", async () => {
    const base = start();
    const res = await post(base, rpc("SendMessage", MSG));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { message: { messageId: string } } };
    expect(body.result.message.messageId).toBe("m1");
    expect(seenCallers).toEqual(["default"]);
  });

  test("body over the cap → 413 (declared and streamed), nothing parsed", async () => {
    // mutation: no cap → 200
    const base = start({ maxBodyBytes: 200 });
    const big = rpc("SendMessage", { ...MSG, pad: "x".repeat(500) });
    expect((await post(base, big)).status).toBe(413);
    const chunked = await fetch(`${base}/a2a`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "a2a-version": "1.0",
      },
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(big));
          c.close();
        },
      }),
      duplex: "half",
    });
    expect(chunked.status).toBe(413);
    expect(seenCallers).toEqual([]);
  });

  test("version: unsupported → -32009; absent → -32009 (no implicit 0.3)", async () => {
    // mutation: skip validateVersion → no -32009
    const base = start();
    const old = (await (
      await post(base, rpc("SendMessage", MSG), { "a2a-version": "0.3" })
    ).json()) as { error: { code: number } };
    expect(old.error.code).toBe(-32009);
    const res = await fetch(`${base}/a2a`, {
      method: "POST",
      body: rpc("SendMessage", MSG),
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    });
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32009);
    expect(seenCallers).toEqual([]);
  });

  test("unknown method → -32601; bad JSON → -32700; bad params → -32602; wrong content type → -32005", async () => {
    // mutation: map an unknown method to a 500 → the first assertion fails
    const base = start();
    const code = async (r: Response) =>
      ((await r.json()) as { error: { code: number } }).error.code;
    expect(await code(await post(base, rpc("Nope")))).toBe(-32601);
    expect(await code(await post(base, "{not json"))).toBe(-32700);
    expect(await code(await post(base, rpc("SendMessage", "str")))).toBe(-32602);
    expect(
      await code(await post(base, rpc("SendMessage", MSG), { "content-type": "text/plain" })),
    ).toBe(-32005);
  });

  test("an internal error is 500 and never leaks its message", async () => {
    // mutation: echo error.message → the secret text appears
    const base = start();
    const res = await post(base, rpc("GetTask", { id: "t1" }));
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain("boom: internal detail");
  });

  test("only POST /a2a: other methods 405", async () => {
    const base = start();
    expect((await fetch(`${base}/a2a`)).status).toBe(405);
  });

  test("streaming: SSE events, then a ping on the heartbeat; the caller dropping ends the stream quietly", async () => {
    // mutation: no ping interval → no `: ping` in the body
    let release: () => void = () => {};
    gate = new Promise((r) => {
      release = r;
    });
    const base = start({ pingMs: 20 });
    const res = await post(base, rpc("SendStreamingMessage", MSG));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("no body");
    const decoder = new TextDecoder();
    let text = "";
    const deadline = Date.now() + 3000;
    while (!text.includes(": ping") && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain('"messageId":"m1"');
    expect(text).toContain(": ping");
    release();
    while (!text.includes('"text":"two"') && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toContain("two");
    await reader.cancel();
  });

  test("a pre-stream error is a plain JSON-RPC error, not an SSE", async () => {
    const base = start();
    const res = await post(base, rpc("SendStreamingMessage", "str"));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602);
  });

  test("a blocking call outlives the idle timeout", async () => {
    // mutation: drop srv.timeout(req, 0) → the unit below fails (the real-server wait is too long for a gate)
    let release: () => void = () => {};
    gate = new Promise((r) => {
      release = r;
    });
    const base = start();
    const pending = post(base, rpc("SendMessage", MSG));
    await new Promise((r) => setTimeout(r, 50));
    release();
    expect((await pending).status).toBe(200);
  });

  test("the route lifts Bun's idle timeout on a POST (timeout(req, 0))", async () => {
    const route = createA2ARoute({
      requestHandler: fakeHandler,
      card,
      callers: [{ name: "default", token: TOKEN }],
    });
    const calls: number[] = [];
    const req = new Request("http://x/a2a", {
      method: "POST",
      body: rpc("SendMessage", MSG),
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "a2a-version": "1.0",
        "content-type": "application/json",
      },
    });
    await route.handle(req, { timeout: (_r, s) => void calls.push(s) });
    expect(calls).toEqual([0]);
    // an unauthenticated call never lifts it
    calls.length = 0;
    await route.handle(new Request("http://x/a2a", { method: "POST", body: "{}" }), {
      timeout: (_r, s) => void calls.push(s),
    });
    expect(calls).toEqual([]);
  });

  test("A2A off → /a2a and the card are 'not expected' as today; the WS route is unaffected", async () => {
    // mutation: mount the route unconditionally → /a2a answers 405/200 instead of the WS 401/426
    const base = start({ a2a: false });
    expect((await fetch(`${base}/.well-known/agent-card.json`)).status).toBe(426);
    expect((await fetch(`${base}/a2a`, { method: "POST" })).status).toBe(426);
  });

  test("A2A on → a WebSocket upgrade still works on other paths", async () => {
    // mutation: route returns a Response for every path → the socket never opens
    const base = start();
    const ws = new WebSocket(`${base.replace(/^http/, "ws")}/`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.onopen = () => resolve(true);
      ws.onerror = () => resolve(false);
    });
    expect(opened).toBe(true);
    ws.close();
  });

  test("no caller → the route is not built (A2A needs a token)", () => {
    expect(() => createA2ARoute({ requestHandler: fakeHandler, card, callers: [] })).toThrow();
  });
});
