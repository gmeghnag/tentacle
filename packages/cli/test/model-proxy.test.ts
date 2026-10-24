import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { RemoteClient } from "@tentacle/client";
import type { ChatRequest, ExecutionEnvironment, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { type AgentFactory, Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
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
    options: { autoTitle: boolean },
  ) => ReturnType<AgentFactory>;

  async function pod(podConfig: TentacleConfig, autoTitle: boolean) {
    const tunnelled = (serve as Record<string, unknown>).tunnelledAgent as Tunnelled | undefined;
    expect(typeof tunnelled).toBe("function");
    const [daemonCh, clientCh] = createChannelPair();
    let connection: Connection | null = null;
    const host = new SessionHost({
      defaultCwd: dir,
      createAgent: (cwd) =>
        (tunnelled as Tunnelled)({ ...podConfig, cwd }, () => connection, { autoTitle }),
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
