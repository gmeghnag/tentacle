/**
 * Which hosts offer `app_publish` (docs/feat/session-apps-publish.md D1/D11):
 * `serve` and the local worker, only with `apps.enabled`, NEVER a pod daemon
 * (AGENTS §7: a pod publishes nothing) — each driven through a real turn, the
 * assertion what the model is offered. And the publish asks the session's ONE
 * broker.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import {
  type AppsLink,
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type PreparedPublish,
  type StreamEvent,
  type ToolContext,
} from "@tentacle/core";
import { Connection, type SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { podSessionHost, startDaemon, tunnelledAgent } from "../src/serve.ts";
import { appsServiceOf, buildAgent } from "../src/wiring.ts";
import { workerSessionHost } from "../src/worker.ts";

const ON = { apps: { enabled: true, domain: "apps.example.so" } };

async function withConfig(
  file: Record<string, unknown>,
  run: (config: Awaited<ReturnType<typeof loadConfig>>, dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "apps-hosts-"));
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

describe("appsServiceOf", () => {
  test("a publisher only with apps.enabled, at the configured domain", async () => {
    await withConfig({}, async (config) => {
      expect(appsServiceOf(config, () => {})).toBeUndefined();
    });
    await withConfig(ON, async (config) => {
      expect(appsServiceOf(config, () => {})?.domain).toBe("apps.example.so");
    });
  });
});

describe("the worker", () => {
  for (const [name, file, offers] of [
    ["offers both with apps.enabled", ON, true],
    ["offers neither by default", {}, false],
  ] as const) {
    test(name, async () => {
      await withConfig(file, async (config) => {
        const model = new Recorder();
        const host = workerSessionHost(config, { version: "t", createProvider: () => model });
        const offered = await offeredBy(host, model);
        expect(offered.includes("app_publish")).toBe(offers);
        expect(offered.includes("app_unpublish")).toBe(offers);
        expect(offered).toContain("shell");
        expect(host.get("S")?.appsLink() != null).toBe(offers);
      });
    });
  }
});

describe("a pod daemon NEVER offers them", () => {
  test("not even with apps.enabled in the pod's own config", async () => {
    await withConfig(ON, async (config) => {
      const model = new Recorder();
      const host = podSessionHost(config, undefined, { createProvider: () => model });
      const offered = await offeredBy(host, model);
      expect(offered).not.toContain("app_publish");
      expect(offered).not.toContain("app_unpublish");
      expect(offered).toContain("shell");
      expect(host.get("S")?.appsLink()).toBeNull();
    });
  });

  test("`tunnelledAgent` (the `--model-proxy` pod) builds neither", async () => {
    await withConfig(ON, async (config) => {
      const wired = tunnelledAgent(config, () => null, {});
      expect(wired.tools.get("app_publish")).toBeUndefined();
      expect(wired.tools.get("app_unpublish")).toBeUndefined();
      expect(wired.tools.get("shell")).toBeDefined();
    });
  });
});

describe("`serve`", () => {
  for (const [name, file, offers] of [
    ["offers both with apps.enabled", ON, true],
    ["offers neither by default", {}, false],
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
          expect(offered.includes("app_publish")).toBe(offers);
          expect(offered.includes("app_unpublish")).toBe(offers);
        } finally {
          laptop.close();
          await server.stop();
        }
      });
    });
  }
});

describe("the publish asks the session's ONE broker (AGENTS §7)", () => {
  test("the ask reaches the broker the host was built with, and a no publishes nothing", async () => {
    await withConfig(ON, async (config) => {
      const asked: PermissionRequest[] = [];
      const broker = new PermissionBroker(async (req) => {
        asked.push(req);
        return { allowed: false };
      });
      const prepared: PreparedPublish = {
        ok: true,
        kind: "create",
        domain: "apps.example.so",
        meta: {
          artifactId: "demo",
          version: 1,
          sha256: "ab".repeat(32),
          size: 1,
          mimeType: "text/html",
          kind: "html",
          title: "Demo",
          callId: "c",
          createdAt: 0,
        },
        bytes: new Uint8Array([1]),
        findings: [],
      };
      let published = 0;
      const link: AppsLink = {
        prepare: async () => prepared,
        publish: async () => {
          published += 1;
          return { ok: false, reason: "unexpected" };
        },
        unpublish: async () => ({ ok: false }),
        list: () => [],
      };
      const wired = buildAgent(config, { permissions: broker, apps: () => link });
      expect(wired.permissions).toBe(broker);
      const tool = wired.tools.get("app_publish");
      if (!tool) throw new Error("app_publish is not registered");
      const result = await tool.execute({ artifact: "demo" }, {
        signal: new AbortController().signal,
      } as unknown as ToolContext);
      expect(asked.map((a) => a.kind)).toEqual(["app_publish"]);
      expect(published).toBe(0);
      expect(result.content).toContain("the user declined");
    });
  });

  test("without a link neither tool is registered", async () => {
    await withConfig(ON, async (config) => {
      const wired = buildAgent(config, {});
      expect(wired.tools.get("app_publish")).toBeUndefined();
      expect(wired.tools.get("app_unpublish")).toBeUndefined();
    });
  });
});
