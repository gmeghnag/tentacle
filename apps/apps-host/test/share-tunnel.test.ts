/**
 * docs/feat/session-apps-container-ports.md S3: the serve's REAL tunnel
 * (`SessionPreviews` + `createShareStarter`) against a REAL apps host and a real
 * loopback service. Mutations: cache the dial target → the re-resolve test
 * fails; drop `keepalive: false` → the connection count fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PreviewFacts,
  PreviewResolution,
  PreviewResolver,
} from "../../../packages/core/src/previews.ts";
import { SessionPreviews } from "../../../packages/daemon/src/session-previews.ts";
import {
  createShareStarter,
  loopbackAppsUrl,
  shareStarterOf,
} from "../../../packages/daemon/src/share-tunnel.ts";
import {
  APPS_TUNNEL_CHUNK_BYTES,
  APPS_TUNNEL_WINDOW_BYTES,
  type TunnelFrame,
  encodeTunnelFrame,
} from "../../../packages/protocol/src/apps-tunnel.ts";
import { type AppsHostOptions, startAppsHost } from "../src/server.ts";
import { createFsStore } from "../src/store.ts";
import { DOMAIN, startHost, stopAll } from "./support/host.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
  await stopAll();
});

async function until(condition: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`never held: ${what}`);
    await Bun.sleep(2);
  }
}

interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  port: number;
}

/** The container's service: a page, an echo, a redirect, a WebSocket echo. */
function upstream(name = "page") {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req, srv) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(req.headers),
        port: srv.requestIP(req)?.port ?? 0,
      });
      if (req.headers.get("upgrade") === "websocket") {
        const protocol = req.headers.get("sec-websocket-protocol");
        const ok = srv.upgrade(req, {
          data: undefined,
          ...(protocol ? { headers: { "Sec-WebSocket-Protocol": protocol } } : {}),
        });
        return ok ? undefined : new Response("no", { status: 400 });
      }
      if (url.pathname === "/redirect") {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        });
      }
      if (req.method === "POST") {
        return new Response(`got ${(await req.arrayBuffer()).byteLength}`);
      }
      if (url.pathname === "/big") {
        return new Response("b".repeat(APPS_TUNNEL_WINDOW_BYTES * 5));
      }
      const headers = new Headers({ "content-type": "text/plain" });
      headers.append("set-cookie", "mine=1; Path=/");
      headers.append("set-cookie", "toss=1; Domain=.example.so");
      return new Response(`${name} ${url.pathname}`, { headers });
    },
    websocket: {
      message(ws, message) {
        if (message === "bye") ws.close(4001, "done");
        else ws.send(typeof message === "string" ? `echo:${message}` : new Uint8Array(message));
      },
    },
  });
  cleanups.push(() => server.stop(true));
  return { port: server.port ?? 0, seen, server };
}

const facts = (hostPort: number): PreviewFacts => ({
  engine: "docker",
  endpointLabel: "unix:///x.sock",
  id: "e".repeat(64),
  name: "web",
  image: "nginx",
  imageId: "sha256:1",
  containerPort: 80,
  hostPort,
  hostIp: "127.0.0.1",
});

function engine(hostPort: number) {
  const state: { answer: PreviewResolution } = { answer: { ok: true, facts: facts(hostPort) } };
  const resolver: PreviewResolver = {
    prepare: async () => state.answer,
    resolve: async () => state.answer,
  };
  const at = (port: number): void => {
    state.answer = { ok: true, facts: facts(port) };
  };
  return { resolver, state, at };
}

async function session(hostUrl: string, port: number) {
  const configDir = mkdtempSync(join(tmpdir(), "share-tunnel-"));
  cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));
  const logs: string[] = [];
  const starter = createShareStarter({
    configDir,
    domain: DOMAIN,
    baseUrl: hostUrl,
    log: (line) => logs.push(line),
  });
  const e = engine(port);
  const previews = new SessionPreviews(e.resolver, () => {}, Date.now, starter);
  cleanups.push(() => previews.close());
  const share = async (open = false) => {
    const added = await previews.share?.add(facts(port), { public: open });
    if (!added?.ok) throw new Error(added?.reason ?? "no sharing");
    const { id, link } = added.row;
    const app = new URL(link?.url ?? "").host.split(".")[0] ?? "";
    await until(() => previews.list().find((r) => r.id === id)?.link?.state === "up", "up");
    const secret = new URL(previews.linkOf(id) ?? "").pathname;
    return { id, app, capPath: secret };
  };
  return { previews, engine: e, share, logs, starter };
}

const SAME = { "sec-fetch-site": "same-origin" };

