/**
 * What a `connect` user SEES when the daemon's model fails (docs/fix/
 * connect-model-error-drops-connection.md): the provider's message with the
 * hint that it is the DAEMON's model — never a bare "internal error", and never
 * a TUI that can no longer send.
 *
 * The stack is the real one: the real `App` over a real `RemoteClient` against a
 * real `startDaemon`, whose model is a real OpenAI-compatible endpoint.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { loadConfig } from "../../cli/src/config.ts";
import { startDaemon } from "../../cli/src/serve.ts";
import { RemoteClient, webSocketChannelFactory } from "../../client/src/index.ts";
import { App } from "../src/App.tsx";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

function say(text: string): Response {
  const events = [
    { choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

let dir = "";
const stops: (() => Promise<void> | void)[] = [];
const saved = process.env.TENTACLE_CONFIG_DIR;

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  const key = "TENTACLE_CONFIG_DIR";
  if (saved === undefined) delete process.env[key];
  else process.env.TENTACLE_CONFIG_DIR = saved;
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Type `text` and press Enter, with a tick between (Ink reads them in order). */
async function type(app: { stdin: { write(s: string): void } }, text: string): Promise<void> {
  app.stdin.write(text);
  await delay(60);
  app.stdin.write("\r");
}

test("the transcript shows the provider's message + the daemon's own-model hint", async () => {
  dir = await mkdtemp(join(tmpdir(), "connect-model-error-tui-"));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  let mode: "401" | "ok" = "401";
  const api = Bun.serve({
    port: 0,
    fetch: () =>
      mode === "401" ? new Response("Invalid API Key", { status: 401 }) : say("recovered"),
  });
  stops.push(() => api.stop(true));
  const config = {
    ...(await loadConfig({ cwd: dir })),
    provider: "openai" as const,
    baseURL: `http://127.0.0.1:${api.port}/v1`,
    model: "fake",
    apiKey: "k",
  };
  const handle = await startDaemon(config, { host: "127.0.0.1", port: 0 });
  stops.push(() => handle.stop());
  const dial = webSocketChannelFactory(handle.url, {});
  const client = new RemoteClient(await dial(), new PermissionBroker(), undefined, {
    channelFactory: dial,
  });
  stops.push(() => client.close());
  await client.initialize();
  const session = client.newSession();
  const app = render(
    <App model="remote" cwd={handle.url} createSession={() => session} link={client} />,
  );
  await delay(400);
  await type(app, "hello");
  await delay(1500);
  const failed = strip(app.lastFrame() ?? "");
  expect(failed).toContain("status 401");
  expect(failed).toContain("Invalid API Key");
  expect(failed).not.toContain("internal error");
  expect(failed).toContain("tentacle config");

  // The model recovers: the SAME TUI sends again and the turn runs.
  mode = "ok";
  await type(app, "again");
  await delay(2000);
  const recovered = strip(app.lastFrame() ?? "");
  expect(recovered).toContain("recovered");
  app.unmount();
}, 30_000);

// The owner's second repro: the engine is restarting, so the model call HANGS
// (connected, no byte). Esc cancels that turn, and the next message runs once
// the engine is back — the TUI is never left in a state where every send only
// queues. Mutation: make Esc not cancel the stream → the "again" turn queues.
test("Esc escapes a hung model call; the next message runs once the model is back", async () => {
  dir = await mkdtemp(join(tmpdir(), "connect-model-hang-"));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
  let mode: "hang" | "ok" = "hang";
  const api = Bun.serve({
    port: 0,
    fetch(req) {
      if (mode === "ok") return say("recovered");
      // Accept and say nothing: the engine is loading.
      return new Promise<Response>((resolve) => {
        req.signal.addEventListener("abort", () => resolve(new Response("", { status: 499 })));
      });
    },
  });
  stops.push(() => api.stop(true));
  const config = {
    ...(await loadConfig({ cwd: dir })),
    provider: "openai" as const,
    baseURL: `http://127.0.0.1:${api.port}/v1`,
    model: "fake",
    apiKey: "k",
  };
  const handle = await startDaemon(config, { host: "127.0.0.1", port: 0 });
  stops.push(() => handle.stop());
  const dial = webSocketChannelFactory(handle.url, {});
  const client = new RemoteClient(await dial(), new PermissionBroker(), undefined, {
    channelFactory: dial,
  });
  stops.push(() => client.close());
  await client.initialize();
  const session = client.newSession();
  const app = render(
    <App model="remote" cwd={handle.url} createSession={() => session} link={client} />,
  );
  await delay(400);
  await type(app, "first");
  await delay(1200);
  expect(strip(app.lastFrame() ?? "")).toContain("Working…");
  // Esc: the turn the model never answered is cancelled.
  app.stdin.write("\u001b");
  await delay(1200);
  mode = "ok";
  await type(app, "again");
  await delay(2000);
  const recovered = strip(app.lastFrame() ?? "");
  expect(recovered).toContain("recovered");
  expect(recovered).not.toContain("Working…");
  app.unmount();
}, 30_000);
