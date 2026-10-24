/**
 * Session titles on the client (docs/feat/session-titles.md): the daemon's
 * `session_title` reaches a title listener while idle, the read-back carries
 * the daemon's title, a rename goes through, a seed rides the first open and
 * a recreate — and an older daemon (no title, no method) is handled honestly.
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
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import type { SessionEvent } from "../src/mapping.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { until } from "./support/fakes.ts";

const CWD = "/tmp/session-titles-client";

/** Replies with `text`, after a timer (like network I/O). */
const replying = (text: string): ModelProvider => ({
  id: text,
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    await new Promise((r) => setTimeout(r, 1));
    yield { type: "text", delta: text };
    yield { type: "done" };
  },
});

function host(titleModel?: ModelProvider): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    createAgent: () => ({
      agent: new Agent({
        model: replying("the reply"),
        tools: new ToolRegistry(),
        env: {} as ExecutionEnvironment,
      }),
      permissions: new PermissionBroker(),
      ...(titleModel ? { titleModel } : {}),
    }),
  } as ConstructorParameters<typeof SessionHost>[0]);
}

function connected(daemon: SessionHost): RemoteClient {
  const [d, c] = createChannelPair();
  new Connection(d, daemon);
  return new RemoteClient(c, new PermissionBroker());
}

/** A raw daemon: answers `initialize`, then `reply(method, params)`; records every request. */
function rawDaemon(
  reply: (method: string, params: Record<string, unknown>) => Record<string, unknown>,
  seen: { method: string; params: Record<string, unknown> }[] = [],
): DuplexChannel {
  const [d, c] = createChannelPair();
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (frame.id === undefined || frame.method === undefined) {
      return;
    }
    seen.push({ method: frame.method, params: frame.params ?? {} });
    const body =
      frame.method === "initialize"
        ? {
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
              skills: [],
            },
          }
        : reply(frame.method, frame.params ?? {});
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

async function drain(iter: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of iter) out.push(e);
  return out;
}

// Namespace-style access: on a tree without titles each case fails on its assertion.
type Loose = Record<string, ((...args: unknown[]) => unknown) | undefined>;
const method = (target: object, name: string) => {
  const fn = (target as unknown as Loose)[name];
  expect(typeof fn).toBe("function");
  return (...args: unknown[]) => (fn as (...a: unknown[]) => unknown).apply(target, args);
};

