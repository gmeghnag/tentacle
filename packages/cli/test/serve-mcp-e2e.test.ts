/**
 * docs/feat/serve-mcp-server.md M5: `serve --mcp-token` end to end — a real
 * `startDaemon` (loopback, port 0) with a scripted model, driven by three real
 * MCP clients (SDK v2 + ext-tasks, SDK v2 alone, tentacle's own `packages/mcp`),
 * plus the flag parsers. Each test names its mutation (AGENTS §9).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "@tentacle/config";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { McpClient, createStreamableHttpTransport } from "@tentacle/mcp";
import { ARGS, parseArgs, resolveMcpToken } from "../src/flags.ts";
import { mcpAddHint, parseMcpAsks } from "../src/serve-mcp-server.ts";
import { type ServeOptions, startDaemon } from "../src/serve.ts";

const TOKEN = "mcp-secret";
const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];
const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const c of closers.splice(0)) await Promise.resolve(c()).catch(() => {});
  for (const h of handles.splice(0)) await h.stop().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Answers "pong"; with a gate it waits (honouring the turn's abort) before answering. */
class PongModel implements ModelProvider {
  readonly id = "pong";
  gate: Promise<void> | undefined;
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (this.gate !== undefined) {
      await Promise.race([
        this.gate,
        new Promise<void>((resolve) => request.signal?.addEventListener("abort", () => resolve())),
      ]);
    }
    if (request.signal?.aborted) {
      return;
    }
    yield { type: "text", delta: "pong" };
    yield { type: "done" };
  }
}

function gated(model: PongModel): () => void {
  let open: () => void = () => {};
  model.gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => open();
}

async function serve(model: PongModel, over: Partial<ServeOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "serve-mcp-"));
  dirs.push(root);
  const cwd = join(root, "proj");
  const configDir = join(root, "config");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const config = await loadConfig({
    configDir,
    cwd,
    scaffold: false,
    env: { HOME: root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const audit: string[] = [];
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    discovery: false,
    relay: { noRelay: true },
    createProvider: () => model,
    onAudit: (line) => audit.push(line),
    mcp: { token: TOKEN },
    ...over,
  });
  handles.push(handle);
  const base = new URL(handle.url.replace(/^ws/, "http")).origin;
  return { handle, base, url: `${base}/mcp`, audit };
}

const auth = { authorization: `Bearer ${TOKEN}` };

/** The JSON a tool answered with (its first text block). */
function json(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const text = content.find((c) => c.type === "text")?.text;
  return text === undefined ? {} : (JSON.parse(text) as Record<string, unknown>);
}

