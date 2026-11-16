/**
 * docs/fix/serve-autoaccept-unattended.md, end to end over the REAL
 * `startDaemon`: a `serve` session with auto-accept ON is answered by the
 * daemon, so it keeps running after its client goes away. Mutation: delete
 * `answersAutoAccept: true` from `startDaemon` (`serve.ts`) → red. The getter
 * pins: the pod host and the worker host never answer on their own (mutation:
 * add the bit to `podSessionHost` → red).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { podSessionHost, startDaemon } from "../src/serve.ts";
import { workerSessionHost } from "../src/worker.ts";

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
/** A round that calls `shell` (a tool that ASKS) once. */
const askShell = (): Response =>
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
                  arguments: JSON.stringify({ command: "echo hello" }),
                },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ]);

async function until(cond: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${String(cond)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("serve: the daemon answers an auto-accepted ask itself", () => {
  let dir: string;
  let config: TentacleConfig;
  let server: ReturnType<typeof Bun.serve>;
  /** Every chat request's messages, in order (one per model round). */
  let requests: WireMessage[][] = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "serve-autoaccept-"));
    saved.TENTACLE_CONFIG_DIR = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { messages: WireMessage[] };
        requests.push(body.messages);
        // 1: ask for the shell call; 2: finish the turn after it ran.
        return requests.length === 1 ? askShell() : say("done");
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

  /** A raw JSON-RPC client on the daemon's WebSocket. */
  async function client(url: string) {
    const ws = new WebSocket(url);
    const replies = new Map<number, { result?: Record<string, unknown>; error?: unknown }>();
    const updates: Array<{ type: string; turnId?: string } & Record<string, unknown>> = [];
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

  test("the phone sets auto-accept ON, prompts, closes its socket: the turn ends, the tool ran once", async () => {
    requests = [];
    const handle = await startDaemon(await project("detached"), { host: "127.0.0.1", port: 0 });
    try {
      const phone = await client(handle.url);
      await phone.request("session/open", { sessionId: "S", create: true });
      expect(
        (await phone.request("session/set_auto_accept", { sessionId: "S", on: true }))?.result,
      ).toEqual({ on: true });
      await phone.request("session/prompt", {
        sessionId: "S",
        turnId: "t1",
        content: [{ type: "text", text: "run it" }],
      });
      // The app closes as soon as it has seen the ask (the owner's report).
      await until(() => phone.updates.some((u) => u.type === "permission_request"));
      await phone.request("session/detach", { sessionId: "S" });
      phone.ws.close();
      // The daemon answers it itself: the turn ends and the tool ran (round 2).
      await until(() => requests.length === 2, 8000);

      const later = await client(handle.url);
      const opened = await later.request("session/open", { sessionId: "S" });
      expect(opened?.error).toBeUndefined();
      // Nothing is pending: the ask was answered, not left waiting.
      const snapshot = await later.request("session/snapshot", { sessionId: "S" });
      const messages = (snapshot?.result?.messages ?? []) as WireMessage[];
      expect(messages.some((m) => m.role === "tool")).toBe(true);
      await later.request("session/detach", { sessionId: "S" });
      later.ws.close();
    } finally {
      await handle.stop();
    }
  }, 20000);

  test("the pod host and the worker host never answer on their own", async () => {
    // Mutation: add `answersAutoAccept: true` to `podSessionHost` (or the
    // worker) → red. AGENTS §7: a daemon-side check is UX on a pod.
    const pod = podSessionHost(await project("pod"), undefined, {});
    expect(pod.answersAutoAccept).toBe(false);
    const worker = workerSessionHost(await project("worker"), { version: "test" });
    expect(worker.answersAutoAccept).toBe(false);
    // And `serve`'s own host says it does (the trust bit the CLI sets).
    const handle = await startDaemon(await project("bit"), { host: "127.0.0.1", port: 0 });
    try {
      const c = await client(handle.url);
      // The bit is not on the wire: prove it by the daemon's behaviour instead
      // (the test above), and pin the getter through the exported host factory.
      expect(c.ws.readyState).toBe(1);
    } finally {
      await handle.stop();
    }
  }, 20000);
});
