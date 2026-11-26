/**
 * Container previews through a real `Connection` and `SessionHost`
 * (docs/feat/container-apps-devices.md): device only, re-resolved per connect,
 * torn down with the session and the link, never persisted. A fake engine and a
 * real loopback server. Mutations: cache the first resolve → the re-resolve
 * tests fail; drop the device check → "token principal" fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Server, type Socket, createServer } from "node:net";
import { Agent } from "@tentacle/agent";
import {
  type ModelProvider,
  PermissionBroker,
  type PreviewFacts,
  type PreviewResolution,
  type PreviewResolver,
  type PreviewsLink,
  type StreamEvent,
} from "@tentacle/core";
import {
  DomainErrorCode,
  type KnownSessionUpdateParams,
  MAX_PREVIEWS_PER_SESSION,
  Method,
  Notification,
  PROTOCOL_VERSION,
  type PreviewRow,
  type SnapshotResult,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { until } from "../../client/test/support/fakes.ts";
import { Connection, type ConnectionPrincipal } from "../src/connection.ts";
import { type PreviewDial, dialLoopback } from "../src/preview-tunnels.ts";
import { type AgentContext, SessionHost } from "../src/session-host.ts";
import { type DaemonStore, SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";

const ID = "a".repeat(64);
const facts = (over: Partial<PreviewFacts> = {}): PreviewFacts => ({
  engine: "docker",
  endpointLabel: "unix:///fake.sock",
  id: ID,
  name: "web",
  image: "nginx",
  imageId: "sha256:1",
  containerPort: 80,
  hostPort: 1,
  hostIp: "127.0.0.1",
  ...over,
});

/** The fake engine: `current` is what the next inspect says. */
class FakeEngine implements PreviewResolver {
  current: PreviewResolution | Error = { ok: true, facts: facts() };
  readonly resolved: PreviewRow[] = [];
  /** When set, `resolve` waits for it. */
  hold: Promise<void> | undefined;
  async prepare(): Promise<PreviewResolution> {
    return this.answer();
  }
  async resolve(row: PreviewRow): Promise<PreviewResolution> {
    this.resolved.push(row);
    await this.hold;
    return this.answer();
  }
  private answer(): PreviewResolution {
    if (this.current instanceof Error) throw this.current;
    return this.current;
  }
  at(port: number): void {
    this.current = { ok: true, facts: facts({ hostPort: port }) };
  }
}

