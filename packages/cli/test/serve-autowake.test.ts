import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { startDaemon } from "../src/serve.ts";

// `serve` wakes a session nobody is attached to when a background job ends,
// per ITS host's `autoWake` (docs/feat/serve-autowake.md): end to end over the
// real `startDaemon`, a fake OpenAI-compatible endpoint and a real background
// `sleep`. Mutation: drop `wakeOnJobExit: config.autoWake` in `startDaemon` →
// the "on" test gets no third model request.

interface WireMessage {
  readonly role: string;
  readonly content?: string | null;
}

const sse = (events: unknown[]): Response =>
  new Response(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
const say = (text: string): Response =>
  sse([
    { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
const startJob = (): Response =>
  sse([
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: {
                  name: "shell",
                  arguments: JSON.stringify({ command: "sleep 0.3", run_in_background: true }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("serve: the daemon wakes a detached session on a job exit (its own autoWake)", () => {
  let dir: string;
  let config: TentacleConfig;
  let server: ReturnType<typeof Bun.serve>;
  /** Every chat request's messages, in order. */
  let requests: WireMessage[][] = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "serve-autowake-"));
    saved.TENTACLE_CONFIG_DIR = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: WireMessage[] };
        requests.push(body.messages);
        // 1: start the job; 2: end the turn; 3+: the wake's answer.
        return requests.length === 1
          ? startJob()
          : say(requests.length === 2 ? "started" : "woken");
      },
    });
    config = {
      ...(await loadConfig({ cwd: dir })),
      provider: "openai",
      baseURL: `http://127.0.0.1:${server.port}/v1`,
      model: "fake",
      apiKey: "k",
    };
  });

  afterAll(async () => {
    server.stop(true);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  });

  /** One project directory per daemon: its own store and lock. */
  async function project(name: string): Promise<TentacleConfig> {
    const cwd = join(dir, name);
    await mkdir(cwd, { recursive: true });
    return { ...config, cwd };
  }

  async function client(url: string) {
    const ws = new WebSocket(url);
    const replies = new Map<number, { result?: Record<string, unknown>; error?: unknown }>();
    const updates: Array<{ type: string } & Record<string, unknown>> = [];
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      if (typeof msg.id === "number") replies.set(msg.id, msg);
      else if (msg.method === "session/update") updates.push(msg.params.update);
    };
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    let id = 0;
    const request = async (method: string, params: unknown) => {
      const n = ++id;
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
      await until(() => replies.has(n));
      return replies.get(n);
    };
    await request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    return { ws, request, updates };
  }

  /** A turn that starts `sleep 0.3` in the background (approved), ended; then the client detaches. */
  async function startJobAndDetach(url: string, sessionId: string): Promise<void> {
    const c = await client(url);
    await c.request("session/open", { sessionId, create: true });
    await c.request("session/prompt", {
      sessionId,
      turnId: "t1",
      content: [{ type: "text", text: "start the job" }],
    });
    await until(() => c.updates.some((u) => u.type === "permission_request"));
    const ask = c.updates.find((u) => u.type === "permission_request");
    await c.request("session/resolve_permission", {
      sessionId,
      requestId: ask?.requestId,
      optionId: "allow_once",
    });
    await until(() => c.updates.some((u) => u.type === "turn_end"));
    await c.request("session/detach", { sessionId });
    c.ws.close();
  }

  test("autoWake on (the default): one wake turn after the job ends; a re-attach sees it", async () => {
    requests = [];
    expect(config.autoWake).toBe(true);
    const handle = await startDaemon(await project("on"), { host: "127.0.0.1", port: 0 });
    try {
      await startJobAndDetach(handle.url, "on");
      await until(() => requests.length >= 3, 4000);
      const last = requests[2]?.at(-1);
      expect(last?.role).toBe("user");
      expect(String(last?.content)).toStartWith("[background] job ");
      // Exactly one wake.
      await new Promise((r) => setTimeout(r, 300));
      expect(requests.length).toBe(3);
      // `connect --resume`: the wake turn is in the session; nothing left unflushed.
      const b = await client(handle.url);
      const opened = await b.request("session/open", { sessionId: "on" });
      expect(opened?.result).not.toHaveProperty("unflushedExits");
      const snap = await b.request("session/snapshot", { sessionId: "on" });
      const messages = (snap?.result?.messages ?? []) as WireMessage[];
      expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "woken" });
      b.ws.close();
    } finally {
      await handle.stop();
    }
  }, 15_000);

  test('"autoWake": false on the serve host: no turn; the next attach is told', async () => {
    requests = [];
    const handle = await startDaemon(
      { ...(await project("off")), autoWake: false },
      { host: "127.0.0.1", port: 0 },
    );
    try {
      await startJobAndDetach(handle.url, "off");
      await new Promise((r) => setTimeout(r, 1000));
      expect(requests.length).toBe(2);
      const b = await client(handle.url);
      const opened = await b.request("session/open", { sessionId: "off" });
      expect(opened?.result?.unflushedExits).toBe(1);
      b.ws.close();
    } finally {
      await handle.stop();
    }
  }, 15_000);
});
