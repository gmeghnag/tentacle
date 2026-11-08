/**
 * `models` in a pod, end to end (docs/feat/models-map-pod.md): the real pod
 * agent over a channel, the real `laptopModels`, and a HOSTILE pod speaking raw
 * JSON-RPC frames at the laptop. Fake keys and scratch config dirs only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "@tentacle/client";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, Method, type SessionSettingsReport } from "@tentacle/protocol";
import type { CreateModelProviderOptions } from "@tentacle/providers";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { applyCarried, carriedSettings, settingsNotices } from "../src/carried-settings.ts";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { laptopModels } from "../src/engine-runtime.ts";
import { podSessionHost, tunnelledAgent } from "../src/serve.ts";
import { changedNotice, settingsShowLines } from "../src/settings-view.ts";

const made: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "models-pod-"));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) {
    rmSync(d, { recursive: true, force: true });
  }
});

const MAIN_KEY = "fake-main-key";
const FAST_KEY = "fake-fast-key";
const CLAUDE_KEY = "fake-claude-key";
const HIDDEN_KEY = "fake-hidden-key";
const MAIN_ID = "main-model-id";

const LAPTOP = {
  model: { baseURL: "http://main.example/v1", model: MAIN_ID, apiKey: MAIN_KEY },
  models: {
    fast: {
      baseURL: "http://fast.example/v1",
      model: "fast-id",
      apiKey: FAST_KEY,
      contextWindow: 32768,
    },
    claude: {
      provider: "anthropic",
      baseURL: "http://claude.example/v1",
      model: "claude-id",
      apiKey: CLAUDE_KEY,
      description: "Strong.",
    },
    hidden: { baseURL: "http://hidden.example/v1", model: "hidden-id", apiKey: HIDDEN_KEY },
  },
  subagents: {
    execution: "sequential",
    maxParallel: 2,
    types: { explore: { model: "fast" } },
    selectableModels: ["claude"],
  },
};

function load(
  file: unknown,
  extra: Partial<Parameters<typeof loadConfig>[0]> = {},
): Promise<TentacleConfig> {
  const configDir = scratch();
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify(file));
  return loadConfig({
    configDir,
    cwd: configDir,
    scaffold: false,
    env: { HOME: scratch() },
    ...extra,
  });
}

/** The laptop's models, built by a spy: `main` for the main id, a recording child otherwise. */
function spyFactory(main: ModelProvider) {
  const built: CreateModelProviderOptions[] = [];
  const served = new Map<string, ChatRequest[]>();
  const create = (options: CreateModelProviderOptions): ModelProvider => {
    built.push(options);
    if (options.model === MAIN_ID) {
      return main;
    }
    const seen: ChatRequest[] = [];
    served.set(options.model, seen);
    return {
      id: options.model,
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        seen.push(request);
        yield { type: "text", delta: `from ${options.model}` };
        yield { type: "done" };
      },
    };
  };
  return { built, served, create };
}

const spawnCall = (args: Record<string, string>): StreamEvent => ({
  type: "tool_call",
  toolCall: {
    id: "c1",
    name: "agent_task",
    arguments: JSON.stringify({ description: "d", prompt: "CHILD", ...args }),
  },
});

class MainModel implements ModelProvider {
  readonly id = "main";
  readonly results: string[] = [];
  constructor(private readonly call: StreamEvent) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const last = request.messages.at(-1);
    if (last?.role === "tool") {
      this.results.push(last.content);
      yield { type: "text", delta: "done" };
      yield { type: "done" };
      return;
    }
    if (request.messages.some((m) => m.role === "user" && m.content.includes("CHILD"))) {
      yield { type: "text", delta: "from the MAIN model" };
      yield { type: "done" };
      return;
    }
    yield this.call;
    yield { type: "done" };
  }
}

