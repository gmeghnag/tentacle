/**
 * The live model switch (docs/feat/model-switch.md T2): after a select, the
 * agent loop, the default sub-agents, the title model and the context windows
 * follow the entry; each entry keeps its own endpoint and key. Scratch config
 * dir and a spy provider factory only: no network, never the user's config.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, LogSessionStore } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import type { CreateModelProviderOptions } from "@tentacle/providers";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { type TentacleConfig, loadConfig, resolveModelEntry } from "../src/config.ts";
import { WORKER_TRUST, createLocalRuntime } from "../src/local-runtime.ts";
import { createServeAgent } from "../src/serve.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { buildAgent, createSkillScan } from "../src/wiring.ts";
import { workerSessionHost } from "../src/worker.ts";

let dir: string;
let base: TentacleConfig;
const saved = process.env.TENTACLE_CONFIG_DIR;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "model-switch-"));
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  base = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  if (saved === undefined) {
    Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
  } else {
    process.env.TENTACLE_CONFIG_DIR = saved;
  }
  await rm(dir, { recursive: true, force: true });
});

function config(over: Partial<TentacleConfig> = {}): TentacleConfig {
  const main = {
    provider: "openai" as const,
    baseURL: "http://main/v1",
    model: "main-id",
    contextWindow: 111_000,
    apiKey: "s3cret-main",
  };
  return {
    ...base,
    ...main,
    autoTitle: true,
    subagentExecution: "sequential",
    contextAwareness: { ...base.contextAwareness, enabled: true },
    contextPrune: { ...base.contextPrune, enabled: true },
    models: {
      haiku: resolveModelEntry(main, {
        provider: "anthropic",
        baseURL: "http://haiku",
        model: "haiku-id",
        contextWindow: 22_000,
      }),
    },
    subagentModels: {},
    selectableModels: [],
    ...over,
  };
}

/** Answers `ok`; a first parent request containing `SPAWN` spawns one `general` child. */
class Fake implements ModelProvider {
  readonly requests: ChatRequest[] = [];
  constructor(readonly id: string) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const asks = request.messages.some((m) => m.role === "user" && m.content.includes("SPAWN"));
    if (asks && !request.messages.some((m) => m.role === "tool")) {
      yield {
        type: "tool_call",
        toolCall: {
          id: "c1",
          name: "agent_task",
          arguments: JSON.stringify({
            description: "d",
            prompt: "CHILD",
            subagent_type: "general",
          }),
        },
      };
    } else {
      yield { type: "text", delta: `from ${this.id}` };
    }
    yield { type: "done" };
  }
}

function factory() {
  const made: CreateModelProviderOptions[] = [];
  const fakes = new Map<string, Fake>();
  const of = (model: string): Fake => {
    const found = fakes.get(model);
    if (found) {
      return found;
    }
    const fake = new Fake(`fake:${model}`);
    fakes.set(model, fake);
    return fake;
  };
  const create = (options: CreateModelProviderOptions): ModelProvider => {
    made.push(options);
    return of(options.model);
  };
  return { made, of, create };
}

async function run(wired: ReturnType<typeof buildAgent>, text: string): Promise<void> {
  for await (const _event of wired.agent.run("s", [{ role: "user", content: text }])) {
    // drained
  }
}

const switchOf = (wired: ReturnType<typeof buildAgent>) => {
  if (wired.modelSwitch === undefined) {
    throw new Error("no model switch");
  }
  return wired.modelSwitch;
};

/** The windows the agent was built with, read as the loop reads them (at use). */
const windows = (wired: ReturnType<typeof buildAgent>) => {
  const agent = wired.agent as unknown as {
    config: { contextPrune?: { window: number }; contextAwareness?: { window: number } };
  };
  return [agent.config.contextPrune?.window, agent.config.contextAwareness?.window];
};

/** The window of the context line the model was sent (`[context: … / 111k tokens (…)]`). */
const awarenessWindow = (request: ChatRequest | undefined): string | undefined =>
  /\[context: [^/\]]+\/ (\S+) tokens/.exec(JSON.stringify(request?.messages ?? []))?.[1];

