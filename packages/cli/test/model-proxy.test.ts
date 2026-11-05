import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Agent } from "@tentacle/agent";
import { RemoteClient } from "@tentacle/client";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { type AgentFactory, Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import type { SessionSettings } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { createSettingsNotifier } from "../src/carried-settings.ts";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import * as serve from "../src/serve.ts";

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly seen: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.seen.push(request);
    const events = this.script[this.turn++] ?? [{ type: "done" }];
    for (const event of events) {
      yield event;
    }
  }
}

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

describe("model reverse-tunnel (F4.d)", () => {
  test("the daemon's ProxyModelProvider runs the model on the client over RPC", async () => {
    const [daemonCh, clientCh] = createChannelPair();

    // The "pod": a daemon whose agent has NO local model — only the proxy, which
    // tunnels calls back to the client over the connection. Built BEFORE the
    // client handshakes, so the daemon is there to answer `initialize`.
    // Annotated `let` (not const) to break the type cycle: the createAgent
    // closure references `connection`, which is assigned just below; it only
    // reads it when a session is created, by which point it is set.
    // biome-ignore lint/style/useConst: assigned after the closure that references it
    let connection: Connection;
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => ({
        agent: new Agent({
          model: new ProxyModelProvider((request) => connection.requestModelStream(request)),
          tools: new ToolRegistry(),
          env: noopEnv,
        }),
        permissions: new PermissionBroker(),
      }),
    });
    connection = new Connection(daemonCh, host);

    // The "laptop": a client holding the real (scripted) model.
    const localModel = new ScriptedProvider([
      [{ type: "text", delta: "answer from the laptop model" }, { type: "done" }],
    ]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), localModel);
    await client.initialize();

    // Drive a turn from the client; the text must have come from the local model.
    const session = client.newSession();
    let text = "";
    for await (const event of session.send("ping")) {
      if (event.type === "text") {
        text += event.delta;
      }
    }

    expect(text).toContain("answer from the laptop model");
    // The model actually ran on the client side (its request was recorded there),
    // and it saw the pod's user message.
    expect(localModel.seen).toHaveLength(1);
    expect(localModel.seen[0]?.messages.at(-1)).toEqual({ role: "user", content: "ping" });

    connection.close();
    client.close();
  });

  test("a pod's session title is asked of the LAPTOP's model, over the same tunnel (docs/feat/session-titles.md)", async () => {
    // Mutation: the pod's factory gives the title its own provider → the
    // laptop model sees one request, the title never comes from the laptop.
    const [daemonCh, clientCh] = createChannelPair();
    // biome-ignore lint/style/useConst: assigned after the closure that references it
    let connection: Connection;
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => {
        // What `buildAgent` does with `modelOverride`: the proxy for the turn AND the title.
        const proxy = new ProxyModelProvider((request) => connection.requestModelStream(request));
        return {
          agent: new Agent({ model: proxy, tools: new ToolRegistry(), env: noopEnv }),
          permissions: new PermissionBroker(),
          titleModel: proxy,
        };
      },
    });
    connection = new Connection(daemonCh, host);
    const localModel = new ScriptedProvider([
      [{ type: "text", delta: "answer from the laptop model" }, { type: "done" }],
      [{ type: "text", delta: "Ping from the laptop" }, { type: "done" }],
    ]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), localModel);
    await client.initialize();
    const session = client.newSession(undefined, "P");
    const titles: string[] = [];
    session.onTitle((t) => titles.push(t.title));
    for await (const _event of session.send("ping")) {
      // drain
    }
    const deadline = Date.now() + 1000;
    while (titles.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2));
    }
    expect(titles).toEqual(["Ping from the laptop"]);
    expect(localModel.seen).toHaveLength(2);
    expect(localModel.seen[1]?.messages[0]?.content).toContain("3–6 word title");
    expect(host.get("P")?.summary("/pod/work").title).toBe("Ping from the laptop");

    connection.close();
    client.close();
  });
});

