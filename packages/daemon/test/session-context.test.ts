/**
 * `session/context` and the `model/countTokens` tunnel (docs/feat/tui-target-badge.md):
 * the context a session would send now, exact when the provider counts, else
 * estimated; in a pod daemon the count is made by the LAPTOP through the tunnel.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import type { ModelCountTokensParams, SessionContextResult } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { ProxyModelProvider } from "../src/proxy-model.ts";
import { SessionHost } from "../src/session-host.ts";

const noopEnv = {
  id: "noop",
  exec() {
    throw new Error("unused");
  },
} as unknown as ExecutionEnvironment;

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };

class Counting implements ModelProvider {
  readonly id = "counting";
  readonly counted: ChatRequest[] = [];
  constructor(private readonly tokens: number | undefined) {}
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("must not generate");
  }
  async countTokens(request: ChatRequest): Promise<number | undefined> {
    this.counted.push(request);
    return this.tokens;
  }
}

function connect(
  createModel: (link: () => { requestModelCountTokens?: unknown } | null) => ModelProvider,
  clientHandlers: ConstructorParameters<typeof RpcPeer>[1] = {},
  options: ConstructorParameters<typeof Connection>[3] = {},
) {
  const host = new SessionHost({
    defaultCwd: "/tmp/w",
    createAgent: (_cwd, { modelLink }) => ({
      agent: new Agent({
        model: createModel(modelLink as never),
        tools: new ToolRegistry(),
        env: noopEnv,
        systemPrompt: "you are a test",
      }),
      permissions: new PermissionBroker(),
    }),
  });
  const [daemonCh, clientCh] = createChannelPair();
  const connection = new Connection(daemonCh, host, undefined, options);
  const client = new RpcPeer(clientCh, clientHandlers);
  return { host, connection, client };
}

describe("session/context", () => {
  test("an opened session: the provider's exact count, from the request the loop would send", async () => {
    const model = new Counting(777);
    const { client, connection } = connect(() => model);
    await client.request("initialize", INIT);
    await client.request("session/open", { sessionId: "s1", create: true });
    const got = (await client.request("session/context", {
      sessionId: "s1",
    })) as SessionContextResult;
    expect(got).toEqual({ used: 777, exact: true });
    expect(model.counted[0]?.messages[0]).toEqual({ role: "system", content: "you are a test" });
    connection.close();
  });

  test("no session yet (fresh): the fresh conversation is counted, and no session is created", async () => {
    const model = new Counting(55);
    const { client, host, connection } = connect(() => model);
    await client.request("initialize", INIT);
    const got = (await client.request("session/context", {})) as SessionContextResult;
    expect(got).toEqual({ used: 55, exact: true });
    expect(model.counted[0]?.messages).toEqual([{ role: "system", content: "you are a test" }]);
    expect(host.list({}).sessions).toHaveLength(0);
    connection.close();
  });

  test("a provider that cannot count: an estimate, not exact", async () => {
    const { client, connection } = connect(() => new Counting(undefined));
    await client.request("initialize", INIT);
    const got = (await client.request("session/context", {})) as SessionContextResult;
    expect(got.exact).toBe(false);
    expect(got.used).toBeGreaterThan(0);
    connection.close();
  });

  test("a session id this connection never opened: an error, not a count", async () => {
    const { client, connection } = connect(() => new Counting(1));
    await client.request("initialize", INIT);
    await expect(client.request("session/context", { sessionId: "nope" })).rejects.toBeInstanceOf(
      RpcError,
    );
    connection.close();
  });
});

describe("round 3 (LOW 4): a fresh count made before the daemon's tools are all listed is not exact", () => {
  const hostWithTools = (ready: boolean) =>
    new SessionHost({
      defaultCwd: "/tmp/w",
      toolsReady: () => ready,
      createAgent: () => ({
        agent: new Agent({
          model: new Counting(99),
          tools: new ToolRegistry(),
          env: noopEnv,
          systemPrompt: "s",
        }),
        permissions: new PermissionBroker(),
      }),
    });

  test("tools still connecting (MCP): the provider's figure is shown as an estimate (`~`)", async () => {
    expect(await hostWithTools(false).newSessionContext(null)).toEqual({ used: 99, exact: false });
  });

  test("tools complete: exact, as before", async () => {
    expect(await hostWithTools(true).newSessionContext(null)).toEqual({ used: 99, exact: true });
  });
});

describe("ProxyModelProvider.countTokens (the pod reverse-tunnel)", () => {
  const REQ: ChatRequest = { messages: [{ role: "user", content: "x" }] };
  const never = () => Promise.reject(new Error("unused"));

  test("asks the laptop; a number is exact, an omitted `tokens` is undefined", async () => {
    const seen: unknown[] = [];
    const ok = new ProxyModelProvider(never, undefined, async (wire) => {
      seen.push(wire);
      return { tokens: 9 };
    });
    expect(await ok.countTokens(REQ)).toBe(9);
    expect(seen).toEqual([{ messages: [{ role: "user", content: "x" }] }]);
    const none = new ProxyModelProvider(never, undefined, async () => ({}));
    expect(await none.countTokens(REQ)).toBeUndefined();
  });

  test("an old laptop (MethodNotFound): undefined; any other failure rejects (the caller estimates)", async () => {
    const old = new ProxyModelProvider(never, undefined, async () => {
      throw Object.assign(new Error("nope"), { code: JsonRpcErrorCode.MethodNotFound });
    });
    expect(await old.countTokens(REQ)).toBeUndefined();
    const broken = new ProxyModelProvider(never, undefined, async () => {
      throw new Error("link down");
    });
    await expect(broken.countTokens(REQ)).rejects.toThrow("link down");
  });

  test("round 2 (MEDIUM 4): the request's signal reaches the tunnel sender (a cut count is aborted)", async () => {
    let seen: AbortSignal | undefined;
    const provider = new ProxyModelProvider(never, undefined, async (_wire, signal) => {
      seen = signal;
      return { tokens: 1 };
    });
    const ctl = new AbortController();
    await provider.countTokens({ ...REQ, signal: ctl.signal });
    expect(seen).toBe(ctl.signal);
  });

  test("no count sender: undefined", async () => {
    expect(await new ProxyModelProvider(never).countTokens(REQ)).toBeUndefined();
  });
});

describe("ProxyModelProvider.slots (T-S, docs/feat/parallel-agents.md)", () => {
  const never = () => Promise.reject(new Error("unused"));

  test("asks the laptop; a number comes back, an omitted `slots` is undefined", async () => {
    const ok = new ProxyModelProvider(never, undefined, undefined, async () => ({ slots: 2 }));
    expect(await ok.slots()).toBe(2);
    const none = new ProxyModelProvider(never, undefined, undefined, async () => ({}));
    expect(await none.slots()).toBeUndefined();
  });

  test("an old laptop (MethodNotFound): undefined; any other failure rejects", async () => {
    const old = new ProxyModelProvider(never, undefined, undefined, async () => {
      throw Object.assign(new Error("nope"), { code: JsonRpcErrorCode.MethodNotFound });
    });
    expect(await old.slots()).toBeUndefined();
    const broken = new ProxyModelProvider(never, undefined, undefined, async () => {
      throw new Error("link down");
    });
    await expect(broken.slots()).rejects.toThrow("link down");
  });

  test("the signal reaches the sender; no sender: undefined", async () => {
    let seen: AbortSignal | undefined;
    const provider = new ProxyModelProvider(never, undefined, undefined, async (signal) => {
      seen = signal;
      return {};
    });
    const controller = new AbortController();
    await provider.slots(controller.signal);
    expect(seen).toBe(controller.signal);
    expect(await new ProxyModelProvider(never).slots()).toBeUndefined();
  });
});

describe("a pod daemon: the count is done by the LAPTOP, through the model link", () => {
  test("session/context → model/countTokens on the client; the answer comes back exact", async () => {
    const asked: ModelCountTokensParams[] = [];
    const { client, connection } = connect(
      (link) =>
        new ProxyModelProvider(
          () => Promise.reject(new Error("no stream")),
          undefined,
          (wire) => {
            const l = link() as {
              requestModelCountTokens(r: unknown): Promise<{ tokens?: number }>;
            } | null;
            if (!l) {
              throw new Error("no link");
            }
            return l.requestModelCountTokens(wire);
          },
        ),
      {
        onRequest: async (method, params) => {
          if (method === "model/countTokens") {
            asked.push(params as ModelCountTokensParams);
            return { tokens: 4242 };
          }
          throw new RpcError(JsonRpcErrorCode.MethodNotFound, method);
        },
      },
      { servesModel: true },
    );
    await client.request("initialize", INIT);
    await client.request("session/open", { sessionId: "p1", create: true });
    const got = (await client.request("session/context", {
      sessionId: "p1",
    })) as SessionContextResult;
    expect(got).toEqual({ used: 4242, exact: true });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.request.messages[0]).toEqual({ role: "system", content: "you are a test" });
    connection.close();
  });

  test("an old laptop answering MethodNotFound: the daemon estimates, silently", async () => {
    const { client, connection } = connect(
      (link) =>
        new ProxyModelProvider(
          () => Promise.reject(new Error("no stream")),
          undefined,
          (wire) => {
            const l = link() as {
              requestModelCountTokens(r: unknown): Promise<{ tokens?: number }>;
            } | null;
            if (!l) {
              throw new Error("no link");
            }
            return l.requestModelCountTokens(wire);
          },
        ),
      {},
      { servesModel: true },
    );
    await client.request("initialize", INIT);
    await client.request("session/open", { sessionId: "p2", create: true });
    const got = (await client.request("session/context", {
      sessionId: "p2",
    })) as SessionContextResult;
    expect(got.exact).toBe(false);
    expect(got.used).toBeGreaterThan(0);
    connection.close();
  });
});