describe("client titles", () => {
  test("C1 a generated title reaches the title listener while idle; the read-back carries it", async () => {
    const client = connected(host(replying("Fix the login bug")));
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const titles: unknown[] = [];
    method(session, "onTitle")((t: unknown) => titles.push(t));
    const events = await drain(session.send("please fix the login"));
    // Never a turn event of its own (and never "unsupported").
    expect(
      events.some((e) => (e.type as string) === "session_title" || e.type === "unsupported"),
    ).toBe(false);
    await until(() => titles.length > 0, 500).catch(() => {});
    expect(titles).toEqual([{ sessionId: "S", title: "Fix the login bug", source: "model" }]);
    const back = (await method(session, "readBack")()) as { messages: unknown[]; title?: unknown };
    expect(back.title).toEqual({ text: "Fix the login bug", source: "model" });
    expect(back.messages).toHaveLength(2);
    client.close();
  });

  test("C1 rename: the daemon's stored text; before the first send there is nothing to rename", async () => {
    const client = connected(host());
    await client.initialize();
    const session = client.newSession(undefined, "S");
    const rename = method(session, "rename");
    await expect(rename("x") as Promise<unknown>).rejects.toThrow(/nothing to rename yet/);
    const titles: unknown[] = [];
    method(session, "onTitle")((t: unknown) => titles.push(t));
    await drain(session.send("hello"));
    expect(await rename("  My\t title ")).toBe("My title");
    await until(() => titles.length > 0, 500).catch(() => {});
    expect(titles).toEqual([{ sessionId: "S", title: "My title", source: "user" }]);
    const back = (await method(session, "readBack")()) as { title?: unknown };
    expect(back.title).toEqual({ text: "My title", source: "user" });
    client.close();
  });

  test("C1 an older daemon: no title in the snapshot → none (never derived); no rename method → 'too old'", async () => {
    const seen: { method: string; params: Record<string, unknown> }[] = [];
    const channel = rawDaemon((m) => {
      if (m === "session/rename") {
        return { error: { code: JsonRpcErrorCode.MethodNotFound, message: "Method not found" } };
      }
      if (m === "session/snapshot") {
        return {
          result: { messages: [{ role: "user", content: "q" }], since: { epoch: "e", seq: 0 } },
        };
      }
      return { result: {} };
    }, seen);
    const client = new RemoteClient(channel, new PermissionBroker());
    await client.initialize();
    const back = (await method(client, "readBack")("S")) as {
      messages: unknown[];
      title?: unknown;
    };
    expect(back.messages).toEqual([{ role: "user", content: "q" }]);
    expect("title" in back).toBe(false);
    const error = await (method(client, "rename")("S", "x") as Promise<unknown>).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).toBe(
      "this daemon is too old to rename sessions — update tentacle",
    );
    expect(error instanceof RpcError && error.code).toBe(JsonRpcErrorCode.MethodNotFound);
    client.close();
  });

  test("C1 a seed title rides the first open (a resumed session on a daemon that lost it)", async () => {
    const seen: { method: string; params: Record<string, unknown> }[] = [];
    const channel = rawDaemon((m, p) => {
      if (m === "session/open") {
        return { result: { sessionId: p.sessionId, epoch: "e", created: true, resync: false } };
      }
      if (m === "session/prompt") {
        return { result: { turnId: p.turnId, ended: { stopReason: "end_turn" } } };
      }
      return { result: {} };
    }, seen);
    const client = new RemoteClient(channel, new PermissionBroker());
    await client.initialize();
    const newSession = method(client, "newSession");
    const session = newSession([{ role: "user", content: "old" }], "S", {
      text: "Kept name",
      source: "user",
    }) as ReturnType<RemoteClient["newSession"]>;
    await drain(session.send("again")).catch(() => {});
    const open = seen.find((f) => f.method === "session/open");
    expect(open?.params.title).toEqual({ text: "Kept name", source: "user" });
    client.close();
  });

  // Review round 1, finding 3 (mutation I: the never-live `recover` sends no
  // seed): a pod drops during the FIRST open of a resumed, renamed session.
  test("C1 the link drops before the first open is answered: the never-live recover carries the seed title", async () => {
    let calls = 0;
    const counting: ModelProvider = {
      id: "count",
      async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text", delta: "Generated over the rename" };
        yield { type: "done" };
      },
    };
    // The first daemon answers `initialize`, then drops the link on `session/open`.
    const [d1, c1] = createChannelPair();
    d1.setOnMessage((data) => {
      const frame = JSON.parse(data) as { id?: number; method?: string };
      if (frame.method === "initialize") {
        d1.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: frame.id,
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
              skills: [],
            },
          }),
        );
      } else if (frame.method === "session/open") {
        d1.close();
      }
    });
    d1.setOnClose(() => {});
    // The next one never heard of S, and has a title model that would answer.
    const daemon = host(counting);
    const opens: unknown[] = [];
    const client = new RemoteClient(c1, new PermissionBroker(), undefined, {
      channelFactory: async () => {
        const [d, c] = createChannelPair();
        new Connection(d, daemon);
        const send = c.send.bind(c);
        c.send = (data: string) => {
          const frame = JSON.parse(data) as { method?: string; params?: unknown };
          if (frame.method === "session/open") opens.push(frame.params);
          send(data);
        };
        return c;
      },
      random: () => 0,
    });
    await client.initialize();
    const newSession = method(client, "newSession");
    const session = newSession([{ role: "user", content: "old" }], "S", {
      text: "Kept name",
      source: "user",
    }) as ReturnType<RemoteClient["newSession"]>;
    await drain(session.send("again")).catch(() => {});
    await until(() => daemon.get("S") !== undefined);
    expect(opens[0]).toMatchObject({ sessionId: "S", create: true, title: { text: "Kept name" } });
    expect(daemon.get("S")?.summary(CWD).title).toBe("Kept name");
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(0);
    client.close();
  });

  test("C1 a daemon that lost the session (a pod's new exec) is recreated WITH the chosen title: never regenerated", async () => {
    let calls = 0;
    const counting: ModelProvider = {
      id: "count",
      async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
        calls++;
        yield { type: "text", delta: "Generated over the rename" };
        yield { type: "done" };
      },
    };
    let daemon = host();
    let last: DuplexChannel | null = null;
    const dial = (): DuplexChannel => {
      const [d, c] = createChannelPair();
      new Connection(d, daemon);
      last = c;
      return c;
    };
    const client = new RemoteClient(dial(), new PermissionBroker(), undefined, {
      channelFactory: async () => dial(),
      random: () => 0,
    });
    await client.initialize();
    const session = client.newSession(undefined, "S");
    await drain(session.send("first"));
    expect(await method(session, "rename")("Mine")).toBe("Mine");
    await until(() => true);
    // A new daemon that never heard of S, with a title model that would answer.
    daemon = host(counting);
    (last as DuplexChannel | null)?.close();
    // The client re-attaches, gets UnknownSession, recreates S from its copy.
    await until(() => daemon.get("S") !== undefined);
    expect(daemon.get("S")?.summary(CWD).title).toBe("Mine");
    await drain(session.send("second"));
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(0);
    expect(daemon.get("S")?.summary(CWD).title).toBe("Mine");
    client.close();
  });
});