// Follow-up 1 (docs/feat/session-titles.md): a pod's title call is MARKED on
// the tunnel (`purpose: "title"`) and the LAPTOP picks the model for it —
// `model.titleModel`, else the main one — or refuses it when its
// `model.autoTitle` is off. The pod never names a model, and its own config
// cannot turn titles on.
describe("the title call over the model tunnel", () => {
  const ask = { messages: [{ role: "user" as const, content: "name this" }] };
  const reply = (text: string): readonly StreamEvent[] => [
    { type: "text", delta: text },
    { type: "done" },
  ];
  const never = (): never => {
    throw new Error("no session in this test");
  };

  function link(laptopTitle: ModelProvider | undefined) {
    const [daemonCh, clientCh] = createChannelPair();
    const host = new SessionHost({ defaultCwd: "/pod/work", createAgent: () => never() });
    const connection = new Connection(daemonCh, host);
    const main = new ScriptedProvider([reply("main 1"), reply("main 2"), reply("main 3")]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), main, {
      ...(laptopTitle ? { titleModelProvider: laptopTitle } : {}),
    } as never);
    return { connection, client, main };
  }
  const texts = (events: readonly { type: string; delta?: string }[]) =>
    events.flatMap((e) => (e.type === "text" ? [e.delta] : []));
  // `requestModelStream(request, purpose)`: read loosely so a tree without the
  // purpose fails on the assertion, not on the call's arity.
  type Purposeful = {
    requestModelStream: (r: unknown, purpose?: string) => Promise<{ events: { type: string }[] }>;
    requestModelStreamChunked: (
      r: unknown,
      h: { onProgress: (v: unknown, seq: number) => void },
      purpose?: string,
    ) => Promise<{ chunks: number }>;
  };

  test("a title call is served by the laptop's title provider, a normal turn by the main one (both transports)", async () => {
    const small = new ScriptedProvider([reply("Small title"), reply("Small chunked")]);
    const { connection, client, main } = link(small);
    await client.initialize();
    const c = connection as unknown as Purposeful;
    expect(texts((await c.requestModelStream(ask, "title")).events)).toEqual(["Small title"]);
    expect(texts((await c.requestModelStream(ask)).events)).toEqual(["main 1"]);
    const chunks: unknown[] = [];
    await c.requestModelStreamChunked(ask, { onProgress: (v) => chunks.push(v) }, "title");
    expect(texts(chunks.flat() as { type: string; delta?: string }[])).toEqual(["Small chunked"]);
    expect(small.seen).toHaveLength(2);
    expect(main.seen).toHaveLength(1);
    connection.close();
    client.close();
  });

  test("the laptop's gate: autoTitle off (no title provider) → a title call is REFUSED; the main model is never asked", async () => {
    const { connection, client, main } = link(undefined);
    await client.initialize();
    const c = connection as unknown as Purposeful;
    await expect(c.requestModelStream(ask, "title")).rejects.toThrow(/titles are off/);
    await expect(
      c.requestModelStreamChunked(ask, { onProgress: () => {} }, "title"),
    ).rejects.toThrow(/titles are off/);
    expect(main.seen).toHaveLength(0);
    connection.close();
    client.close();
  });
});