const servers: Server[] = [];
const connections: Connection[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const s of sockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

async function upstream(reply: string) {
  const state = { port: 0, accepted: 0, closed: 0, received: "" };
  const server = createServer((socket) => {
    state.accepted++;
    sockets.push(socket);
    socket.on("data", (d) => {
      state.received += d.toString();
      socket.write(reply);
    });
    socket.on("error", () => {});
    socket.on("close", () => state.closed++);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  return state;
}

const model: ModelProvider = {
  id: "model",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
};

function rig(opts: { previews?: boolean; store?: DaemonStore } = {}) {
  const engine = new FakeEngine();
  const contexts: AgentContext[] = [];
  const persister = opts.store
    ? new SessionPersister({ store: opts.store, cwd: "/tmp/p", model: "m", onError: () => {} })
    : undefined;
  const host = new SessionHost({
    defaultCwd: "/tmp/p",
    ...(persister ? { persister } : {}),
    ...(opts.previews === false ? {} : { previews: engine }),
    createAgent: (_cwd, context) => {
      contexts.push(context);
      const permissions = context.reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env: {
          id: "noop",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });

  const connect = async (
    principal: ConnectionPrincipal = { kind: "device", id: "d1" },
    previewDial?: PreviewDial,
  ) => {
    const [d, c] = createChannelPair();
    const connection = new Connection(d, host, undefined, {
      principal,
      ...(previewDial ? { previewDial } : {}),
    });
    connections.push(connection);
    const updates: KnownSessionUpdateParams[] = [];
    const data = new Map<string, string>();
    const closes: { tunnelId: string; reason?: string }[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
        if (method === Notification.PreviewData) {
          const p = params as { tunnelId: string; data: string };
          const text = Buffer.from(p.data, "base64").toString();
          data.set(p.tunnelId, (data.get(p.tunnelId) ?? "") + text);
        }
        if (method === Notification.PreviewClose) closes.push(params as (typeof closes)[number]);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    const request = <T>(method: string, params: Record<string, unknown> = {}) =>
      client.request(method, { sessionId: "S", ...params }) as Promise<T>;
    return {
      connection,
      client,
      data,
      closes,
      request,
      open: () => request("session/open", { create: true }),
      snapshot: () => request<SnapshotResult>("session/snapshot"),
      previewUpdates: () =>
        updates.flatMap((u) => (u.update.type === "previews" ? [u.update.previews] : [])),
      connectTo: (previewId: string) =>
        request<{ tunnelId: string }>(Method.PreviewConnect, { previewId }),
      send: (tunnelId: string, text: string) =>
        client.notify(Notification.PreviewData, {
          tunnelId,
          data: Buffer.from(text).toString("base64"),
        }),
    };
  };

  const link = (): PreviewsLink => {
    const made = contexts[0]?.previews?.();
    if (!made) throw new Error("no previews link");
    return made;
  };
  /** Add an approved preview, as the tool does after a yes. */
  const add = (f: PreviewFacts = facts()): PreviewRow => {
    const added = link().add(f);
    if (!added.ok) throw new Error(added.reason);
    return added.row;
  };
  return { engine, host, contexts, persister, connect, link, add };
}

const REQUEST = "GET / HTTP/1.1\r\n\r\n";

describe("who may open a tunnel", () => {
  test("a token principal → Unauthorized, nothing resolved or dialled", async () => {
    const r = rig();
    const u = await upstream("x");
    r.engine.at(u.port);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    const tui = await r.connect({ kind: "token" });
    await tui.open();
    for (const method of [Method.PreviewConnect, Method.PreviewStop]) {
      await expect(tui.request(method, { previewId: row.id })).rejects.toMatchObject({
        code: DomainErrorCode.Unauthorized,
      });
    }
    expect(r.engine.resolved).toEqual([]);
    expect(u.accepted).toBe(0);
    expect((await phone.snapshot()).previews).toHaveLength(1);
  });

  test("the session not open on this connection → UnknownSession", async () => {
    const r = rig();
    const owner = await r.connect();
    await owner.open();
    const row = r.add();
    const other = await r.connect({ kind: "device", id: "d2" });
    await expect(other.connectTo(row.id)).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
    await expect(other.request(Method.PreviewStop, { previewId: row.id })).rejects.toMatchObject({
      code: DomainErrorCode.UnknownSession,
    });
  });
});

describe("the list", () => {
  test("add: a random id, the engine's facts, an update and the snapshot", async () => {
    const r = rig();
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    expect(row.id).toMatch(/^[0-9a-f]{32}$/);
    expect(row).toMatchObject({
      containerId: ID,
      engine: "docker",
      name: "web",
      image: "nginx",
      containerPort: 80,
    });
    await until(() => phone.previewUpdates().length === 1);
    expect(phone.previewUpdates()[0]).toEqual([row]);
    expect((await phone.snapshot()).previews).toEqual([row]);
  });

  test("the 9th is refused, at prepare and at add; nothing is evicted", async () => {
    const r = rig();
    const phone = await r.connect();
    await phone.open();
    const rows = Array.from({ length: MAX_PREVIEWS_PER_SESSION }, () => r.add());
    expect(r.link().add(facts())).toMatchObject({ ok: false });
    expect(await r.link().prepare({ container: "web", port: 80, engine: "docker" })).toMatchObject({
      ok: false,
    });
    expect((await phone.snapshot()).previews).toEqual(rows);
  });

  test("a resolver that throws on prepare is a refusal, not an exception", async () => {
    const r = rig();
    await (await r.connect()).open();
    r.engine.current = new Error("ENOENT");
    const prepared = await r.link().prepare({ container: "web", port: 80, engine: "docker" });
    expect(prepared.ok ? "" : prepared.reason).toContain("ENOENT");
  });

  test("a host without previews: no link, no snapshot field, connect is PreviewGone", async () => {
    const r = rig({ previews: false });
    const phone = await r.connect();
    await phone.open();
    expect(r.contexts[0]?.previews).toBeUndefined();
    expect((await phone.snapshot()).previews).toBeUndefined();
    await expect(phone.connectTo("x")).rejects.toMatchObject({
      code: DomainErrorCode.PreviewGone,
    });
  });

  test("preview_stop removes it and closes its tunnels on every connection", async () => {
    const r = rig();
    const u = await upstream("x");
    r.engine.at(u.port);
    const a = await r.connect();
    await a.open();
    const b = await r.connect({ kind: "device", id: "d2" });
    await b.open();
    const row = r.add();
    const kept = r.add();
    const ta = await a.connectTo(row.id);
    const tb = await b.connectTo(row.id);
    const other = await b.connectTo(kept.id);
    const stopped = await a.request<{ ok: boolean }>(Method.PreviewStop, { previewId: row.id });
    expect(stopped).toEqual({ ok: true });
    await until(() => a.closes.length === 1 && b.closes.length === 1 && u.closed === 2);
    expect(a.closes[0]?.tunnelId).toBe(ta.tunnelId);
    expect(b.closes[0]?.tunnelId).toBe(tb.tunnelId);
    expect(b.closes.map((c) => c.tunnelId)).not.toContain(other.tunnelId);
    expect((await a.snapshot()).previews).toEqual([kept]);
    expect(await a.request(Method.PreviewStop, { previewId: row.id })).toMatchObject({
      ok: false,
    });
    await expect(a.connectTo(row.id)).rejects.toMatchObject({
      code: DomainErrorCode.PreviewGone,
    });
  });
});

describe("tunnels, re-resolved on every connect", () => {
  test("bytes both ways", async () => {
    const r = rig();
    const u = await upstream("HTTP/1.1 200 OK\r\n\r\n");
    r.engine.at(u.port);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    const { tunnelId } = await phone.connectTo(row.id);
    phone.send(tunnelId, REQUEST);
    await until(() => phone.data.get(tunnelId) === "HTTP/1.1 200 OK\r\n\r\n");
    expect(u.received).toBe(REQUEST);
    expect(r.engine.resolved).toEqual([row]);
    phone.client.notify(Notification.PreviewClose, { tunnelId });
    await until(() => u.closed === 1);
    expect(phone.closes).toEqual([]);
  });

  test("a changed host port is dialled; the container gone → PreviewGone and no row", async () => {
    const r = rig();
    const first = await upstream("1");
    const second = await upstream("2");
    r.engine.at(first.port);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    await phone.connectTo(row.id);
    await until(() => first.accepted === 1);
    r.engine.at(second.port);
    await phone.connectTo(row.id);
    await until(() => second.accepted === 1);
    expect(first.accepted).toBe(1);
    r.engine.current = { ok: false, reason: "the container is not running" };
    await expect(phone.connectTo(row.id)).rejects.toMatchObject({
      code: DomainErrorCode.PreviewGone,
      message: expect.stringContaining("not running"),
    });
    await until(() => phone.previewUpdates().at(-1)?.length === 0);
    // Its open tunnels go with it.
    await until(() => first.closed === 1 && second.closed === 1);
    expect(phone.closes).toHaveLength(2);
    expect(r.engine.resolved).toHaveLength(3);
  });

  test("an inspect that answers another container or port → gone, nothing dialled", async () => {
    for (const over of [{ id: "b".repeat(64) }, { containerPort: 81 }]) {
      const r = rig();
      const u = await upstream("x");
      const phone = await r.connect();
      await phone.open();
      const row = r.add();
      r.engine.current = { ok: true, facts: facts({ hostPort: u.port, ...over }) };
      await expect(phone.connectTo(row.id)).rejects.toMatchObject({
        code: DomainErrorCode.PreviewGone,
      });
      expect(u.accepted).toBe(0);
      expect((await phone.snapshot()).previews).toEqual([]);
    }
  });

  test("engine unreachable (thrown or transient) → error, the preview is kept", async () => {
    const r = rig();
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    for (const current of [
      new Error("ECONNREFUSED"),
      { ok: false, reason: "engine unreachable", transient: true },
    ] as const) {
      r.engine.current = current;
      await expect(phone.connectTo(row.id)).rejects.toMatchObject({
        code: DomainErrorCode.PreviewUnavailable,
      });
    }
    expect((await phone.snapshot()).previews).toEqual([row]);
  });

  test("a refused dial → error, the preview is kept", async () => {
    const r = rig();
    r.engine.at(1);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    await expect(phone.connectTo(row.id)).rejects.toMatchObject({
      code: DomainErrorCode.PreviewUnavailable,
    });
    expect((await phone.snapshot()).previews).toEqual([row]);
  });

  test("the 33rd tunnel is refused; the others live", async () => {
    const r = rig();
    const u = await upstream("x");
    r.engine.at(u.port);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    const all = await Promise.allSettled(Array.from({ length: 33 }, () => phone.connectTo(row.id)));
    expect(all.filter((a) => a.status === "fulfilled")).toHaveLength(32);
    expect(all[32]).toMatchObject({
      status: "rejected",
      reason: { code: DomainErrorCode.PreviewUnavailable },
    });
    expect(phone.closes).toEqual([]);
  });

  test("data for an unknown tunnel → preview/close; a token peer's is ignored", async () => {
    const r = rig();
    const phone = await r.connect();
    const tui = await r.connect({ kind: "token" });
    phone.send("nope", REQUEST);
    tui.send("nope", REQUEST);
    await until(() => phone.closes.length === 1);
    expect(phone.closes[0]?.reason).toBe("unknown-tunnel");
    expect(tui.closes).toEqual([]);
  });
});

describe("lifecycle", () => {
  const opened = async () => {
    const r = rig();
    const u = await upstream("x");
    r.engine.at(u.port);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    const { tunnelId } = await phone.connectTo(row.id);
    await until(() => u.accepted === 1);
    return { r, u, phone, row, tunnelId };
  };

  test("Connection.close() → the upstream socket closes; the preview stays", async () => {
    const { r, u, phone, row } = await opened();
    phone.connection.close();
    await until(() => u.closed === 1);
    const next = await r.connect();
    await next.request("session/open");
    expect((await next.snapshot()).previews).toEqual([row]);
  });

  test("session close → tunnels closed (reason session), list cleared, link gone", async () => {
    const { r, u, phone, tunnelId } = await opened();
    const link = r.link();
    const hosted = r.host.get("S");
    await phone.request("session/close");
    await until(() => u.closed === 1 && phone.closes.length === 1);
    expect(phone.closes[0]).toEqual({ tunnelId, reason: "session" });
    expect(hosted?.previewsLink()).toBeNull();
    expect(link.add(facts())).toMatchObject({ ok: false });
    await phone.request("session/open", { create: true });
    expect((await phone.snapshot()).previews).toEqual([]);
  });

  test("a close while the engine is being asked: no tunnel, no dial", async () => {
    const r = rig();
    const u = await upstream("x");
    r.engine.at(u.port);
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    let release = (): void => {};
    r.engine.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = phone.connectTo(row.id).then(
      () => "open",
      (error: { code: number }) => error.code,
    );
    await until(() => r.engine.resolved.length === 1);
    await phone.request(Method.PreviewStop, { previewId: row.id });
    release();
    expect(await pending).toBe(DomainErrorCode.PreviewGone);
    expect(u.accepted).toBe(0);
  });

  test("stopped during the dial → PreviewGone, the dialled socket destroyed", async () => {
    const r = rig();
    const u = await upstream("x");
    r.engine.at(u.port);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let dialled: Socket | undefined;
    const phone = await r.connect(undefined, async (port) => {
      dialled = await dialLoopback(port);
      await gate;
      return dialled;
    });
    await phone.open();
    const row = r.add();
    const pending = phone.connectTo(row.id).then(
      () => "open",
      (error: { code: number }) => error.code,
    );
    await until(() => dialled !== undefined);
    await phone.request(Method.PreviewStop, { previewId: row.id });
    release();
    expect(await pending).toBe(DomainErrorCode.PreviewGone);
    expect(dialled?.destroyed).toBe(true);
  });

  test("/clear keeps the previews", async () => {
    const { phone, row } = await opened();
    await phone.request("session/clear");
    expect((await phone.snapshot()).previews).toEqual([row]);
    expect(phone.closes).toEqual([]);
  });
});

describe("not persisted", () => {
  test("the sidecar the persister writes holds no preview", async () => {
    const store = new SpyDaemonStore();
    const r = rig({ store });
    const phone = await r.connect();
    await phone.open();
    const row = r.add();
    await phone.request("session/prompt", {
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await r.persister?.flush("S");
    expect(store.saves.length).toBeGreaterThan(0);
    // Every byte on "disk" and every record handed over.
    const disk = JSON.stringify([[...store.files], store.saves, store.stateWrites]);
    expect(disk).toContain("t1");
    expect(disk).not.toContain(row.id);
    expect(disk).not.toContain("previews");
  });
});