describe("buildAgent's model switch", () => {
  test("the NEXT request reaches the entry's provider, with its id and window", async () => {
    const f = factory();
    const wired = buildAgent(config(), { createProvider: f.create });
    const modelSwitch = switchOf(wired);
    await run(wired, "one");
    expect(f.of("main-id").requests).toHaveLength(1);
    expect(awarenessWindow(f.of("main-id").requests[0])).toBe("111k");

    expect(modelSwitch.select("haiku")).toEqual({ model: "haiku-id", contextWindow: 22_000 });
    await run(wired, "two");
    expect(f.of("main-id").requests).toHaveLength(1);
    expect(f.of("haiku-id").requests).toHaveLength(1);
    expect(awarenessWindow(f.of("haiku-id").requests[0])).toBe("22k");
    expect(modelSwitch.current()).toBe("haiku");
    expect(modelSwitch.provider.id).toBe("fake:haiku-id");
    expect(windows(wired)).toEqual([22_000, 22_000]);
    expect(wired.agent.mainModelId).toBe("haiku-id");
    // The title model is the main one unless `titleModel` is set: it follows.
    expect(wired.titleModel?.id).toBe("fake:haiku-id");

    expect(modelSwitch.select(null)).toEqual({ model: "main-id", contextWindow: 111_000 });
    await run(wired, "three");
    expect(f.of("main-id").requests).toHaveLength(2);
    expect(modelSwitch.current()).toBeNull();
    expect(modelSwitch.provider.id).toBe("fake:main-id");
    expect(windows(wired)).toEqual([111_000, 111_000]);
    expect(wired.agent.mainModelId).toBe("main-id");
  });

  test("the entry is dialled with its own connection, never the main key", async () => {
    const f = factory();
    const wired = buildAgent(config(), { createProvider: f.create });
    switchOf(wired).select("haiku");
    const made = f.made.find((m) => m.model === "haiku-id");
    expect([made?.provider, made?.baseURL, made?.apiKey]).toEqual([
      "anthropic",
      "http://haiku",
      undefined,
    ]);
  });

  test("a default sub-agent follows the switch, window included", async () => {
    const f = factory();
    const wired = buildAgent(config(), { createProvider: f.create });
    switchOf(wired).select("haiku");
    await run(wired, "SPAWN");
    const child = f
      .of("haiku-id")
      .requests.find((r) =>
        r.messages.some((m) => m.role === "user" && m.content.startsWith("CHILD")),
      );
    expect(child).toBeDefined();
    expect(awarenessWindow(child)).toBe("22k");
    expect(f.of("main-id").requests).toHaveLength(0);
  });

  test("an unknown name throws, with the selection unchanged", () => {
    const f = factory();
    const wired = buildAgent(config(), { createProvider: f.create });
    const modelSwitch = switchOf(wired);
    modelSwitch.select("haiku");
    expect(() => modelSwitch.select("nope")).toThrow(/nope/);
    expect(modelSwitch.current()).toBe("haiku");
    expect(modelSwitch.provider.id).toBe("fake:haiku-id");
    expect(windows(wired)).toEqual([22_000, 22_000]);
  });

  test("a run started on an entry: current() names it, null is that start model", () => {
    const f = factory();
    const started = config({ mainEntry: "haiku", model: "haiku-id", contextWindow: 22_000 });
    const modelSwitch = switchOf(buildAgent(started, { createProvider: f.create }));
    expect(modelSwitch.current()).toBe("haiku");
    expect(modelSwitch.select(null)).toEqual({ model: "haiku-id", contextWindow: 22_000 });
    expect(modelSwitch.current()).toBe("haiku");
  });

  test("a provider that cannot count says so (the caller estimates)", async () => {
    const f = factory();
    const modelSwitch = switchOf(buildAgent(config(), { createProvider: f.create }));
    expect(await modelSwitch.provider.countTokens?.({ messages: [] })).toBeUndefined();
  });

  test("a tunnelled build (a pod) has no switch", () => {
    const f = factory();
    const wired = buildAgent(config(), {
      modelOverride: new Fake("tunnel"),
      createProvider: f.create,
    });
    expect(wired.modelSwitch).toBeUndefined();
    expect(wired.agent.mainModelId).toBeUndefined();
  });
});

describe("the hosts offer the switch", () => {
  test("the worker's host: set_model moves the session's next turn", async () => {
    const f = factory();
    const host = workerSessionHost(config({ autoTitle: false }), {
      version: "test",
      createProvider: f.create,
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RpcPeer(c, { onRequest: async () => ({ trusted: false }) });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await client.request("session/open", { sessionId: "S", create: true });
    expect(await client.request("session/models", { sessionId: "S" })).toEqual({
      start: { model: "main-id", contextWindow: 111_000 },
      entries: [{ name: "haiku", model: "haiku-id", contextWindow: 22_000 }],
      active: null,
    });
    await client.request("session/set_model", { sessionId: "S", name: "haiku" });
    await client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    const deadline = Date.now() + 3000;
    while (f.of("haiku-id").requests.length === 0) {
      if (Date.now() > deadline) {
        throw new Error("the entry's provider was never called");
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(f.of("main-id").requests).toHaveLength(0);
  });

  test("the TUI's controller reaches it: list, switch before the first message, send", async () => {
    const f = factory();
    const host = workerSessionHost(config({ autoTitle: false }), {
      version: "test",
      createProvider: f.create,
    });
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new LogSessionStore(join(dir, "sessions")), () => {}),
      cwd: dir,
      model: "main-id",
      resume: null,
      ...WORKER_TRUST,
    });
    try {
      const controller = runtime.createSession();
      expect((await controller.models()).active).toBeNull();
      expect((await controller.setModel("haiku")).model).toBe("haiku-id");
      for await (const _ of controller.send("go")) {
        // drained
      }
      expect(f.of("haiku-id").requests).toHaveLength(1);
      expect(f.of("main-id").requests).toHaveLength(0);
      expect((await controller.models()).active).toBe("haiku");
    } finally {
      await runtime.dispose();
    }
  });

  test("a serve session's agent carries the switch", () => {
    const f = factory();
    const cfg = config();
    const wired = createServeAgent(cfg, { createProvider: f.create }, createSkillScan(cfg), {
      cwd: dir,
    });
    expect(wired.modelSwitch?.select("haiku").model).toBe("haiku-id");
  });
});