describe("the pod daemon's agent (serve --stdio --model-proxy): the LAPTOP's autoTitle decides", () => {
  let dir: string;
  let config: TentacleConfig;
  const saved = process.env.TENTACLE_CONFIG_DIR;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-proxy-titles-"));
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
    config = await loadConfig({ cwd: dir });
  });
  afterAll(async () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
    else process.env.TENTACLE_CONFIG_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  type Tunnelled = (
    config: TentacleConfig,
    link: () => Connection | null,
    options: { settings: { autoTitle: boolean } },
  ) => ReturnType<AgentFactory>;

  async function pod(podConfig: TentacleConfig, autoTitle: boolean) {
    const tunnelled = (serve as Record<string, unknown>).tunnelledAgent as Tunnelled | undefined;
    expect(typeof tunnelled).toBe("function");
    const [daemonCh, clientCh] = createChannelPair();
    let connection: Connection | null = null;
    const host = new SessionHost({
      defaultCwd: dir,
      createAgent: (cwd) =>
        (tunnelled as Tunnelled)({ ...podConfig, cwd }, () => connection, {
          settings: { autoTitle },
        }),
    });
    connection = new Connection(daemonCh, host);
    const main = new ScriptedProvider([
      [{ type: "text", delta: "the turn" }, { type: "done" }],
      [{ type: "text", delta: "Main would title" }, { type: "done" }],
    ]);
    const small = new ScriptedProvider([
      [{ type: "text", delta: "Small title" }, { type: "done" }],
    ]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), main, {
      titleModelProvider: small,
    } as never);
    await client.initialize();
    const session = client.newSession(undefined, "P");
    for await (const _event of session.send("please fix the login bug")) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 30));
    const title = host.get("P")?.summary(dir).title;
    connection.close();
    client.close();
    return { main, small, title };
  }

  test("laptop on → the pod's title call rides the tunnel as a TITLE call: the laptop's title model answers", async () => {
    const { main, small, title } = await pod(config, true);
    expect(main.seen).toHaveLength(1);
    expect(small.seen).toHaveLength(1);
    expect(title).toBe("Small title");
  });

  test("laptop off → no title call at all, even when the POD's own config says autoTitle: true", async () => {
    const { main, small, title } = await pod({ ...config, autoTitle: true }, false);
    expect(main.seen).toHaveLength(1);
    expect(small.seen).toHaveLength(0);
    expect(title).toBe("please fix the login bug");
  });
});

// docs/feat/context-awareness.md: over the tunnel the model sees the rendered line (no
// proxy change), on the LAPTOP's window; whether lines are on is the POD's config.
describe("the pod daemon's agent: context lines on the laptop's window", () => {
  let dir: string;
  let config: TentacleConfig;
  const saved = process.env.TENTACLE_CONFIG_DIR;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "model-proxy-context-"));
    process.env.TENTACLE_CONFIG_DIR = join(dir, "config");
    config = await loadConfig({ cwd: dir });
  });
  afterAll(async () => {
    if (saved === undefined) Reflect.deleteProperty(process.env, "TENTACLE_CONFIG_DIR");
    else process.env.TENTACLE_CONFIG_DIR = saved;
    await rm(dir, { recursive: true, force: true });
  });

  async function firstPrompt(podConfig: TentacleConfig, contextWindow?: number): Promise<string> {
    const [daemonCh, clientCh] = createChannelPair();
    let connection: Connection | null = null;
    const host = new SessionHost({
      defaultCwd: dir,
      createAgent: (cwd) =>
        serve.tunnelledAgent({ ...podConfig, cwd }, () => connection, {
          settings: {
            autoTitle: false,
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          },
        }),
    });
    connection = new Connection(daemonCh, host);
    const laptop = new ScriptedProvider([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), laptop);
    await client.initialize();
    const session = client.newSession(undefined, "C");
    for await (const _event of session.send("hello")) {
      // drain
    }
    connection.close();
    client.close();
    return laptop.seen[0]?.messages.at(-1)?.content ?? "";
  }

  test("the laptop's window (carried) wins over the pod's own", async () => {
    const sent = await firstPrompt({ ...config, contextWindow: 128000 }, 200000);
    expect(sent).toMatch(/^hello\n\n\[context: [\d.]+[kM]? \/ 200k tokens \(\d+%\)\]$/);
  });

  test("the pod's config turns the lines off", async () => {
    const sent = await firstPrompt(
      { ...config, contextAwareness: { enabled: false, stepPercent: 1 } },
      200000,
    );
    expect(sent).toBe("hello");
  });
});

