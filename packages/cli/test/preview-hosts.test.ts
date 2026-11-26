/**
 * Which hosts offer `container_preview` (docs/feat/container-apps-devices.md
 * OD8): `serve` with `previews.enabled` ONLY — never the worker, never a pod
 * daemon — each driven through a real turn. And the ask goes to the session's
 * ONE broker.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PreviewsLink,
  type StreamEvent,
  type ToolContext,
} from "@tentacle/core";
import { Connection, type SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { podSessionHost, startDaemon, tunnelledAgent } from "../src/serve.ts";
import { buildAgent } from "../src/wiring.ts";
import { workerSessionHost } from "../src/worker.ts";

const ON = { previews: { enabled: true } };
const TOOL = "container_preview";

async function withConfig(
  file: Record<string, unknown>,
  run: (config: Awaited<ReturnType<typeof loadConfig>>, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "preview-hosts-"));
  try {
    const configDir = join(dir, "config");
    await Bun.write(join(configDir, "config.jsonc"), JSON.stringify(file));
    const config = await loadConfig({
      configDir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    await run(config, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done", stopReason: "stop" };
  }
}

const offeredIn = async (model: Recorder): Promise<string[]> => {
  const deadline = Date.now() + 5000;
  while (model.requests.length === 0) {
    if (Date.now() > deadline) throw new Error("the provider was never called");
    await new Promise((r) => setTimeout(r, 2));
  }
  return (model.requests[0]?.tools ?? []).map((tool) => tool.name);
};

async function offeredBy(host: SessionHost, model: Recorder): Promise<string[]> {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const client = new RpcPeer(c, { onRequest: async () => ({ trusted: false }) });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  await client.request("session/open", { sessionId: "S", create: true });
  await client.request("session/prompt", {
    sessionId: "S",
    turnId: "t1",
    content: [{ type: "text", text: "hi" }],
  });
  return offeredIn(model);
}

describe("never the worker, never a pod daemon", () => {
  test("the worker, even with previews.enabled", async () => {
    await withConfig(ON, async (config) => {
      const model = new Recorder();
      const host = workerSessionHost(config, { version: "t", createProvider: () => model });
      const offered = await offeredBy(host, model);
      expect(offered).not.toContain(TOOL);
      expect(offered).toContain("shell");
      expect(host.get("S")?.previewsLink()).toBeNull();
    });
  });

  test("a pod daemon, even with previews.enabled in its own config", async () => {
    await withConfig(ON, async (config) => {
      const model = new Recorder();
      const host = podSessionHost(config, undefined, { createProvider: () => model });
      const offered = await offeredBy(host, model);
      expect(offered).not.toContain(TOOL);
      expect(host.get("S")?.previewsLink()).toBeNull();
      expect(tunnelledAgent(config, () => null, {}).tools.get(TOOL)).toBeUndefined();
    });
  });
});

describe("`serve`", () => {
  for (const [name, file, offers] of [
    ["offers it with previews.enabled", ON, true],
    ["does not offer it by default", {}, false],
  ] as const) {
    test(name, async () => {
      await withConfig(file, async (config, dir) => {
        const model = new Recorder();
        const server = await startDaemon(config, {
          host: "127.0.0.1",
          port: 0,
          createProvider: () => model,
        });
        const channel = await connectWebSocket(`ws://127.0.0.1:${server.port}`);
        const laptop = new RemoteClient(channel, new PermissionBroker());
        try {
          await laptop.initialize();
          const sessionId = await laptop.openSession(dir, undefined, "S");
          await laptop.prompt(sessionId, "t1", "hi");
          const offered = await offeredIn(model);
          expect(offered.includes(TOOL)).toBe(offers);
        } finally {
          laptop.close();
          await server.stop();
        }
      });
    });
  }
});

/**
 * `container_share` (docs/feat/session-apps-container-ports.md OD11): a `serve`
 * with `previews.enabled` AND `previews.links` only.
 */
describe("who offers container_share", () => {
  const SHARE = "container_share";
  const LINKS = { previews: { enabled: true, links: true } };

  for (const [name, file, offers] of [
    ["serve with both flags", LINKS, true],
    ["not serve with previews.enabled alone", ON, false],
    ["not serve with links alone", { previews: { links: true } }, false],
  ] as const) {
    test(name, async () => {
      await withConfig(file, async (config, dir) => {
        const model = new Recorder();
        const server = await startDaemon(config, {
          host: "127.0.0.1",
          port: 0,
          createProvider: () => model,
        });
        const channel = await connectWebSocket(`ws://127.0.0.1:${server.port}`);
        const laptop = new RemoteClient(channel, new PermissionBroker());
        try {
          await laptop.initialize();
          const sessionId = await laptop.openSession(dir, undefined, "S");
          await laptop.prompt(sessionId, "t1", "hi");
          const offered = await offeredIn(model);
          expect(offered.includes(SHARE)).toBe(offers);
        } finally {
          laptop.close();
          await server.stop();
        }
      });
    });
  }

  test("never the worker or a pod daemon, even with both flags", async () => {
    await withConfig(LINKS, async (config) => {
      const worker = new Recorder();
      const local = workerSessionHost(config, { version: "t", createProvider: () => worker });
      expect(await offeredBy(local, worker)).not.toContain(SHARE);
      const pod = new Recorder();
      const host = podSessionHost(config, undefined, { createProvider: () => pod });
      expect(await offeredBy(host, pod)).not.toContain(SHARE);
      expect(buildAgent(config, {}).tools.get(SHARE)).toBeUndefined();
    });
  });
});

describe("the ask goes to the session's ONE broker (AGENTS §7)", () => {
  test("it reaches that broker, and a no records nothing", async () => {
    await withConfig(ON, async (config) => {
      const asked: PermissionRequest[] = [];
      const broker = new PermissionBroker(async (req) => {
        asked.push(req);
        return { allowed: false };
      });
      let added = 0;
      const link: PreviewsLink = {
        prepare: async () => ({
          ok: true,
          facts: {
            engine: "docker",
            endpointLabel: "unix:///x.sock",
            id: "a".repeat(64),
            name: "web",
            image: "nginx",
            imageId: "sha256:1",
            containerPort: 80,
            hostPort: 8080,
            hostIp: "127.0.0.1",
          },
        }),
        add: () => {
          added += 1;
          return { ok: false, reason: "unexpected" };
        },
      };
      const wired = buildAgent(config, { permissions: broker, previews: () => link });
      const tool = wired.tools.get(TOOL);
      if (!tool) throw new Error("container_preview is not registered");
      const result = await tool.execute({ container: "web", port: 80 }, {
        signal: new AbortController().signal,
      } as unknown as ToolContext);
      expect(asked.map((a) => a.kind)).toEqual(["container_preview"]);
      expect(added).toBe(0);
      expect(result.content).toContain("the user declined");
      expect(buildAgent(config, {}).tools.get(TOOL)).toBeUndefined();
    });
  });
});
