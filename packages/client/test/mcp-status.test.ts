/**
 * `mcp/status` (docs/feat/mcp-status.md): the daemon's MCP servers, probed live,
 * over real daemon objects — and the client's guards against an older daemon
 * (no such method) and a hostile one (a pod: untrusted strings).
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { JsonRpcErrorCode, type McpServerStatus, PROTOCOL_VERSION } from "@tentacle/protocol";
import { type DuplexChannel, RpcError, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

function hostWith(mcpStatus?: () => Promise<readonly McpServerStatus[]>): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/mcp-status-client",
    createAgent: () => {
      throw new Error("no session in these tests");
    },
    ...(mcpStatus ? { mcpStatus } : {}),
  });
}

function connected(host: SessionHost): RemoteClient {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  return new RemoteClient(c, new PermissionBroker());
}

/**
 * A raw daemon: answers `initialize`, then replies to `mcp/status` with whatever
 * `reply` returns (a JSON-RPC `result` or `error` member) — no daemon-side schema.
 */
function rawDaemon(reply: () => Record<string, unknown>): DuplexChannel {
  const [d, c] = createChannelPair();
  d.setOnMessage((data) => {
    const frame = JSON.parse(data) as { id?: number; method?: string };
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
        : reply();
    d.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
  });
  d.setOnClose(() => {});
  return c;
}

describe("mcp/status", () => {
  test("round-trips the host's live status", async () => {
    const servers: McpServerStatus[] = [
      {
        name: "github",
        state: "connected",
        tools: ["create_issue", "list_prs"],
        moreTools: 10,
        latencyMs: 4,
      },
      { name: "db", state: "failed", tools: [], moreTools: 0, error: "spawn ENOENT" },
    ];
    let probes = 0;
    const client = connected(
      hostWith(async () => {
        probes++;
        return servers;
      }),
    );
    await client.initialize();
    expect(await client.mcpStatus()).toEqual(servers);
    expect(await client.mcpStatus()).toEqual(servers);
    expect(probes).toBe(2); // a fresh probe per request, never cached
    client.close();
  });

  test("a daemon with no MCP servers answers an empty list", async () => {
    const client = connected(hostWith());
    await client.initialize();
    expect(await client.mcpStatus()).toEqual([]);
    client.close();
  });

  test("refused before initialize", async () => {
    const client = connected(hostWith(async () => []));
    await expect(client.mcpStatus()).rejects.toThrow(/initialize/);
    client.close();
  });

  test("an older daemon (no such method) rejects with MethodNotFound", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({
        error: { code: JsonRpcErrorCode.MethodNotFound, message: "unknown method: mcp/status" },
      })),
      new PermissionBroker(),
    );
    await client.initialize();
    const error = await client.mcpStatus().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound).toBe(true);
    client.close();
  });

  test("a hostile daemon's terminal escape in a name is rejected, never returned", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({
        result: {
          servers: [{ name: "evil\u001b[2J", state: "connected", tools: [], moreTools: 0 }],
        },
      })),
      new PermissionBroker(),
    );
    await client.initialize();
    await expect(client.mcpStatus()).rejects.toThrow();
    client.close();
  });

  test("a hostile daemon's control character in an error is rejected (review F5)", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({
        result: {
          servers: [
            {
              name: "x",
              state: "failed",
              tools: [],
              moreTools: 0,
              error: "a\u001b]8;;http://e\u0007",
            },
          ],
        },
      })),
      new PermissionBroker(),
    );
    await client.initialize();
    await expect(client.mcpStatus()).rejects.toThrow();
    client.close();
  });

  test("the same shapes minus the hostile part are accepted (the rejections above are not vacuous)", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({
        result: {
          servers: [
            { name: "evil", state: "connected", tools: ["ok"], moreTools: 0 },
            { name: "x", state: "failed", tools: [], moreTools: 0, error: "a" },
          ],
        },
      })),
      new PermissionBroker(),
    );
    await client.initialize();
    expect((await client.mcpStatus()).map((s) => s.name)).toEqual(["evil", "x"]);
    client.close();
  });

  test("a hostile daemon's terminal escape in a tool name is rejected (docs/feat/mcp-tools-panel.md)", async () => {
    const client = new RemoteClient(
      rawDaemon(() => ({
        result: {
          servers: [
            {
              name: "x",
              state: "connected",
              tools: ["ok", "pwn\u001b]52;c;AAAA\u0007"],
              moreTools: 0,
            },
          ],
        },
      })),
      new PermissionBroker(),
    );
    await client.initialize();
    await expect(client.mcpStatus()).rejects.toThrow();
    client.close();
  });

  test("a hostile daemon's oversized tool list is rejected", async () => {
    const tools = Array.from({ length: 129 }, (_, i) => `t${i}`);
    const client = new RemoteClient(
      rawDaemon(() => ({
        result: { servers: [{ name: "x", state: "connected", tools, moreTools: 0 }] },
      })),
      new PermissionBroker(),
    );
    await client.initialize();
    await expect(client.mcpStatus()).rejects.toThrow();
    client.close();
  });

  test("link down (reconnecting): rejects at once, nothing sent (review F4)", async () => {
    const [d, c] = createChannelPair();
    new Connection(
      d,
      hostWith(async () => []),
    );
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
      channelFactory: () => new Promise<DuplexChannel>(() => {}), // the redial never lands
    });
    await client.initialize();
    d.close(); // the daemon side drops the link
    await Bun.sleep(5);
    const before = sent.length;
    await expect(client.mcpStatus()).rejects.toThrow("not connected");
    expect(sent.length).toBe(before);
    client.close();
  });

  test("a hostile daemon's oversized list is rejected", async () => {
    const many = Array.from({ length: 257 }, (_, i) => ({
      name: `s${i}`,
      state: "closed",
      tools: [],
      moreTools: 0,
    }));
    const client = new RemoteClient(
      rawDaemon(() => ({ result: { servers: many } })),
      new PermissionBroker(),
    );
    await client.initialize();
    await expect(client.mcpStatus()).rejects.toThrow();
    client.close();
  });
});
