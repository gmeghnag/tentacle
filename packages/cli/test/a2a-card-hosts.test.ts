/**
 * docs/feat/a2a-client.md, Review round 2 finding 2 — owner decision (c): the
 * worker and `serve` read the `a2a` cards ONCE before their `SessionHost`
 * (`startA2ACards`, ≤ the budget, only when an `a2a` instance is configured),
 * freeze that snapshot into every build's `agent_task` text and refresh it in
 * the background after each build (the NEXT build sees the new text).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, type SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { fakeCard } from "../../agent/test/support/fake-a2a.ts";
import { until } from "../../client/test/support/fakes.ts";
import { loadConfig } from "../src/config.ts";
import { startDaemon } from "../src/serve.ts";
import { type A2ACardCache, type WiredAgent, startA2ACards } from "../src/wiring.ts";
import { heldChannel, workerSessionHost } from "../src/worker.ts";

const NOT_LOADED = "Remote card: (remote card not loaded)";
const dirs: string[] = [];
const stops: { stop(): unknown }[] = [];

afterEach(async () => {
  for (const s of stops.splice(0)) await s.stop();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done", stopReason: "stop" };
  }
}

async function configWith(cardUrl: string | undefined) {
  const dir = await mkdtemp(join(tmpdir(), "a2a-card-hosts-"));
  dirs.push(dir);
  const config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
  const harnesses =
    cardUrl === undefined
      ? config.harnesses
      : {
          ...config.harnesses,
          acme: {
            adapter: "a2a",
            enabled: true,
            card: cardUrl,
            description: "Reviews Go PRs",
            inputFrom: "user",
            idleMinutes: 30,
            configured: true,
          },
        };
  return { ...config, subagentsEnabled: true, harnesses } as typeof config;
}

const ORIGIN = "https://agents.acme.dev";
const CARD_URL = `${ORIGIN}/.well-known/agent-card.json`;

/** A card endpoint whose text the test can change; counts its reads. */
function cardServer(description: string) {
  const card = { current: description, reads: 0 };
  const fetchImpl = (async () => {
    card.reads++;
    return Response.json(fakeCard(`${ORIGIN}/a2a`, { description: card.current }));
  }) as unknown as typeof fetch;
  return { card, fetch: fetchImpl };
}

const acmeLine = (wired: WiredAgent | undefined): string =>
  (wired?.tools.definitions().find((d) => d.name === "agent_task")?.description ?? "")
    .split("\n")
    .find((l) => l.startsWith("- a2a:acme:")) ?? "";

/** Open one session on a worker host; return the agent that build produced. */
async function openOn(host: SessionHost, built: WiredAgent[], id: string): Promise<WiredAgent> {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const client = new RpcPeer(c, { onRequest: async () => ({ trusted: false }) });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  const before = built.length;
  await client.request("session/open", { sessionId: id, create: true });
  const wired = built[before];
  if (wired === undefined) throw new Error("session/open built no agent");
  return wired;
}

function workerHost(config: Awaited<ReturnType<typeof configWith>>, cache: A2ACardCache) {
  const built: WiredAgent[] = [];
  const host = workerSessionHost(config, {
    version: "test",
    createProvider: () => new Recorder(),
    onBuilt: (w) => built.push(w),
    a2aCards: cache,
  });
  return { host, built };
}

describe("worker: the start-up snapshot reaches every build", () => {
  test("a configured `a2a:` type built by the worker reads the card text, not «not loaded»", async () => {
    const r = cardServer("Card text v1");
    const config = await configWith(CARD_URL);
    const cache = await startA2ACards(config, { fetch: r.fetch });
    const { host, built } = workerHost(config, cache);
    const line = acmeLine(await openOn(host, built, "S1"));
    expect(line).toContain("Card text v1");
    expect(line).not.toContain(NOT_LOADED);
  });

  test("refreshed after each build: the NEXT build sees the card's new text", async () => {
    const r = cardServer("Card text v1");
    const config = await configWith(CARD_URL);
    const cache = await startA2ACards(config, { fetch: r.fetch });
    const { host, built } = workerHost(config, cache);
    expect(acmeLine(await openOn(host, built, "S1"))).toContain("Card text v1");
    // The start-up read + the refresh the build started.
    expect(r.card.reads).toBe(2);
    r.card.current = "Card text v2";
    // That refresh may have read v1 already: the property is that after one
    // more build and ITS refresh, the next build reads v2.
    await openOn(host, built, "S2");
    await cache.refresh();
    expect(acmeLine(await openOn(host, built, "S3"))).toContain("Card text v2");
  });
});