/** Wait (bounded, throwing) on `session_status` until `state` is one of `want`. */
async function untilState(
  status: () => Promise<Record<string, unknown>>,
  want: string[],
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const s = await status();
    if (want.includes(String(s.state))) return s;
    if (Date.now() > deadline) throw new Error(`state stuck at ${String(s.state)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("flags", () => {
  test("--mcp-token / --mcp-token-command resolve; both, empty and a lone --mcp-asks are refused", async () => {
    // mutation: fall back to --token / the env when absent → "no token" case turns on MCP
    expect(await resolveMcpToken(new Map())).toBeUndefined();
    expect(await resolveMcpToken(new Map([["mcp-token", "t"]]))).toBe("t");
    expect(await resolveMcpToken(new Map([["mcp-token-command", "printf cmd-token"]]))).toBe(
      "cmd-token",
    );
    await expect(
      resolveMcpToken(
        new Map([
          ["mcp-token", "a"],
          ["mcp-token-command", "echo b"],
        ]),
      ),
    ).rejects.toThrow("not both");
    await expect(resolveMcpToken(new Map([["mcp-token", ""]]))).rejects.toThrow("empty");
    const parsed = parseArgs(["--mcp-token", "x", "--mcp-asks", "both"], ARGS.serve);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.flags.get("mcp-asks")).toBe("both");
  });

  test("--mcp-asks: owner | both, anything else fails closed", () => {
    // mutation: default an unknown value to "both" → the throw case is red
    expect(parseMcpAsks(undefined)).toBe("owner");
    expect(parseMcpAsks("both")).toBe("both");
    expect(() => parseMcpAsks("all")).toThrow('--mcp-asks must be "owner" or "both"');
  });

  test("the startup hint carries a placeholder, never a token", () => {
    // mutation: interpolate the real token → the placeholder assertion is red
    const hint = mcpAddHint("http://127.0.0.1:4000");
    expect(hint).toContain("http://127.0.0.1:4000/mcp");
    expect(hint).toContain("Bearer <token>");
  });
});

describe("serve --mcp-token", () => {
  test("tentacle's own client (legacy initialize): start → status until completed with the answer", async () => {
    // mutation: wire McpTools over a different SessionHost → the session never completes
    const { url } = await serve(new PongModel());
    const client = new McpClient(
      createStreamableHttpTransport({ type: "http", url, headers: auth }),
    );
    closers.push(() => client.close());
    await client.initialize({ legacyOnly: true });
    const started = json(await client.callTool("session_start", { prompt: "ping" }));
    const sessionId = String(started.sessionId);
    expect(sessionId).toMatch(/^mcp-default-/);
    const done = await untilState(
      async () => json(await client.callTool("session_status", { sessionId, waitSeconds: 5 })),
      ["completed"],
    );
    expect(JSON.stringify(done)).toContain("pong");
  });

  test("SDK v2 (legacy era, no tasks): plain results, session_status waits until completed", async () => {
    // mutation: always answer a task → the plain `sessionId` read is red
    const { url } = await serve(new PongModel());
    const client = new Client({ name: "e2e", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth } }),
    );
    closers.push(() => client.close());
    const started = json(
      await client.callTool({ name: "session_start", arguments: { prompt: "ping" } }),
    );
    const sessionId = String(started.sessionId);
    const done = await untilState(
      async () =>
        json(
          await client.callTool({
            name: "session_status",
            arguments: { sessionId, waitSeconds: 5 },
          }),
        ),
      ["completed"],
    );
    expect(JSON.stringify(done)).toContain("pong");
  });

  test("a WS client sees the MCP session in session/list; a wrong or missing token is 401", async () => {
    // mutation: accept any bearer on /mcp → the 401 asserts are red
    const model = new PongModel();
    const release = gated(model);
    const { url, handle, audit } = await serve(model);
    const client = new McpClient(
      createStreamableHttpTransport({ type: "http", url, headers: auth }),
    );
    closers.push(() => client.close());
    await client.initialize({ legacyOnly: true });
    const sessionId = String(
      json(await client.callTool("session_start", { prompt: "ping" })).sessionId,
    );
    const ws = new WebSocket(handle.url);
    closers.push(() => ws.close());
    const replies = new Map<number, { result?: unknown }>();
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (typeof m.id === "number") replies.set(m.id, m);
    };
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    const ask = async (id: number, method: string, params: unknown) => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      const deadline = Date.now() + 3000;
      while (!replies.has(id)) {
        if (Date.now() > deadline) throw new Error(`no reply to ${method}`);
        await new Promise((r) => setTimeout(r, 10));
      }
      return replies.get(id);
    };
    await ask(1, "initialize", {
      protocolVersion: (await import("@tentacle/protocol")).PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const listed = await ask(2, "session/list", {});
    expect(JSON.stringify(listed?.result)).toContain(sessionId);
    release();
    const badAuth: Record<string, string>[] = [{ authorization: "Bearer nope" }, {}];
    for (const headers of badAuth) {
      const res = await fetch(url, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
      expect(res.status).toBe(401);
    }
    expect(audit).toContain("mcp-auth-failure");
  });

  test("off without a token: /mcp is not mounted", async () => {
    // mutation: always mount the route → 404 becomes 401
    const { base } = await serve(new PongModel(), { mcp: undefined });
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(res.status).not.toBe(200);
    expect(res.status).not.toBe(401);
  });
});