async function rig(open = false) {
  const host = await startHost();
  const service = upstream();
  const s = await session(host.server.url, service.port);
  const shared = await s.share(open);
  const visit = (path: string, headers: Record<string, string> = {}, init: RequestInit = {}) =>
    fetch(`${host.server.url}${path}`, {
      ...init,
      redirect: "manual",
      headers: { host: `${shared.app}.${DOMAIN}`, ...SAME, ...headers },
    });
  const cookie = async (): Promise<string> => {
    const response = await visit(shared.capPath);
    return response.headers.get("set-cookie")?.split(";")[0] ?? "";
  };
  return { host, service, ...s, shared, visit, cookie };
}

describe("a secret share, end to end", () => {
  test("no cookie: refused on the serve, nothing dialled", async () => {
    const t = await rig();
    const response = await t.visit("/");
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("needs its secret");
    expect(t.service.seen).toEqual([]);
  });

  test("the cap link sets a host-only cookie, then the page arrives", async () => {
    const t = await rig();
    const exchange = await t.visit(t.shared.capPath);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/");
    const set = exchange.headers.get("set-cookie") ?? "";
    expect(set).toMatch(/^__Host-tentacle-cap=[A-Za-z0-9_-]{22}; Path=\/; Secure; HttpOnly/);
    const cookie = set.split(";")[0] ?? "";
    const page = await t.visit("/a?b=1", {
      cookie: `${cookie}; own=2`,
      origin: `https://${t.shared.app}.${DOMAIN}`,
      "x-forwarded-for": "1.2.3.4",
    });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("page /a");
    expect(page.headers.getSetCookie()).toEqual(["mine=1; Path=/"]);
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const got = t.service.seen[0];
    expect(got?.path).toBe("/a?b=1");
    expect(got?.headers.cookie).toBe("own=2");
    expect(got?.headers.host).toBe(`localhost:${t.service.port}`);
    expect(got?.headers.origin).toBe(`http://localhost:${t.service.port}`);
    expect(got?.headers["x-forwarded-proto"]).toBe("https");
    expect(got?.headers["x-forwarded-host"]).toBe(`${t.shared.app}.${DOMAIN}`);
    expect(got?.headers["x-forwarded-for"]).toBeUndefined();
    expect(JSON.stringify(t.service.seen)).not.toContain(cookie.split("=")[1] ?? "?");
    expect(t.logs.join("\n")).not.toContain(cookie.split("=")[1] ?? "?");
  });

  test("a wrong secret is a 404", async () => {
    const t = await rig();
    expect((await t.visit("/__tentacle/cap/nope")).status).toBe(404);
    expect(t.service.seen).toEqual([]);
  });

  test("`//other/`, `/\\other` and TRACE are refused and never reach the service", async () => {
    const t = await rig(true);
    for (const line of ["GET //evil.example/x", "GET /\\evil.example/x", "TRACE /"]) {
      // Raw: an HTTP client would tidy the target up before sending it.
      const status = await new Promise<string>((resolve) => {
        let text = "";
        void Bun.connect({
          hostname: "127.0.0.1",
          port: t.host.server.port,
          socket: {
            open(socket) {
              socket.write(
                `${line} HTTP/1.1\r\nHost: ${t.shared.app}.${DOMAIN}\r\nSec-Fetch-Site: same-origin\r\nConnection: close\r\n\r\n`,
              );
            },
            data(_socket, data) {
              text += data.toString();
              if (text.includes("\r\n")) resolve(text.split("\r\n")[0] ?? "");
            },
          },
        });
      });
      expect([line, status]).toEqual([line, "HTTP/1.1 400 Bad Request"]);
    }
    expect(t.service.seen).toEqual([]);
  });

  test("a redirect is passed on, never followed", async () => {
    const t = await rig(true);
    const response = await t.visit("/redirect");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://169.254.169.254/latest");
  });

  test("an upload and a download larger than the window arrive whole", async () => {
    const t = await rig(true);
    const size = APPS_TUNNEL_WINDOW_BYTES * 4 + 7;
    const up = await t.visit("/up", {}, { method: "POST", body: "u".repeat(size) });
    expect(await up.text()).toBe(`got ${size}`);
    const down = await t.visit("/big");
    expect((await down.text()).length).toBe(APPS_TUNNEL_WINDOW_BYTES * 5);
  });

  test("a WebSocket echo, text and binary, with the subprotocol and the cookie", async () => {
    const t = await rig();
    const cookie = await t.cookie();
    const got: unknown[] = [];
    let closed: { code: number; reason: string } | undefined;
    const socket = new WebSocket(`ws://127.0.0.1:${t.host.server.port}/hmr`, {
      headers: { host: `${t.shared.app}.${DOMAIN}`, ...SAME, cookie },
      protocols: ["vite-hmr"],
    } as unknown as string[]);
    cleanups.push(() => socket.close());
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => got.push(event.data);
    socket.onclose = (event) => {
      closed = { code: event.code, reason: event.reason };
    };
    await until(() => socket.readyState === WebSocket.OPEN, "open");
    expect(socket.protocol).toBe("vite-hmr");
    socket.send("hi");
    socket.send(new Uint8Array([1, 2, 9]));
    await until(() => got.length === 2, "echo");
    expect(got[0]).toBe("echo:hi");
    expect([...new Uint8Array(got[1] as ArrayBuffer)]).toEqual([1, 2, 9]);
    // A message larger than the window still crosses.
    socket.send("m".repeat(APPS_TUNNEL_WINDOW_BYTES + 1));
    socket.send("after");
    await until(() => got.length === 4, "big echo");
    expect(got[3]).toBe("echo:after");
    expect(t.service.seen.at(-1)?.headers.cookie).toBeUndefined();
    socket.send("bye");
    await until(() => closed !== undefined, "close");
    expect(closed).toEqual({ code: 4001, reason: "done" });
  });

  test("a WebSocket without the cookie never reaches the service", async () => {
    const t = await rig();
    let refused = false;
    const socket = new WebSocket(`ws://127.0.0.1:${t.host.server.port}/hmr`, {
      headers: { host: `${t.shared.app}.${DOMAIN}`, ...SAME },
    } as unknown as string[]);
    socket.onclose = () => {
      refused = true;
    };
    await until(() => refused, "refused");
    expect(t.service.seen).toEqual([]);
  });
});