/** A real pod agent and a real laptop on one channel; `frames` is everything that crossed. */
async function podRun(call: StreamEvent, podOver: Partial<TentacleConfig> = {}) {
  const laptop = await load(LAPTOP);
  const podConfig = {
    ...(await load(
      { models: { fast: { baseURL: "http://pod-own.example/v1", apiKey: "fake-pod-key" } } },
      { podDaemon: true },
    )),
    ...podOver,
  };
  const main = new MainModel(call);
  const f = spyFactory(main);
  const { modelProvider, ...rest } = laptopModels(laptop, f.create);
  const [a, b] = createChannelPair();
  const frames: string[] = [];
  const tap = (ch: DuplexChannel): DuplexChannel => ({
    ...ch,
    send: (data) => {
      frames.push(data);
      ch.send(data);
    },
  });
  let connection: Connection | null = null;
  const host = new SessionHost({
    defaultCwd: podConfig.cwd,
    createAgent: (cwd, context) =>
      tunnelledAgent({ ...podConfig, cwd }, () => connection, {
        ...(context?.settings ? { settings: context.settings } : {}),
      }),
  });
  connection = new Connection(tap(a), host);
  const client = new RemoteClient(tap(b), new PermissionBroker(), modelProvider, {
    ...rest,
    sessionSettings: carriedSettings(laptop),
  });
  await client.initialize();
  const session = client.newSession(undefined, "P");
  for await (const _event of session.send("go")) {
    // drain
  }
  connection.close();
  client.close();
  return { main, f, frames };
}

describe("a sub-agent in a pod runs on the laptop's named model", () => {
  test("a type's model: the laptop's entry serves it, with ITS key, and nothing secret crosses", async () => {
    const { main, f, frames } = await podRun(spawnCall({ subagent_type: "explore" }));
    expect(main.results).toEqual(["from fast-id"]);
    expect(f.served.get("fast-id")?.length).toBe(1);
    const entry = f.built.find((o) => o.model === "fast-id");
    expect([entry?.baseURL, entry?.apiKey]).toEqual(["http://fast.example/v1", FAST_KEY]);
    const wire = frames.join("\n");
    expect(wire).toContain('"model":"fast"');
    for (const secret of [
      MAIN_KEY,
      FAST_KEY,
      CLAUDE_KEY,
      HIDDEN_KEY,
      "fast.example",
      "claude.example",
      "hidden",
      "fast-id",
      "claude-id",
      "fake-pod-key",
      "pod-own.example",
    ]) {
      // "fast-id" DOES appear in the child's answer text: only the keys and URLs may never.
      if (secret !== "fast-id") {
        expect({ secret, found: wire.includes(secret) }).toEqual({ secret, found: false });
      }
    }
  });

  test("the agent's selectable pick reaches the laptop's entry", async () => {
    const { main, f } = await podRun(spawnCall({ subagent_type: "explore", model: "claude" }));
    expect(main.results).toEqual(["from claude-id"]);
    expect(f.built.find((o) => o.model === "claude-id")?.apiKey).toBe(CLAUDE_KEY);
  });

  test("an unconfigured type stays on the main model; no named provider is even built", async () => {
    const { main, f } = await podRun(spawnCall({ subagent_type: "general" }));
    expect(main.results).toEqual(["from the MAIN model"]);
    expect(f.built.map((o) => o.model)).toEqual([MAIN_ID]);
  });

  test("the pod's own agents/*.md naming a published entry: the MAIN model, nothing reaches the entry (owner Q3 b)", async () => {
    const agents = scratch();
    writeFileSync(
      join(agents, "scout.md"),
      "---\nname: scout\ndescription: Scout.\nmodel: claude\n---\nScout.",
    );
    const { main, f, frames } = await podRun(spawnCall({ subagent_type: "scout" }), {
      packageAgentDirs: [agents],
    });
    expect(main.results).toEqual(["from the MAIN model"]);
    expect(f.served.get("claude-id")).toBeUndefined();
    expect(f.built.map((o) => o.model)).toEqual([MAIN_ID]);
    expect(frames.some((frame) => frame.includes('"model":"claude"'))).toBe(false);
  });

  test("the pod's own `models` play no part", async () => {
    const { f } = await podRun(spawnCall({ subagent_type: "explore" }));
    expect(f.built.some((o) => o.baseURL.includes("pod-own"))).toBe(false);
  });

  test("a /settings sync re-routes the next sub-agent (real podSessionHost + session/update_settings)", async () => {
    const laptop = await load(LAPTOP);
    const podConfig = await load({}, { podDaemon: true });
    const main = new MainModel(spawnCall({ subagent_type: "explore" }));
    const f = spyFactory(main);
    const { modelProvider, ...rest } = laptopModels(laptop, f.create);
    const [a, b] = createChannelPair();
    const connection = new Connection(
      a,
      podSessionHost(podConfig, undefined, { modelProxy: true }),
      undefined,
      { servesModel: true },
    );
    // The client holds this object: changing it is this terminal's config changing.
    const settings = { ...carriedSettings(laptop) };
    const client = new RemoteClient(b, new PermissionBroker(), modelProvider, {
      ...rest,
      sessionSettings: settings,
    });
    await client.initialize();
    const session = client.newSession(undefined, "P");
    for await (const _event of session.send("first")) {
      // drain
    }
    const current = settings.publishedModels;
    if (!current) {
      throw new Error("the laptop published nothing");
    }
    settings.publishedModels = { ...current, types: [{ type: "explore", model: "claude" }] };
    expect((await session.applySettings())?.applied).toBe(true);
    for await (const _event of session.send("second")) {
      // drain
    }
    expect(main.results).toEqual(["from fast-id", "from claude-id"]);
    connection.close();
    client.close();
  });
});

