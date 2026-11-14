/**
 * docs/feat/logs-cmd.md sub-task 2 (`logs-watch`) — the three `session/watch*`
 * methods on a real `Connection`/`SessionHost`, over an in-memory channel pair.
 *
 * The property that matters most here is AGENTS §7's "don't serialize the RPC
 * peer": a HELD `watch_next` must not delay a concurrent short request (a
 * `session/resolve_permission`), and a watch must be releasable without any
 * session change. Each test names the mutation that turns it red (AGENTS §9).
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
import { DomainErrorCode, JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import type { WatchNextResult, WatchResult } from "@tentacle/protocol";
import { ToolRegistry, shellTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** A model that asks for one shell command, then ends the turn once it is answered. */
class Asking implements ModelProvider {
  readonly id = "asking";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield {
      type: "tool_call",
      toolCall: { id: "c1", name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
    };
    yield { type: "done" };
  }
}

class Quiet implements ModelProvider {
  readonly id = "quiet";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "done" };
  }
}

function daemon(model: ModelProvider = new Quiet()) {
  const host = new SessionHost({
    defaultCwd: "/tmp/watch-connection",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry().register(shellTool),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const [d, c] = createChannelPair();
  const connection = new Connection(d, host);
  const updates: string[] = [];
  const client = new RpcPeer(c, {
    onNotification: (method) => {
      updates.push(method);
    },
    onRequest: async (method) => {
      throw new Error(`unexpected request ${method}`);
    },
  });
  const ready = client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  const watch = async (sessionId: string, only?: readonly string[]) =>
    (await client.request("session/watch", {
      sessionId,
      ...(only !== undefined ? { only } : {}),
    })) as WatchResult;
  return { host, connection, client, ready, updates, watch };
}

async function flush(rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

describe("session/watch on a connection", () => {
  test("a watch needs no `open`, attaches nothing and counts in no `attached`", async () => {
    // Mutation: implement `watch` as `session/open` + a plain attachment →
    // `attached` becomes 1 and this fails (the bug the precondition forbids).
    const d = daemon();
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    expect(d.host.get("S")?.attachedCount).toBe(1);
    // A SECOND connection watches without opening anything.
    const [d2, c2] = createChannelPair();
    new Connection(d2, d.host);
    const watcher = new RpcPeer(c2, { onNotification: () => {}, onRequest: async () => ({}) });
    await watcher.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const result = (await watcher.request("session/watch", { sessionId: "S" })) as WatchResult;
    expect(result.watchId).not.toBe("");
    expect(result.state).toEqual({ running: false, pending: [] });
    expect(d.host.get("S")?.attachedCount).toBe(1); // unchanged
    const list = (await watcher.request("session/list", {})) as {
      sessions: { sessionId: string; attached: number }[];
    };
    expect(list.sessions.find((s) => s.sessionId === "S")?.attached).toBe(1);
  });

  test("a watch on an unknown or archived session is UnknownSession (never a revive)", async () => {
    // Mutation: fall back to `host.open` → an archived session comes back to
    // life (and the follower holds a model link's session busy).
    const d = daemon();
    await d.ready;
    let code: number | undefined;
    try {
      await d.client.request("session/watch", { sessionId: "nope" });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.UnknownSession);
  });

  test("`session/log` is readable for a WATCHED session, refused for an unopened one", async () => {
    // Mutation: make `session/log` use `lookup` only → `logs --tail --connect`
    // needs an `open` (which attaches: the watcher becomes a client).
    const d = daemon();
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    const [d2, c2] = createChannelPair();
    new Connection(d2, d.host);
    const watcher = new RpcPeer(c2, { onNotification: () => {}, onRequest: async () => ({}) });
    await watcher.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    // Not opened and not watched yet: refused.
    let code: number | undefined;
    try {
      await watcher.request("session/log", { sessionId: "S" });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.UnknownSession);
    // Watched: readable, and still no `open` happened on this connection.
    await watcher.request("session/watch", { sessionId: "S" });
    const page = (await watcher.request("session/log", { sessionId: "S" })) as {
      entries: unknown[];
    };
    expect(Array.isArray(page.entries)).toBe(true);
    expect(d.host.get("S")?.attachedCount).toBe(1);
  });

  test("a HELD watch_next does not delay a concurrent session/resolve_permission (AGENTS §7)", async () => {
    // Mutation: `await` the hold inside the connection's dispatch (or take a
    // per-connection lock) → the resolve queues behind the 5 s hold and the
    // turn can never be answered.
    const d = daemon(new Asking());
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    const { watchId } = await d.watch("S");
    // Start the turn: it suspends on its ask.
    await d.client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await flush();
    // Hold a poll for 5 s, then answer the ask from the SAME connection.
    const held = d.client.request("session/watch_next", { watchId, timeoutMs: 5000 });
    const started = Date.now();
    // The ask arrives in the held batch (flush-now wakes it at once).
    const batch = (await held) as WatchNextResult;
    const ask = batch.updates.find((u) => u.update.type === "permission_request");
    expect(ask).toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
    const requestId = (ask?.update as { requestId: string }).requestId;
    // A short request while a poll could have been held: answered at once.
    const resolved = await d.client.request("session/resolve_permission", {
      sessionId: "S",
      requestId,
      optionId: "allow_once",
    });
    expect(resolved).toEqual({});
  });

  test("two concurrent watch_next on one watch: the second is InvalidParams", async () => {
    // Mutation: drop the guard → the batch splits between two polls.
    const d = daemon();
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    const { watchId } = await d.watch("S");
    const held = d.client.request("session/watch_next", { watchId, timeoutMs: 300 });
    let code: number | undefined;
    try {
      await d.client.request("session/watch_next", { watchId, timeoutMs: 300 });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(JsonRpcErrorCode.InvalidParams);
    const empty = (await held) as WatchNextResult;
    expect(empty.updates).toEqual([]);
  });

  test("a connection going away releases its watches and changes nothing on the session", async () => {
    // Mutation: leave the watch in the session's set → a closed `logs -f`
    // leaks a queue (and a timer) per invocation, forever.
    const d = daemon();
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    const hosted = d.host.get("S");
    const [d2, c2] = createChannelPair();
    const connection = new Connection(d2, d.host);
    const watcher = new RpcPeer(c2, { onNotification: () => {}, onRequest: async () => ({}) });
    await watcher.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    await watcher.request("session/watch", { sessionId: "S" });
    expect(connection.watchedSessionIds).toEqual(["S"]);
    connection.close();
    expect(connection.watchedSessionIds).toEqual([]);
    // The session itself is untouched: still attached by its own client.
    expect(hosted?.attachedCount).toBe(1);
    expect(d.host.get("S")).toBe(hosted as never);
  });

  test("watch_next for a watch this connection does not hold is UnknownWatch", async () => {
    // Mutation: resolve any `watchId` from the host → one connection drives
    // another's follower (two clients on one queue).
    const d = daemon();
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    let code: number | undefined;
    try {
      await d.client.request("session/watch_next", { watchId: "not-mine" });
    } catch (error) {
      code = (error as { code?: number }).code;
    }
    expect(code).toBe(DomainErrorCode.UnknownWatch);
    // The same answer for an id ANOTHER connection holds: a watch is that
    // connection's, never the daemon's.
    const { watchId } = await d.watch("S");
    const [d2, c2] = createChannelPair();
    new Connection(d2, d.host);
    const other = new RpcPeer(c2, { onNotification: () => {}, onRequest: async () => ({}) });
    await other.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    let otherCode: number | undefined;
    try {
      await other.request("session/watch_next", { watchId });
    } catch (error) {
      otherCode = (error as { code?: number }).code;
    }
    expect(otherCode).toBe(DomainErrorCode.UnknownWatch);
  });

  test("the client's poll loop surfaces `lost` and `ended`, and unwatch is idempotent", async () => {
    // Mutation: omit `lost`/`ended` from the result mapping → a follower never
    // learns that updates were dropped, nor why its stream stopped.
    const d = daemon();
    await d.ready;
    await d.client.request("session/open", { sessionId: "S", create: true });
    const { watchId } = await d.watch("S");
    d.host.get("S")?.close();
    const batch = (await d.client.request("session/watch_next", { watchId })) as WatchNextResult;
    expect(batch.ended).toBe("closed");
    expect(batch.lost).toBe(0);
    // Idempotent: twice, and an unknown id, all succeed.
    await d.client.request("session/unwatch", { watchId });
    await d.client.request("session/unwatch", { watchId });
    await d.client.request("session/unwatch", { watchId: "nope" });
  });
});