describe("the container is re-checked for every request", () => {
  test("a new port is dialled at once, each request on its own connection", async () => {
    const t = await rig(true);
    expect(await (await t.visit("/1")).text()).toBe("page /1");
    expect(await (await t.visit("/2")).text()).toBe("page /2");
    expect(new Set(t.service.seen.map((s) => s.port)).size).toBe(2);
    const other = upstream("other");
    t.engine.at(other.port);
    expect(await (await t.visit("/3")).text()).toBe("other /3");
    expect(t.service.seen).toHaveLength(2);
  });

  test("an unreachable engine is a 502 and the share stays", async () => {
    const t = await rig(true);
    t.engine.state.answer = { ok: false, transient: true, reason: "engine down" };
    expect((await t.visit("/")).status).toBe(502);
    expect(t.previews.list()).toHaveLength(1);
  });

  test("a gone container removes the row and unpublishes", async () => {
    const t = await rig(true);
    t.engine.state.answer = { ok: false, reason: "the container is not running" };
    expect((await t.visit("/")).status).toBeGreaterThanOrEqual(500);
    expect(t.previews.list()).toEqual([]);
    await until(() => t.host.server.core.record(t.shared.app)?.state === "deleted", "deleted");
    expect(t.service.seen).toEqual([]);
  });
});

