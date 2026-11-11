/**
 * A model error on a `serve` daemon is a FAILED TURN carrying the provider's
 * message — never a dead link, never a TUI that can no longer send
 * (docs/fix/connect-model-error-drops-connection.md).
 *
 * The stack is the real one: `startDaemon` (a real WebSocket server) talking to
 * a real OpenAI-compatible endpoint that fails and then recovers, with the real
 * `RemoteClient` on the other end.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { startDaemon } from "../src/serve.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The fake endpoint's answer for the next model call. */
type Answer = () => Response;

let dir = "";
const stops: (() => Promise<void> | void)[] = [];
const savedConfigDir = process.env.TENTACLE_CONFIG_DIR;

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  const key = "TENTACLE_CONFIG_DIR";
  if (savedConfigDir === undefined) {
    delete process.env[key];
  } else {
    process.env.TENTACLE_CONFIG_DIR = savedConfigDir;
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** SSE, as an OpenAI-compatible server answers a chat completion. */
function sse(events: unknown[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

/** One assistant message, as an OpenAI-compatible SSE stream. */
function say(text: string): Response {
  return sse([
    { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ]);
}

/** A real OpenAI-compatible endpoint whose answer each test scripts. */
function endpoint(answers: Answer[]) {
  const calls: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      calls.push(String(req.url));
      const next = answers.shift();
      return next ? next() : new Response("no scripted answer", { status: 500 });
    },
  });
  stops.push(() => server.stop(true));
  return {
    baseURL: `http://127.0.0.1:${server.port}/v1`,
    calls,
  };
}

/** A `serve` daemon over `baseURL`, on its own project dir (own store + lock). */
async function serveAt(baseURL: string, name: string) {
  const config = await projectConfig(baseURL, name);
  const handle = await startDaemon(config, { host: "127.0.0.1", port: 0 });
  stops.push(() => handle.stop());
  return handle;
}

/** A free localhost port, for a daemon that must come back on the same one. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port ?? 0;
}

/** A `serve` config over `baseURL`, in its own project dir (own store + lock). */
async function projectConfig(baseURL: string, name: string): Promise<TentacleConfig> {
  dir = dir || (await mkdtemp(join(tmpdir(), "connect-model-error-")));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  const cwd = join(dir, name);
  await mkdir(cwd, { recursive: true });
  const base = await loadConfig({ cwd });
  return { ...base, provider: "openai", baseURL, model: "fake", apiKey: "test-key" };
}

/** A real `RemoteClient` on the daemon's WebSocket (its link reconnects, like `connect`). */
async function connectTo(url: string): Promise<RemoteClient> {
  const dial = webSocketChannelFactory(url, {});
  const client = new RemoteClient(await dial(), new PermissionBroker(), undefined, {
    channelFactory: dial,
  });
  stops.push(() => client.close());
  await client.initialize();
  return client;
}

/** Send `text` and settle: the turn's text deltas, and how it ended. */
async function sendAndSettle(
  client: RemoteClient,
  session: ReturnType<RemoteClient["newSession"]>,
  text: string,
): Promise<{ texts: string[]; error: string | null }> {
  const texts: string[] = [];
  try {
    for await (const event of session.send(text)) {
      if (event.type === "text") texts.push(event.delta);
    }
    return { texts, error: null };
  } catch (error) {
    return { texts, error: error instanceof Error ? error.message : String(error) };
  }
}

// (a) A model error is a FAILED TURN carrying the provider's message, and the
// link + the session go on. Mutation: drop `exposeTurnErrors: true` from
// `serve.ts` → the first error is "internal error" again.
test("(a) a 401 is a failed turn with the provider's message; the next send works", async () => {
  const api = endpoint([
    () => new Response("Invalid API Key", { status: 401 }),
    () => say("recovered"),
  ]);
  const serve = await serveAt(api.baseURL, "unauthorized");
  const client = await connectTo(serve.url);
  const session = client.newSession();
  const turn = await sendAndSettle(client, session, "hello");
  expect(turn.error).toContain("status 401");
  expect(turn.error).toContain("Invalid API Key");
  // The link never dropped: the same session sends again and the daemon runs it.
  const second = await sendAndSettle(client, session, "hello again");
  expect(second.error).toBeNull();
  expect(second.texts.join("")).toBe("recovered");
});

// The provider's message is TEXT, not a raw upstream body: a key in it is
// masked and it stays one line. Mutation: return the message raw from
// `sanitizeTurnError` → the bearer token shows up.
test("(a) the exposed message is sanitized: no secrets, one line", async () => {
  const api = endpoint([
    () =>
      new Response("bad key Bearer sk-abcdefghijklmnopqrstuvwxyz012345\nsecond line", {
        status: 401,
      }),
  ]);
  const serve = await serveAt(api.baseURL, "sanitized");
  const client = await connectTo(serve.url);
  const session = client.newSession();
  const turn = await sendAndSettle(client, session, "hello");
  const message = turn.error ?? "";
  expect(message).toContain("status 401");
  expect(message).not.toContain("sk-abcdefghijklmnopqrstuvwxyz012345");
  expect(message).not.toContain("\n");
});

// (b) A second send while a turn is genuinely in flight must not ORPHAN that
// turn: it is refused with the daemon's own `TurnInProgress`, and the first
// turn still ends when the model answers. Mutation: drop the guards in
// `remote-session.ts` `runTurn` → the second send clobbers `this.active`, the
// first turn's `turn_end` finds no owner and it never settles (the owner's
// "every later send fails until Ctrl+C").
test("(b) a second send while a turn runs is refused, and that turn still ends", async () => {
  const api = endpoint([
    // The model holds its answer: the turn is genuinely in flight.
    () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          await delay(1200);
          const chunk = {
            choices: [{ delta: { role: "assistant", content: "first" }, finish_reason: null }],
          };
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  ]);
  const serve = await serveAt(api.baseURL, "inflight");
  const client = await connectTo(serve.url);
  const session = client.newSession();
  const first = sendAndSettle(client, session, "one");
  // Wait until the daemon holds the turn, then send again on the same session.
  await delay(300);
  const refused = await Promise.race([
    sendAndSettle(client, session, "two"),
    delay(2000).then(() => ({ texts: [], error: "WAITED" })),
  ]);
  expect(String(refused.error)).toContain("a turn is already running");

  const done = await Promise.race([first, delay(5000).then(() => ({ texts: [], error: "HUNG" }))]);
  expect(done.error).toBeNull();
  expect(done.texts.join("")).toBe("first");
}, 30_000);

// --- round 2: the daemon's OWN model reaches the client ---------------------
// Item 1/3 (`fix/connect-ctx-window` + item D of `fix/connect-functest-batch`):
// a `serve` daemon runs ITS OWN model, so a client's ctx meter and input rule
// must use that model's name and window, not the laptop's. Mutation: drop
// `modelInfo` from `serve.ts` → the handshake carries neither field.
test("(1) the daemon reports its own model NAME and window at initialize", async () => {
  const config = {
    ...(await projectConfig("http://127.0.0.1:1/v1", "facts")),
    contextWindow: 200000,
  };
  const handle = await startDaemon(
    { ...config, model: "served-model" },
    { host: "127.0.0.1", port: 0 },
  );
  stops.push(() => handle.stop());
  const client = await connectTo(handle.url);
  // A fresh handshake: `connectTo` initialized with the same daemon already.
  const dial = webSocketChannelFactory(handle.url, {});
  const fresh = new RemoteClient(await dial(), new PermissionBroker(), undefined, {
    channelFactory: dial,
  });
  stops.push(() => fresh.close());
  const info = (await fresh.initialize()).agentInfo;
  expect(info?.model).toBe("served-model");
  expect(info?.contextWindow).toBe(200000);
  client.close();
});

// The window the daemon counts against is its OWN config's, whatever a client
// carries. This is the pod shape (a laptop that DOES send `settings`): a `serve`
// daemon never applies it, because it builds each agent from its own config
// (`serve.ts`'s createAgent) — so its context line, warns and `/compact` use its
// own window. Mutation: wire `applyCarried` into that factory → 71680 below.
test("(2) a carried contextWindow never moves a serve daemon's own window", async () => {
  // The model's own copy carries the context line, so the window is readable
  // from the request the daemon sends.
  const bodies: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.text());
      return say("ok");
    },
  });
  stops.push(() => server.stop(true));
  const serve = await serveAt(`http://127.0.0.1:${server.port}/v1`, "carried");
  // A client that CARRIES a laptop window of 71680 (the shape a pod session
  // sends). A `serve` daemon builds each agent from its OWN config, so it must
  // ignore it: its context line is its own window (128000, the default here).
  const dial = webSocketChannelFactory(serve.url, {});
  const client = new RemoteClient(await dial(), new PermissionBroker(), undefined, {
    channelFactory: dial,
    sessionSettings: { contextWindow: 71680 },
  });
  stops.push(() => client.close());
  await client.initialize();
  const session = client.newSession();
  const turn = await sendAndSettle(client, session, "hello");
  expect(turn.error).toBeNull();
  const sent = bodies.join("");
  expect(sent).toContain("128k tokens");
  expect(sent).not.toContain("71k tokens");
}, 30_000);
