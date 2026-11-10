import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { webSocketChannelFactory } from "@tentacle/client";
import type { PermissionBroker, PermissionRequester } from "@tentacle/core";
import { PROTOCOL_VERSION, WAKE_TURN_PREFIX } from "@tentacle/protocol";
import { type TuiOptions, autoAcceptTest, autoApproves, ownRequest } from "@tentacle/tui";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { connectTui } from "../src/connect.ts";
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
    const c = await jobTurn(url, sessionId);
    await c.request("session/detach", { sessionId });
    c.ws.close();
  }

  /** The same turn, the client still attached. */
  async function jobTurn(url: string, sessionId: string) {
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
    return c;
  }

  test("a client STAYS attached (connect, which never wakes): the daemon wakes once, live", async () => {
    // The orchestrator's live failure (fix round 2): nobody woke while `connect` was attached.
    // Mutation: block the daemon's gate while a client is attached → no third request.
    requests = [];
    const handle = await startDaemon(await project("attached"), { host: "127.0.0.1", port: 0 });
    try {
      const c = await jobTurn(handle.url, "attached");
      await until(() => requests.length >= 3, 4000);
      expect(String(requests[2]?.at(-1)?.content)).toStartWith("[background] job ");
      // The client watched the wake live: a second turn_start (empty prompt), then its end.
      await until(() => c.updates.filter((u) => u.type === "turn_end").length >= 2);
      const starts = c.updates.filter((u) => u.type === "turn_start");
      expect(starts.map((u) => u.prompt)).toEqual(["start the job", ""]);
      // The wake turn's id is the daemon's OWN reservation: `wake-` + a uuid, the
      // one prefix a client may not mint (docs/fix/autoaccept-wake-turns.md A1/A2).
      // Mutation: mint it with anything else → red, and every `connect` TUI stops
      // recognising the session's own wake.
      expect(String(starts[1]?.turnId)).toStartWith(WAKE_TURN_PREFIX);
      await new Promise((r) => setTimeout(r, 300));
      expect(requests.length).toBe(3);
      c.ws.close();
    } finally {
      await handle.stop();
    }
  }, 15_000);

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

