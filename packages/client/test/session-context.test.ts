/**
 * `RemoteSession.context` and the laptop side of `model/countTokens`
 * (docs/feat/tui-target-badge.md), over real daemon objects: the context a
 * session would send, exact when a provider counts; in a pod run the count is
 * served by the LAPTOP's provider (the model and its key stay there).
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
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
} as unknown as ExecutionEnvironment;

class Counter implements ModelProvider {
  readonly id = "counter";
  readonly counted: ChatRequest[] = [];
  constructor(private readonly count: () => Promise<number | undefined>) {}
  // biome-ignore lint/correctness/useYield: never streams here
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("must not generate");
  }
  countTokens(request: ChatRequest): Promise<number | undefined> {
    this.counted.push(request);
    return this.count();
  }
}

/** Counts the characters of the request: a conversation's size is visible in the figure. */
class CharCounter extends Counter {
  constructor() {
    super(async () => 0);
  }
  override countTokens(request: ChatRequest): Promise<number | undefined> {
    this.counted.push(request);
    return Promise.resolve(request.messages.reduce((n, m) => n + m.content.length, 0));
  }
}

function hostWith(model: ModelProvider): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/ctx",
    createAgent: () => ({
      agent: new Agent({ model, tools: new ToolRegistry(), env, systemPrompt: "sys" }),
      permissions: new PermissionBroker(),
    }),
  });
}

describe("round 2 (HIGH 1): attach and resume count the REAL conversation", () => {
  const BIG = "x".repeat(5000);
  const seed = [
    { role: "system" as const, content: "sys" },
    { role: "user" as const, content: BIG },
    { role: "assistant" as const, content: BIG },
  ];

  test("attach: the daemon's history is counted — never the fresh empty conversation", async () => {
    const host = hostWith(new CharCounter());
    // Another client created a session with a history.
    const [d1, c1] = createChannelPair();
    new Connection(d1, host);
    const owner = new RemoteClient(c1, new PermissionBroker());
    await owner.initialize();
    await owner.openSession(undefined, seed, "A");
    // This client attaches to it; the TUI asks `context()` BEFORE `open()`.
    const [d2, c2] = createChannelPair();
    new Connection(d2, host);
    const client = new RemoteClient(c2, new PermissionBroker());
    await client.initialize();
    const session = client.newSession(undefined, "A", undefined, { attach: {} });
    const got = await session.context();
    expect(got.used).toBeGreaterThanOrEqual(10_000);
    expect(got.exact).toBe(true);
    client.close();
    owner.close();
  });

  test("resume (seeded, not opened yet): the seed is counted, not an empty conversation", async () => {
    const model = new CharCounter();
    const host = hostWith(model);
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const session = client.newSession(seed, "R");
    const got = await session.context();
    expect(got.used).toBeGreaterThanOrEqual(10_000);
    expect(host.list({}).sessions).toHaveLength(0); // nothing was created for it
    client.close();
  });

  test("an attach that fails (unknown id): no count at all, never a fresh-empty figure", async () => {
    const host = hostWith(new CharCounter());
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const session = client.newSession(undefined, "nope", undefined, { attach: {} });
    await expect(session.context()).rejects.toBeDefined();
    client.close();
  });
});

describe("round 2 (MEDIUM 4): the laptop side of model/countTokens is bounded and abortable", () => {
  const request = { messages: [{ role: "user" as const, content: "x" }] };

  test("a cancelled daemon request aborts the laptop provider's own signal", async () => {
    let seen: AbortSignal | undefined;
    const laptop = new Counter(() => new Promise(() => {}));
    const original = laptop.countTokens.bind(laptop);
    laptop.countTokens = (r) => {
      seen = r.signal;
      return original(r);
    };
    const [d, c] = createChannelPair();
    const daemon = new RpcPeer(d, {});
    const client = new RemoteClient(c, new PermissionBroker(), laptop);
    const ctl = new AbortController();
    const asked = daemon.request("model/countTokens", { request }, { signal: ctl.signal });
    asked.catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    expect(seen?.aborted).toBe(false);
    ctl.abort();
    await new Promise((r) => setTimeout(r, 30));
    expect(seen?.aborted).toBe(true);
    client.close();
  });

  test("a hung laptop provider answers `{}` at the 2 s cap (silent fallback to ~), not never", async () => {
    const laptop = new Counter(() => new Promise(() => {}));
    const [d, c] = createChannelPair();
    const daemon = new RpcPeer(d, {});
    const client = new RemoteClient(c, new PermissionBroker(), laptop);
    const started = Date.now();
    const got = await daemon.request("model/countTokens", { request });
    expect(got).toEqual({});
    expect(Date.now() - started).toBeLessThan(4000);
    client.close();
  });
});

describe("RemoteSession.context", () => {
  test("a local daemon: before the first send, the fresh context (no id, nothing created)", async () => {
    const model = new Counter(async () => 321);
    const host = new SessionHost({
      defaultCwd: "/tmp/ctx",
      createAgent: () => ({
        agent: new Agent({ model, tools: new ToolRegistry(), env, systemPrompt: "sys" }),
        permissions: new PermissionBroker(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    const session = client.newSession(undefined, "S");
    expect(await session.context()).toEqual({ used: 321, exact: true });
    expect(host.list({}).sessions).toHaveLength(0);
    client.close();
  });

  test("a pod daemon: the LAPTOP's provider counts, through the tunnel (exact)", async () => {
    const laptop = new Counter(async () => 9001);
    const host = new SessionHost({
      defaultCwd: "/tmp/ctx",
      createAgent: (_cwd, { modelLink }) => ({
        agent: new Agent({
          model: new ProxyModelProvider(
            () => Promise.reject(new Error("no stream")),
            undefined,
            (wire) => {
              const link = modelLink();
              if (!link?.requestModelCountTokens) {
                throw new Error("no link");
              }
              return link.requestModelCountTokens(wire);
            },
          ),
          tools: new ToolRegistry(),
          env,
          systemPrompt: "pod sys",
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host, undefined, { servesModel: true });
    const client = new RemoteClient(c, new PermissionBroker(), laptop);
    await client.initialize();
    const session = client.newSession(undefined, "P");
    expect(await session.context()).toEqual({ used: 9001, exact: true });
    // The pod's request reached the laptop's provider.
    expect(laptop.counted[0]?.messages[0]).toEqual({ role: "system", content: "pod sys" });
    client.close();
  });

  test("the laptop's provider failing: no `tokens` crosses, the daemon estimates; never an error", async () => {
    const laptop = new Counter(async () => {
      throw new Error("https://secret-endpoint.internal/v1 refused");
    });
    const host = new SessionHost({
      defaultCwd: "/tmp/ctx",
      createAgent: (_cwd, { modelLink }) => ({
        agent: new Agent({
          model: new ProxyModelProvider(
            () => Promise.reject(new Error("no stream")),
            undefined,
            (wire) => {
              const link = modelLink();
              if (!link?.requestModelCountTokens) {
                throw new Error("no link");
              }
              return link.requestModelCountTokens(wire);
            },
          ),
          tools: new ToolRegistry(),
          env,
          systemPrompt: "pod sys",
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const [d, c] = createChannelPair();
    new Connection(d, host, undefined, { servesModel: true });
    const client = new RemoteClient(c, new PermissionBroker(), laptop);
    await client.initialize();
    const got = await client.newSession(undefined, "P2").context();
    expect(got.exact).toBe(false);
    expect(got.used).toBeGreaterThan(0);
    client.close();
  });
});