// docs/feat/config-carry.md, end to end: the real client's `sessionSettings`, the
// real pod host, and the behaviour the laptop's model sees over the tunnel.
describe("the laptop's settings reach the pod's agents, per session", () => {
  const made: string[] = [];
  afterAll(async () => {
    for (const d of made) {
      await rm(d, { recursive: true, force: true });
    }
  });
  async function folder(files: Record<string, string> = {}): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "config-carry-"));
    made.push(d);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(d, name)), { recursive: true });
      await writeFile(join(d, name), text);
    }
    return d;
  }
  /** The pod's config, as a pod daemon loads it, in a pod workspace `cwd`. */
  async function podConfig(file: unknown = {}, cwd?: string): Promise<TentacleConfig> {
    return loadConfig({
      configDir: await folder({ "config.jsonc": JSON.stringify(file) }),
      cwd: cwd ?? (await folder()),
      scaffold: false,
      env: { HOME: await folder() },
      podDaemon: true,
    });
  }

  const toolCall = (name: string, args: string, id = "c1"): readonly StreamEvent[] => [
    { type: "tool_call", toolCall: { id, name, arguments: args } },
    { type: "done" },
  ];
  const done: readonly StreamEvent[] = [{ type: "text", delta: "ok" }, { type: "done" }];

  /** A laptop (a real `RemoteClient` with `settings`) on a pod host over a channel pair. */
  async function linked(
    config: TentacleConfig,
    settings: SessionSettings | undefined,
    script: readonly (readonly StreamEvent[])[] = [done, done, done],
  ) {
    const [daemonCh, clientCh] = createChannelPair();
    const host = serve.podSessionHost(config, undefined, { modelProxy: true });
    const connection = new Connection(daemonCh, host, undefined, { servesModel: true });
    const laptop = new ScriptedProvider(script);
    const client = new RemoteClient(clientCh, new PermissionBroker(), laptop, {
      ...(settings ? { sessionSettings: settings } : {}),
    });
    await client.initialize();
    const finish = (): void => {
      connection.close();
      client.close();
    };
    return { host, client, laptop, finish };
  }
  const say = async (client: RemoteClient, id: string, text = "hello"): Promise<void> => {
    for await (const _event of client.newSession(undefined, id).send(text)) {
      // drain
    }
  };
  const toolsOf = (request: ChatRequest | undefined): string[] =>
    (request?.tools ?? []).map((t) => t.name);
  const systemOf = (request: ChatRequest | undefined): string =>
    String(request?.messages[0]?.content);

  test("maxIterations: the turn stops where the LAPTOP says (a pod that set nothing)", async () => {
    // Mutation: don't pass `settings` in `podSessionHost` → a second round runs.
    const script = [
      toolCall("no_such_tool", "{}"),
      toolCall("no_such_tool", "{}"),
      toolCall("no_such_tool", "{}"),
      toolCall("no_such_tool", "{}"),
      done,
    ];
    const rounds = async (settings: SessionSettings | undefined): Promise<number> => {
      const { client, laptop, finish } = await linked(await podConfig(), settings, script);
      await say(client, "S");
      finish();
      return laptop.seen.length;
    };
    const free = await rounds(undefined);
    expect(free).toBe(script.length);
    expect(await rounds({ maxIterations: 1 })).toBeLessThan(free);
  });

  test("redactSecrets: the tool result the model reads is redacted by the carried value", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const cwd = await folder({ "creds.txt": `key=${secret}\n` });
    const script = [toolCall("fs_read", JSON.stringify({ path: "creds.txt" })), done];
    const on = await linked(await podConfig({}, cwd), { redactSecrets: true }, script);
    await say(on.client, "S");
    expect(JSON.stringify(on.laptop.seen[1]?.messages)).toContain("[REDACTED]");
    expect(JSON.stringify(on.laptop.seen[1]?.messages)).not.toContain(secret);
    on.finish();

    // The pod's own explicit `false` beats it (W): even at the default value.
    const pinned = await linked(
      await podConfig({ tools: { redactSecrets: false } }, cwd),
      { redactSecrets: true },
      script,
    );
    await say(pinned.client, "S");
    expect(JSON.stringify(pinned.laptop.seen[1]?.messages)).toContain(secret);
    pinned.finish();
  });

  test("contextWindow reaches the model's context line", async () => {
    const { client, laptop, finish } = await linked(await podConfig(), { contextWindow: 200000 });
    await say(client, "S");
    expect(String(laptop.seen[0]?.messages.at(-1)?.content)).toContain("/ 200k tokens");
    finish();
  });

  test("subagents off and contextReset off: the pod's agent does not offer those tools", async () => {
    const offered = await linked(await podConfig(), {});
    await say(offered.client, "S");
    expect(toolsOf(offered.laptop.seen[0])).toContain("agent_task");
    expect(toolsOf(offered.laptop.seen[0])).toContain("context_reset");
    offered.finish();

    const off = await linked(await podConfig(), {
      subagentsEnabled: false,
      contextResetEnabled: false,
    });
    await say(off.client, "S");
    expect(toolsOf(off.laptop.seen[0])).not.toContain("agent_task");
    expect(toolsOf(off.laptop.seen[0])).not.toContain("context_reset");
    off.finish();
  });

  test("loadAgentsMd / loadSkills off: the FIRST request has neither, and /name lists none", async () => {
    // Mutation: flip the flags without recomposing → the rules reach the model.
    const repo = {
      "AGENTS.md": "RULE-FROM-AGENTS-MD\n",
      ".git/HEAD": "ref\n",
      ".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: a demo skill\n---\nBody\n",
    };
    const on = await linked(await podConfig({}, await folder(repo)), {});
    expect((await on.client.sessionSkills()).skills.map((s) => s.name)).toEqual(["demo"]);
    await say(on.client, "S");
    expect(systemOf(on.laptop.seen[0])).toContain("RULE-FROM-AGENTS-MD");
    expect(toolsOf(on.laptop.seen[0])).toContain("skill");
    on.finish();

    const off = await linked(await podConfig({}, await folder(repo)), {
      loadAgentsMd: false,
      loadSkills: false,
    });
    expect((await off.client.sessionSkills()).skills).toEqual([]);
    await say(off.client, "S");
    expect(systemOf(off.laptop.seen[0])).not.toContain("RULE-FROM-AGENTS-MD");
    expect(systemOf(off.laptop.seen[0])).not.toContain("demo");
    expect(toolsOf(off.laptop.seen[0])).not.toContain("skill");
    expect((await off.client.sessionSkills("S")).skills).toEqual([]);
    off.finish();
  });

  test("two sessions on one resident follow whichever laptop opens each (the frozen flags are gone)", async () => {
    // Mutation: cache the first merge in `podSessionHost` → B gets A's tools.
    const [d1, c1] = createChannelPair();
    const [d2, c2] = createChannelPair();
    const host = serve.podSessionHost(await podConfig(), undefined, { modelProxy: true });
    const conn1 = new Connection(d1, host, undefined, { servesModel: true });
    const conn2 = new Connection(d2, host, undefined, { servesModel: true });
    const modelA = new ScriptedProvider([done]);
    const modelB = new ScriptedProvider([done]);
    const a = new RemoteClient(c1, new PermissionBroker(), modelA, {
      sessionSettings: { subagentsEnabled: false },
    });
    const b = new RemoteClient(c2, new PermissionBroker(), modelB, {
      sessionSettings: { subagentsEnabled: true },
    });
    await a.initialize();
    await b.initialize();
    await say(a, "A");
    await say(b, "B");
    expect(toolsOf(modelA.seen[0])).not.toContain("agent_task");
    expect(toolsOf(modelB.seen[0])).toContain("agent_task");
    conn1.close();
    conn2.close();
    a.close();
    b.close();
  });

  test("re-attaching a live session with other settings: its agent stands, the report says so", async () => {
    const [d1, c1] = createChannelPair();
    const [d2, c2] = createChannelPair();
    const host = serve.podSessionHost(await podConfig(), undefined, { modelProxy: true });
    const conn1 = new Connection(d1, host, undefined, { servesModel: true });
    const conn2 = new Connection(d2, host, undefined, { servesModel: true });
    const modelA = new ScriptedProvider([done]);
    const modelB = new ScriptedProvider([done]);
    const mineA: SessionSettings = { subagentsEnabled: false, maxIterations: 4 };
    const mineB: SessionSettings = { subagentsEnabled: true, maxIterations: 9 };
    const a = new RemoteClient(c1, new PermissionBroker(), modelA, { sessionSettings: mineA });
    const b = new RemoteClient(c2, new PermissionBroker(), modelB, { sessionSettings: mineB });
    await a.initialize();
    await b.initialize();
    await say(a, "S");
    const said: string[] = [];
    b.onSessionSettings(createSettingsNotifier(mineB, (line) => said.push(line)));
    await say(b, "S", "again");
    expect(toolsOf(modelB.seen[0])).not.toContain("agent_task");
    expect(said).toEqual([
      'Session settings: { "subagents.enabled": false, "maxIterations": 4 } (/clear to reset)',
    ]);
    conn1.close();
    conn2.close();
    a.close();
    b.close();
  });

  test("session/context with no id counts what the session then opened sends", async () => {
    // Mutation: ignore `settings` in `newSessionContext` → the probe offers more tools.
    class Counting extends ScriptedProvider {
      readonly counted: ChatRequest[] = [];
      async countTokens(request: ChatRequest): Promise<number> {
        this.counted.push(request);
        return 1;
      }
    }
    const [daemonCh, clientCh] = createChannelPair();
    const host = serve.podSessionHost(await podConfig(), undefined, { modelProxy: true });
    const connection = new Connection(daemonCh, host, undefined, { servesModel: true });
    const laptop = new Counting([done]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), laptop, {
      sessionSettings: { subagentsEnabled: false, contextResetEnabled: false },
    });
    await client.initialize();
    await client.sessionContext();
    await client.openSession(undefined, undefined, "S");
    await client.sessionContext("S");
    expect(laptop.counted).toHaveLength(2);
    expect(toolsOf(laptop.counted[0])).not.toContain("agent_task");
    expect(toolsOf(laptop.counted[0])).toEqual(toolsOf(laptop.counted[1]));
    connection.close();
    client.close();
  });

  test("hostile pod: a daemon that drops the settings changes nothing on the laptop, and the title gate holds", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    const own = await podConfig();
    // The pod ignores everything it is sent, and its own config says titles on.
    const hostile = new SessionHost({
      defaultCwd: "/pod",
      createAgent: (cwd, { modelLink }) =>
        serve.tunnelledAgent(
          { ...own, cwd, autoTitle: true },
          modelLink,
          // Sends a title call whatever the laptop said.
          { settings: { autoTitle: true } },
        ),
    });
    const connection = new Connection(daemonCh, hostile, undefined, { servesModel: true });
    const main = new ScriptedProvider([done, done]);
    const client = new RemoteClient(clientCh, new PermissionBroker(), main, {
      sessionSettings: { autoTitle: false },
    });
    await client.initialize();
    await say(client, "S");
    await new Promise((r) => setTimeout(r, 30));
    // Only the turn: with no title provider here the laptop refused the title call.
    expect(main.seen).toHaveLength(1);
    expect(hostile.get("S")?.summary("/pod").title).toBe("hello");
    connection.close();
    client.close();
  });
});