// docs/fix/autoaccept-wake-turns.md T3: the REAL stack — a `serve` daemon plus the
// real `connectTui`, whose TUI decides auto-accept exactly as `usePermissionBroker`
// does (`autoAcceptsTurn` through `autoAcceptTest`). This is the repro
// (`.tentacle/tmp/autoaccept-wake/repro.ts`) as a test.
describe("T3: connect's TUI auto-accepts the session's own wake turn", () => {
  let dir: string;
  let config: TentacleConfig;
  let server: ReturnType<typeof Bun.serve>;
  /** How many model requests the fake endpoint served. */
  let requests = 0;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "connect-wake-"));
    saved.TENTACLE_CONFIG_DIR = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.json();
        requests += 1;
        // 1: a background `sleep 0.3`; 2: end the turn; 3 (the WAKE): `echo woke`; 4: end.
        if (requests === 1) {
          return sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c1",
                        function: {
                          name: "shell",
                          arguments: JSON.stringify({
                            command: "sleep 0.3",
                            run_in_background: true,
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]);
        }
        if (requests === 2) return say("started");
        if (requests === 3) {
          return sse([
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "c2",
                        function: {
                          name: "shell",
                          arguments: JSON.stringify({ command: "echo woke" }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
          ]);
        }
        return say("done");
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

  async function project(name: string): Promise<TentacleConfig> {
    const cwd = join(dir, name);
    await mkdir(cwd, { recursive: true });
    return { ...config, cwd };
  }

  /**
   * A `connect` whose TUI is faked: the fake requester decides EXACTLY as
   * `usePermissionBroker` does — `autoApproves(req, ownRequest(turnId, autoAcceptTest(session)))`
   * — with auto-accept ON, and holds anything it may not answer (a human's job).
   */
  async function connectWithAutoAccept(
    url: string,
    log: string[],
  ): Promise<{ asks: number; modelRequests: () => number }> {
    const held: string[] = [];
    await connectTui({ url, configDir: join(dir, "config") }, () => {}, {
      dial: webSocketChannelFactory,
      startTui: (async (_agent: unknown, options: TuiOptions) => {
        const session = options.createSession?.();
        if (session === undefined) throw new Error("no session factory");
        (options.permissions as PermissionBroker).setRequester((req, opts) => {
          const own = ownRequest(opts?.turnId, autoAcceptTest(session));
          const auto = autoApproves(req, own);
          log.push(`ask turnId=${opts?.turnId} tool=${req.tool} own=${own} auto=${auto}`);
          if (auto) {
            return Promise.resolve({ allowed: true, scope: "once" });
          }
          held.push(String(opts?.turnId));
          return new Promise(() => {});
        });
        for await (const _event of session.send("start the job")) {
          // drain
        }
        // Let the wake run (mine is answered at once; a held one never ends).
        await until(() => requests >= 4, 4000).catch(() => {});
        await new Promise((r) => setTimeout(r, 150));
      }) as never,
    });
    return { asks: held.length, modelRequests: () => requests };
  }

  test("the wake turn's ask is auto-accepted by connect's TUI: no held prompt, and the wake completes", async () => {
    // RED before the fix (the repro printed `own=false auto-accepted=false` and
    // the model stopped at 3 requests). MUTATION: drop `daemonWakes: true` from
    // `connect.ts` → `own=false` for the wake, the ask is held, the model stalls.
    requests = 0;
    const mention: string[] = [];
    const handle = await startDaemon(await project("wake"), { host: "127.0.0.1", port: 0 });
    try {
      const out = await connectWithAutoAccept(handle.url, mention);
      expect(out.modelRequests()).toBeGreaterThanOrEqual(4);
      expect(out.asks).toBe(0);
      // The first ask is the minted turn's (own), the second is the daemon's wake.
      const wake = mention.find((line) => line.includes("turnId=wake-"));
      expect(wake).toBeDefined();
      expect(wake).toContain("own=true");
      expect(wake).toContain("auto=true");
    } finally {
      await handle.stop();
    }
  }, 20_000);

  test("C5 still holds: a foreign turn's ask is held by connect's TUI (the widened test is not a wildcard)", async () => {
    // The widened test is `ownsTurn || (daemonWakes && wake-)`. A turn another
    // client really mints keeps a random id, so its ask is still asked here.
    // Mutation: make `autoAcceptsTurn` accept anything → the ask is answered.
    requests = 0;
    const mention: string[] = [];
    const held: string[] = [];
    const handle = await startDaemon(await project("foreign"), { host: "127.0.0.1", port: 0 });
    try {
      await connectTui({ url: handle.url, configDir: join(dir, "config") }, () => {}, {
        dial: webSocketChannelFactory,
        startTui: (async (_agent: unknown, options: TuiOptions) => {
          const session = options.createSession?.();
          if (session === undefined || options.permissions === undefined) {
            throw new Error("no session factory or broker");
          }
          const broker = options.permissions;
          const requester: PermissionRequester = (req, opts) => {
            const own = ownRequest(opts?.turnId, autoAcceptTest(session));
            const auto = autoApproves(req, own);
            mention.push(`ask turnId=${opts?.turnId} auto=${auto}`);
            if (auto) return Promise.resolve({ allowed: true, scope: "once" });
            held.push(String(opts?.turnId));
            return new Promise(() => {});
          };
          broker.setRequester(requester);
          // The whole session's own turn runs (a wake included) — nothing is held.
          for await (const _event of session.send("start the job")) {
            // drain
          }
          await until(() => requests >= 4, 4000).catch(() => {});
          await new Promise((r) => setTimeout(r, 100));
          // Now an ask of a turn this session did NOT mint and that is not a wake.
          const foreign: unknown[] = [];
          void broker
            .request(
              { tool: "shell", level: "ask", title: "Run theirs", input: {} } as never,
              { turnId: "F1" } as never,
            )
            .then((r) => foreign.push(r));
          await new Promise((r) => setTimeout(r, 60));
          mention.push(`foreign answered without a human: ${foreign.length > 0}`);
        }) as never,
      });
      // Only the deliberately foreign ask was held: no wake turn ever was.
      expect(held.filter((id) => id.startsWith(WAKE_TURN_PREFIX))).toEqual([]);
      expect(held).toEqual(["F1"]);
      // The wake was answered, and the foreign ask was NOT.
      expect(
        mention.some((line) => line.includes("turnId=wake-") && line.includes("auto=true")),
      ).toBe(true);
      expect(mention.at(-1)).toBe("foreign answered without a human: false");
    } finally {
      await handle.stop();
    }
  }, 20_000);
});
