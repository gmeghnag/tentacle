/**
 * `session/list` (docs/feat/session-list.md) over real daemon objects — and the
 * client's guards against an older daemon (no such method), a hostile one (a
 * pod: untrusted strings, too many entries) and a dropped link.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { type ExecutionEnvironment, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, MAX_SESSION_LIST, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const CWD = "/tmp/session-list-client";

function host(): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    now: () => 42,
    createAgent: () => ({
      agent: new Agent({
        model: {
          id: "unused",
          stream: () => ({
            [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error("unused")) }),
          }),
        },
        tools: new ToolRegistry(),
        env: {} as ExecutionEnvironment,
      }),
      permissions: new PermissionBroker(),
    }),
  });
}

function connected(daemon: SessionHost): RemoteClient {
  const [d, c] = createChannelPair();
  new Connection(d, daemon);
  return new RemoteClient(c, new PermissionBroker());
}

/** A raw daemon: answers `initialize`, then `reply(params)` to anything else. */
function rawDaemon(reply: (params: unknown) => Record<string, unknown>): DuplexChannel {
  const [d, c] = createChannelPair();
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string; params?: unknown };
    if (frame.id === undefined) {
      return;
    }
    const body =
      frame.method === "initialize"
        ? {
            result: {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
              skills: [],
            },
          }
        : reply(frame.params);
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

const entry = {
  sessionId: "s1",
  title: "fix the build",
  cwd: "/w",
  createdAt: 1,
  updatedAt: 2,
  running: false,
  attached: 0,
  archived: false,
};

describe("session/list", () => {
  test("C1 round-trips the host's list (a control character in a title is sanitised by the host)", async () => {
    // Mutation M1 (no sanitising on the daemon) → the client rejects the whole list.
    const daemon = host();
    daemon.open(
      { sessionId: "a", messages: [{ role: "user", content: "pwn\u001b]52;c;AAAA\u0007" }] },
      { send: () => {} },
    );
    daemon.open({ sessionId: "b", create: true }, { send: () => {} });
    const client = connected(daemon);
    await client.initialize();
    const listed = await client.sessionList();
    expect(listed).toEqual(daemon.list({}));
    expect(listed.sessions.map((s) => [s.sessionId, s.title])).toEqual([
      ["a", "pwn ]52;c;AAAA"],
      ["b", "(empty)"],
    ]);
    // The lister is not an attachment.
    expect(listed.sessions.map((s) => s.attached)).toEqual([1, 1]);
    client.close();
  });

  test("C2 an older daemon (no such method) rejects with MethodNotFound", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({ error: { code: JsonRpcErrorCode.MethodNotFound, message: "nope" } })),
      new PermissionBroker(),
    );
    await client.initialize();
    const error = await client.sessionList().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound).toBe(true);
    client.close();
  });

  test("C3 a hostile daemon (an escape in a title, too many entries) is rejected whole", async () => {
    const listing = (sessions: unknown[]) => () => ({ result: { sessions } });
    for (const reply of [
      listing([{ ...entry, title: "pwn\u001b]52;c;AAAA\u0007" }]),
      listing(
        Array.from({ length: MAX_SESSION_LIST + 1 }, (_, i) => ({ ...entry, sessionId: `s${i}` })),
      ),
    ]) {
      const bad = new RemoteClient(rawDaemon(reply), new PermissionBroker());
      await bad.initialize();
      const error = await bad.sessionList().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error instanceof RpcError && error.code).toBe(JsonRpcErrorCode.InternalError);
      expect(error instanceof Error && error.message).toContain("invalid result");
      bad.close();
    }
    const good = new RemoteClient(rawDaemon(listing([entry])), new PermissionBroker());
    await good.initialize();
    expect((await good.sessionList()).sessions).toEqual([entry]);
    good.close();
  });

  test("C4 link down (reconnecting): rejects at once, nothing sent", async () => {
    const [d, c] = createChannelPair();
    new Connection(d, host());
    const sent: string[] = [];
    const tapped: DuplexChannel = {
      send: (data) => {
        sent.push(data);
        c.send(data);
      },
      close: () => c.close(),
      setOnMessage: (h) => c.setOnMessage(h),
      setOnClose: (h) => c.setOnClose(h),
    };
    const client = new RemoteClient(tapped, new PermissionBroker(), undefined, {
      channelFactory: () => new Promise<DuplexChannel>(() => {}),
    });
    await client.initialize();
    d.close();
    await Bun.sleep(5);
    const before = sent.length;
    await expect(client.sessionList()).rejects.toThrow("not connected to the daemon");
    expect(sent.length).toBe(before);
    client.close();
  });

  test("C5 limit and cursor are forwarded verbatim; absent → {}", async () => {
    const seen: unknown[] = [];
    const client = new RemoteClient(
      rawDaemon((params) => {
        seen.push(params);
        return { result: { sessions: [entry], cursor: "2:s1" } };
      }),
      new PermissionBroker(),
    );
    await client.initialize();
    expect(await client.sessionList({ limit: 1, cursor: "9:s0" })).toEqual({
      sessions: [entry],
      cursor: "2:s1",
    });
    await client.sessionList();
    expect(seen).toEqual([{ limit: 1, cursor: "9:s0" }, {}]);
    client.close();
  });
});