describe("the carry of publishedModels", () => {
  const published = {
    models: [{ name: "fast", contextWindow: 1000 }],
    types: [{ type: "explore", model: "fast" }],
    selectable: [],
  };
  const report = (carried: unknown): SessionSettingsReport =>
    ({ carried, overridden: {} }) as unknown as SessionSettingsReport;
  const copy = () => JSON.parse(JSON.stringify(published)) as typeof published;

  test("applyCarried sets it; the laptop published nothing → the pod has none", async () => {
    const pod = await load({}, { podDaemon: true });
    expect(applyCarried(pod, { publishedModels: published }).config.publishedModels).toEqual(
      published,
    );
    expect(applyCarried(pod, { maxIterations: 3 }).config.publishedModels).toBeUndefined();
    expect(applyCarried(pod, undefined).config.publishedModels).toBeUndefined();
  });

  test("equal publications on both sides are no drift (they are different objects)", () => {
    expect(
      settingsNotices({ publishedModels: copy() }, report({ publishedModels: copy() })),
    ).toEqual([]);
    const [line] = settingsShowLines(
      { publishedModels: copy() },
      report({ publishedModels: copy() }),
    );
    expect(line?.text).toContain('"models": "(same text)"');
    expect(line?.text).not.toContain("differs from this terminal");
    expect(
      changedNotice(
        { publishedModels: copy() },
        report({ publishedModels: copy() }),
        report({ publishedModels: copy() }),
      ),
    ).toBeNull();
  });

  test("a different publication is drift, never its content", () => {
    const other = { ...copy(), selectable: ["fast"] };
    const notices = settingsNotices(
      { publishedModels: copy() },
      report({ publishedModels: other }),
    );
    expect(notices.map((n) => n.text)).toEqual([
      'Session settings: { "models": "(text differs)" }',
    ]);
    expect(JSON.stringify(notices)).not.toContain("fast");
  });

  test("this terminal publishes, the session does not: drift too, so a sync can fix it", () => {
    const notices = settingsNotices({ publishedModels: copy() }, report({}));
    expect(notices).toHaveLength(1);
    expect(notices[0]?.hint).toContain("/settings sync");
  });
});

