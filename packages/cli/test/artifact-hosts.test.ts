/**
 * Every session-hosting cli build offers `present` on the session's artifact
 * store (docs/feat/model-artifacts.md D2/D4): the worker, `serve`, and both
 * pod daemon branches (own model / `--model-proxy`).
 *
 * The failure this pins is SILENT, like attachments' (image-hosts.test.ts): a
 * factory that drops `ctx.artifacts` just never offers the tool, with no error
 * anywhere. So each host's factory is called the way `SessionHost.build` calls
 * it, and one TURN through the worker's host shows the model is offered it.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import type { ArtifactSink, ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { type AgentFactory, Connection, type SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { PRESENT_TOOL_NAME } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { createServeAgent, podSessionHost, tunnelledAgent } from "../src/serve.ts";
import { createSkillScan } from "../src/wiring.ts";
import { buildAgent } from "../src/wiring.ts";
import { workerAgentFactory, workerSessionHost } from "../src/worker.ts";

async function configIn(dir: string, over: Record<string, unknown> = {}) {
  const config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
  return { ...config, ...over };
}

const sink: ArtifactSink = { present: () => Promise.reject(new Error("unused")) };

/** What an agent was built with: its config's sink and its registry. */
function offered(agent: unknown): { artifacts: unknown; present: boolean } {
  const config = (agent as { config: { artifacts?: unknown; tools: { get(n: string): unknown } } })
    .config;
  return {
    artifacts: config.artifacts,
    present: config.tools.get(PRESENT_TOOL_NAME) !== undefined,
  };
}

/** The host's own factory, as `SessionHost.build` calls it. */
const factoryOf = (host: SessionHost): AgentFactory =>
  (host as unknown as { opts: { createAgent: AgentFactory } }).opts.createAgent;

async function withConfig(
  over: Record<string, unknown>,
  body: (config: Awaited<ReturnType<typeof configIn>>, dir: string) => Promise<void> | void,
) {
  const dir = await mkdtemp(join(tmpdir(), "artifact-hosts-"));
  try {
    await body(await configIn(dir, over), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildAgent", () => {
  test("offers present exactly when given the session's store, and hands it to the agent", () =>
    withConfig({}, (config) => {
      expect(offered(buildAgent(config).agent)).toEqual({ artifacts: undefined, present: false });
      expect(offered(buildAgent(config, { artifacts: sink }).agent)).toEqual({
        artifacts: sink,
        present: true,
      });
    }));
});

describe("every session-hosting factory forwards ctx.artifacts", () => {
  test("the worker", () =>
    withConfig({}, (config) => {
      expect(offered(workerAgentFactory(config, { artifacts: sink }).agent)).toEqual({
        artifacts: sink,
        present: true,
      });
    }));

  test("serve", () =>
    withConfig({}, (config, dir) => {
      const wired = createServeAgent(config, {}, createSkillScan(config), {
        cwd: dir,
        artifacts: sink,
      });
      expect(offered(wired.agent)).toEqual({ artifacts: sink, present: true });
    }));

  test("a pod daemon running its own model", () =>
    withConfig({ provider: "anthropic" }, (config, dir) => {
      const wired = factoryOf(podSessionHost(config, undefined, {}))(dir, {
        modelLink: () => null,
        artifacts: sink,
      });
      expect(offered(wired.agent)).toEqual({ artifacts: sink, present: true });
    }));

  test("a pod daemon with --model-proxy (tunnelledAgent)", () =>
    withConfig({}, (config, dir) => {
      const wired = factoryOf(podSessionHost(config, undefined, { modelProxy: true }))(dir, {
        modelLink: () => null,
        artifacts: sink,
      });
      expect(offered(wired.agent)).toEqual({ artifacts: sink, present: true });
      expect(offered(tunnelledAgent(config, () => null, { artifacts: sink }).agent).present).toBe(
        true,
      );
    }));
});

/** A provider that records every request it is handed. */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done", stopReason: "stop" };
  }
}

describe("a TURN through the worker's host", () => {
  test("the model is offered present", () =>
    withConfig({ provider: "anthropic" }, async (config) => {
      const model = new Recorder();
      const host = workerSessionHost(config, { version: "test", createProvider: () => model });
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
      const deadline = Date.now() + 3000;
      while (model.requests.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect((model.requests[0]?.tools ?? []).map((t) => t.name)).toContain(PRESENT_TOOL_NAME);
    }));
});
