/**
 * Which hosts offer the schedule tools (docs/feat/cron-tool.md D1, slice S4):
 * `serve` and the local worker, NEVER a pod daemon (owner Q4; a pod must not
 * decide when turns start on the laptop's model key, AGENTS §7). The omission
 * and the leak are both silent, so each host is driven through a real turn and
 * the assertion is what the model is OFFERED (`ChatRequest.tools`), plus the
 * host's own `schedules.*` limits reaching the session's link.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import {
  type ChatRequest,
  DEFAULT_SCHEDULE_LIMITS,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, type SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { podSessionHost, startDaemon } from "../src/serve.ts";
import { scheduleLimitsOf } from "../src/wiring.ts";
import { workerSessionHost } from "../src/worker.ts";

async function configIn(dir: string, file: Record<string, unknown> = {}) {
  const configDir = join(dir, "config");
  if (Object.keys(file).length > 0) {
    await Bun.write(join(configDir, "config.jsonc"), JSON.stringify(file));
  }
  return loadConfig({
    configDir,
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
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

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  const deadline = Date.now() + 3000;
  while (model.requests.length === 0 && Date.now() < deadline) await tick();
  const seen = model.requests[0];
  if (!seen) throw new Error("the provider was never called");
  return (seen.tools ?? []).map((tool) => tool.name);
}

describe("scheduleLimitsOf: the host's `schedules.*` → the core's limits", () => {
  test("the config defaults ARE the core defaults (the two packages cannot drift)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-limits-"));
    try {
      expect(scheduleLimitsOf(await configIn(dir))).toEqual(DEFAULT_SCHEDULE_LIMITS);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the worker offers the schedule tools, with its own limits", () => {
  test("a turn through `workerSessionHost` is offered both; its link applies `schedules.*`", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-worker-"));
    try {
      const config = await configIn(dir, { schedules: { minIntervalMinutes: 5 } });
      const model = new Recorder();
      const host = workerSessionHost(config, { version: "test", createProvider: () => model });
      const offered = await offeredBy(host, model);
      expect(offered).toContain("schedule_create");
      expect(offered).toContain("schedule_control");
      const link = host.get("S")?.scheduleLink();
      if (!link) throw new Error("the worker session has no schedule link");
      const refused = link.create({ prompt: "p", every: "4m" });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.reason).toContain("at least 5m");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("a pod daemon NEVER offers them (D1, owner Q4)", () => {
  test("a turn through `podSessionHost` is offered neither, and the session has no link", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-pod-"));
    try {
      const config = await configIn(dir);
      const model = new Recorder();
      const host = podSessionHost(config, undefined, { createProvider: () => model });
      const offered = await offeredBy(host, model);
      expect(offered).not.toContain("schedule_create");
      expect(offered).not.toContain("schedule_control");
      // Non-vacuity: the pod's agent IS offered tools.
      expect(offered).toContain("shell");
      expect(host.get("S")?.scheduleLink()).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("`serve` offers them", () => {
  test("a turn through the serve daemon is offered both", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schedule-serve-"));
    const config = await configIn(dir);
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
      const deadline = Date.now() + 5000;
      while (model.requests.length === 0 && Date.now() < deadline) await tick();
      const offered = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
      expect(offered).toContain("schedule_create");
      expect(offered).toContain("schedule_control");
    } finally {
      laptop.close();
      await server.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