describe("a daemon the laptop does not launch ignores `settings`", () => {
  const skill = "---\nname: demo\ndescription: a demo skill\n---\nBody\n";
  async function own(dir: string): Promise<TentacleConfig> {
    await mkdir(join(dir, ".agents", "skills", "demo"), { recursive: true });
    await writeFile(join(dir, ".agents", "skills", "demo", "SKILL.md"), skill);
    return loadConfig({
      configDir: dir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
  }
  async function check(host: SessionHost): Promise<void> {
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    const client = new RemoteClient(clientCh, new PermissionBroker(), undefined, {
      sessionSettings: { loadSkills: false, subagentsEnabled: false },
    });
    let reports = 0;
    client.onSessionSettings(() => {
      reports++;
    });
    await client.initialize();
    expect((await client.sessionSkills()).skills.map((s) => s.name)).toEqual(["demo"]);
    await client.openSession(undefined, undefined, "S");
    expect(reports).toBe(0);
    expect((await client.sessionSkills("S")).skills.map((s) => s.name)).toEqual(["demo"]);
    connection.close();
    client.close();
  }

  test("a plain `serve --stdio` host (no model proxy) builds from its own config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "config-carry-plain-"));
    await check(serve.podSessionHost(await own(dir), undefined, {}));
    await rm(dir, { recursive: true, force: true });
  });
});