describe("the share's lifetime", () => {
  test("the session's end unpublishes and closes", async () => {
    const t = await rig(true);
    t.previews.close();
    await until(() => t.host.server.core.record(t.shared.app)?.state === "deleted", "deleted");
    expect(t.host.server.tunnels.has(t.shared.app)).toBe(false);
  });

  test("a stop unpublishes: the address is gone at once", async () => {
    const t = await rig(true);
    t.previews.remove(t.shared.id, "stopped");
    await until(() => t.host.server.core.record(t.shared.app)?.state === "deleted", "deleted");
    expect((await t.visit("/")).status).toBe(410);
  });

  test("a takedown ends the share and removes the row", async () => {
    const t = await rig(true);
    t.host.files.takedowns = { kind: "text", text: `app ${t.shared.app} phishing` };
    t.host.advance(2000);
    await t.host.server.sweep();
    await until(() => t.previews.list().length === 0, "row gone");
  });

  test("an expired app ends the share at the next dial", async () => {
    const host = await startHost({ limits: { leaseMs: 1000 } });
    const service = upstream();
    const s = await session(host.server.url, service.port);
    const shared = await s.share(true);
    // The host drops the tunnel, then its lease runs out before the redial.
    host.server.tunnels.end(shared.app, "killed");
    host.advance(5000);
    await until(() => s.previews.list().length === 0, "row gone");
  });

  test("a host that restarts is dialled again, with backoff", async () => {
    const dir = mkdtempSync(join(tmpdir(), "share-restart-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const options: AppsHostOptions = {
      domain: DOMAIN,
      abuseEmail: "abuse@example.so",
      termsUrl: "https://example.so/terms",
      host: "127.0.0.1",
      store: createFsStore(dir),
      readOperatorFile: () => ({ kind: "absent" }),
    };
    // A port to be rebound: outside the ephemeral range, bound for real.
    const bind = async (port: number) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await startAppsHost({ ...options, port: port + attempt });
        } catch (error) {
          if (attempt > 50) throw error;
        }
      }
    };
    let host = await bind(21000 + Math.floor(Math.random() * 5000));
    cleanups.push(() => host.stop());
    const service = upstream();
    const s = await session(host.url, service.port);
    const shared = await s.share(true);
    const port = host.port;
    await host.stop();
    await until(() => s.previews.list()[0]?.link?.state === "down", "down");
    host = await startAppsHost({ ...options, port });
    await until(() => host.tunnels.has(shared.app), "reconnected");
    await until(() => s.previews.list()[0]?.link?.state === "up", "up");
    const response = await fetch(`${host.url}/back`, {
      headers: { host: `${shared.app}.${DOMAIN}`, ...SAME },
    });
    expect(await response.text()).toBe("page /back");
  });

  test("the daemon stopping unpublishes every share and creates no more", async () => {
    const host = await startHost();
    const service = upstream();
    const s = await session(host.server.url, service.port);
    const a = await s.share(true);
    const b = await s.share();
    await s.starter.close?.();
    for (const app of [a.app, b.app]) {
      expect(host.server.core.record(app)?.state).toBe("deleted");
      expect(host.server.tunnels.has(app)).toBe(false);
    }
    const late = await s.previews.share?.add(facts(service.port), { public: true });
    expect(late).toMatchObject({ ok: false });
  });

  test("a refused creation says why and adds no row", async () => {
    const host = await startHost({ limits: { maxLiveAppsPerKey: 1 } });
    const service = upstream();
    const s = await session(host.server.url, service.port);
    await s.share(true);
    const second = await s.previews.share?.add(facts(service.port), { public: true });
    expect(second).toMatchObject({ ok: false });
    expect(second && !second.ok ? second.reason : "").toContain("cap_reached");
    expect(s.previews.list()).toHaveLength(1);
  });
});

describe("a host that breaks the protocol", () => {
  test("a window overrun closes the tunnel (1008), and the serve dials again", async () => {
    const closes: number[] = [];
    let dials = 0;
    const fake = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        return srv.upgrade(req, { data: undefined })
          ? undefined
          : new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          dials += 1;
          if (dials > 1) return;
          const send = (frame: TunnelFrame) =>
            ws.send(encodeTunnelFrame(frame) ?? new Uint8Array());
          send({
            type: "open",
            stream: 1,
            request: { method: "POST", target: "/slow", headers: [] },
          });
          const bytes = new Uint8Array(APPS_TUNNEL_CHUNK_BYTES);
          const chunks = APPS_TUNNEL_WINDOW_BYTES / APPS_TUNNEL_CHUNK_BYTES;
          for (let i = 0; i <= chunks; i++) send({ type: "data", stream: 1, bytes });
        },
        message() {},
        close(_ws, code) {
          closes.push(code);
        },
      },
    });
    cleanups.push(() => fake.stop(true));
    const ok = { ok: true as const };
    const starter = shareStarterOf(
      DOMAIN,
      async () => ({
        createLive: async () => ({
          ok: true,
          lease: {
            id: "abcdefghijklmnop",
            url: `https://abcdefghijklmnop.${DOMAIN}/`,
            leaseExpiresAt: 1,
            leaseMs: 1,
            renewAfterMs: 1,
          },
        }),
        signTunnel: async () => ({ url: `ws://127.0.0.1:${fake.port}/`, headers: {} }),
        probeTunnel: async () => ok,
        remove: async () => ok,
      }),
      { backoffMinMs: 5 },
    );
    const created = await starter.create();
    if (!created.ok) throw new Error(created.reason);
    const run = created.open({
      secret: undefined,
      // The upstream is never reached: the body is never taken.
      connect: () => new Promise(() => {}),
      onState: () => {},
      onEnded: () => {},
    });
    cleanups.push(() => run.stop());
    await until(() => closes.includes(1008), "1008");
    await until(() => dials > 1, "redial");
  });
});

describe("TENTACLE_APPS_URL", () => {
  test("a loopback http URL only", () => {
    expect(loopbackAppsUrl("http://127.0.0.1:4200")).toBe("http://127.0.0.1:4200");
    expect(loopbackAppsUrl("http://localhost:4200")).toBe("http://localhost:4200");
    for (const bad of [
      undefined,
      "",
      "https://127.0.0.1:4200",
      "http://evil.example",
      "http://127.0.0.1.evil.example",
      "http://localhost@evil.example",
      "http://127.0.0.1:4200/path",
    ]) {
      expect(loopbackAppsUrl(bad)).toBeUndefined();
    }
  });
});