describe("a HOSTILE pod against the real laptop gate (raw frames)", () => {
  interface Frame {
    readonly id?: number;
    readonly error?: { readonly code: number; readonly message: string };
  }

  async function hostile(
    file: unknown = LAPTOP,
    make: (main: ModelProvider) => ReturnType<typeof spyFactory> = spyFactory,
    extra: Partial<Parameters<typeof loadConfig>[0]> = {},
  ) {
    const laptop = await load(file, extra);
    const mainSeen: ChatRequest[] = [];
    const main: ModelProvider = {
      id: "main",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        mainSeen.push(request);
        yield { type: "done" };
      },
    };
    const f = make(main);
    const { modelProvider, ...rest } = laptopModels(laptop, f.create);
    const [podCh, clientCh] = createChannelPair();
    const client = new RemoteClient(clientCh, new PermissionBroker(), modelProvider, rest);
    const pending = new Map<number, (frame: Frame) => void>();
    podCh.setOnMessage((data) => {
      const frame = JSON.parse(data) as Frame;
      if (frame.id !== undefined) {
        pending.get(frame.id)?.(frame);
        pending.delete(frame.id);
      }
    });
    let next = 1;
    const call = (method: string, params: unknown): Promise<Frame> =>
      new Promise((resolve) => {
        const id = next++;
        pending.set(id, resolve);
        podCh.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      });
    return { call, f, mainSeen, client };
  }

  const request = { messages: [{ role: "user", content: "x" }] };

  for (const method of [Method.ModelStream, Method.ModelStreamChunked]) {
    test(`${method}: an entry the laptop has but did not publish: refused, no provider built`, async () => {
      const pod = await hostile();
      const before = pod.f.built.length;
      const { error } = await pod.call(method, { request, model: "hidden" });
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error?.message).toBe('model "hidden" is not published by this laptop');
      expect(pod.f.built.length).toBe(before);
      expect(pod.mainSeen).toEqual([]);
      pod.client.close();
    });

    test(`${method}: the main name spoofed: its id, "main", prototype names`, async () => {
      const pod = await hostile();
      const before = pod.f.built.length;
      for (const model of [MAIN_ID, "main", "default", "__proto__", "constructor", "toString"]) {
        const { error } = await pod.call(method, { request, model });
        expect({ model, code: error?.code }).toEqual({
          model,
          code: JsonRpcErrorCode.InvalidRequest,
        });
      }
      expect(pod.f.built.length).toBe(before);
      expect(pod.mainSeen).toEqual([]);
      pod.client.close();
    });

    test(`${method}: an endpoint in a frame cannot redirect a published name`, async () => {
      const pod = await hostile();
      const { error } = await pod.call(method, {
        request: { ...request, baseURL: "http://evil.example/v1" },
        model: "fast",
        baseURL: "http://evil.example/v1",
        apiKey: "stolen",
      });
      expect(error).toBeUndefined();
      expect(pod.f.built.find((o) => o.model === "fast-id")?.baseURL).toBe(
        "http://fast.example/v1",
      );
      expect(pod.f.built.some((o) => o.baseURL.includes("evil"))).toBe(false);
      pod.client.close();
    });
  }

  test("what the pod claims to have been published is never consulted", async () => {
    // A laptop with nothing published refuses, whatever the session's settings said.
    const pod = await hostile({ ...LAPTOP, subagents: {} });
    const { error } = await pod.call(Method.ModelStream, { request, model: "fast" });
    expect(error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
    expect(pod.f.built.map((o) => o.model)).toEqual([MAIN_ID]);
    pod.client.close();
  });

  test("a flood of unpublished and spoofed names: all refused, no provider built, main untouched", async () => {
    const pod = await hostile();
    const before = pod.f.built.length;
    const names = ["hidden", MAIN_ID, "main", "__proto__", "fast-id", "claude-id"];
    const frames = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        pod.call(i % 2 === 0 ? Method.ModelStream : Method.ModelStreamChunked, {
          request,
          model: names[i % names.length],
        }),
      ),
    );
    expect(frames.every((f) => f.error?.code === JsonRpcErrorCode.InvalidRequest)).toBe(true);
    expect(pod.f.built.length).toBe(before);
    expect([...pod.f.served.values()].every((seen) => seen.length === 0)).toBe(true);
    expect(pod.mainSeen).toEqual([]);
    pod.client.close();
  });

  test("a relay whose key command failed: the name is unavailable, and no key-less request is made", async () => {
    const lines: string[] = [];
    const pod = await hostile(
      {
        model: LAPTOP.model,
        models: {
          claude: { baseURL: "http://claude.example/v1", model: "c", apiKeyCommand: "exit 3" },
        },
        subagents: { selectableModels: ["claude"], maxParallel: 2 },
      },
      spyFactory,
      { modelKeysNoTerminal: { report: (_name, line) => lines.push(line) } },
    );
    const { error } = await pod.call(Method.ModelStream, { request, model: "claude" });
    expect(error?.message).toBe(
      'model "claude" is unavailable on this laptop: its key command did not succeed here',
    );
    expect(pod.f.built.some((o) => o.model === "c")).toBe(false);
    expect(lines).toEqual(["models.claude.apiKeyCommand exited with code 3: (no stderr)"]);
    // The main model is unaffected.
    expect((await pod.call(Method.ModelStream, { request })).error).toBeUndefined();
    pod.client.close();
  });
});