describe("startA2ACards", () => {
  test("no `a2a` instance configured ⇒ no read and no wait", async () => {
    let reads = 0;
    const never = (() => {
      reads++;
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;
    const config = await configWith(undefined);
    const started = Date.now();
    const cache = await startA2ACards(config, { fetch: never, budgetMs: 5_000 });
    await cache.refresh();
    expect(Date.now() - started).toBeLessThan(500);
    expect(reads).toBe(0);
    expect(cache.cards().size).toBe(0);
  });

  test("a card that never answers: start-up ends within the budget, the type reads «not loaded»", async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const config = await configWith(CARD_URL);
    const started = Date.now();
    const cache = await startA2ACards(config, { fetch: hang, budgetMs: 50 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(cache.cards().get("acme")).toBeUndefined();
    const { host, built } = workerHost(config, cache);
    expect(acmeLine(await openOn(host, built, "S1"))).toContain(NOT_LOADED);
  });

  test("a refresh that cannot read the card keeps its last text", async () => {
    const r = cardServer("Card text v1");
    let fail = false;
    const flaky = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (fail) throw new Error("down");
      return r.fetch(input, init);
    }) as typeof fetch;
    const config = await configWith(CARD_URL);
    const cache = await startA2ACards(config, { fetch: flaky });
    fail = true;
    await cache.refresh();
    expect(cache.cards().get("acme")?.description).toBe("Card text v1");
  });
});

describe("serve: the daemon reads the cards before its SessionHost", () => {
  test("a configured `a2a:` type in a `serve` session's tools reads the card text", async () => {
    const cards = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        Response.json(
          fakeCard(`${new URL(req.url).origin}/a2a`, { description: "Serve card text" }),
        ),
    });
    stops.push({ stop: () => cards.stop(true) });
    const config = await configWith(`http://127.0.0.1:${cards.port}/.well-known/agent-card.json`);
    const model = new Recorder();
    const server = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      createProvider: () => model,
    });
    stops.push(server);
    const channel = await connectWebSocket(`ws://127.0.0.1:${server.port}`);
    const laptop = new RemoteClient(channel, new PermissionBroker());
    stops.push({ stop: () => laptop.close() });
    await laptop.initialize();
    const sessionId = await laptop.openSession(config.cwd, undefined, "S");
    await laptop.prompt(sessionId, "t1", "hi");
    await until(() => model.requests.length > 0, 5_000);
    const tools = model.requests[0]?.tools ?? [];
    const task = tools.find((t) => t.name === "agent_task")?.description ?? "";
    const line = task.split("\n").find((l) => l.startsWith("- a2a:acme:")) ?? "";
    expect(line).toContain("Serve card text");
    expect(line).not.toContain(NOT_LOADED);
  });
});

describe("heldChannel: the worker awaits the cards before its Connection", () => {
  test("frames sent before the handler are handed over, in order, then live ones", async () => {
    const [d, c] = createChannelPair();
    const held = heldChannel(d);
    const got: string[] = [];
    c.send("a");
    c.send("b");
    await new Promise((r) => setTimeout(r, 10));
    held.setOnMessage((data) => got.push(data));
    c.send("c");
    await until(() => got.length === 3, 1_000);
    expect(got).toEqual(["a", "b", "c"]);
  });

  test("an `initialize` sent while the worker is still starting is answered", async () => {
    const config = await configWith(undefined);
    const [d, c] = createChannelPair();
    const held = heldChannel(d);
    const client = new RpcPeer(c, { onRequest: async () => ({ trusted: false }) });
    const init = client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await new Promise((r) => setTimeout(r, 20)); // the start-up await
    new Connection(held, workerSessionHost(config, { version: "test" }));
    const answered = await Promise.race([
      init.then(() => "answered"),
      new Promise((r) => setTimeout(() => r("lost"), 2_000)),
    ]);
    expect(answered).toBe("answered");
  });
});
