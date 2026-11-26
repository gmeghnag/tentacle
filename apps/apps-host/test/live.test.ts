/**
 * Live apps (docs/feat/session-apps-container-ports.md S1): a real host, a fake
 * serve dialling the signed tunnel, and visitors over HTTP and WebSocket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { APPS_TUNNEL_CHUNK_BYTES, APPS_TUNNEL_WINDOW_BYTES } from "@tentacle/protocol";
import { DOMAIN, publisher, startHost, stopAll, until } from "./support/host.ts";
import { createPublisher, freshNonce } from "./support/publisher.ts";
import {
  type FakeServe,
  type Host,
  connect,
  dial,
  liveApp,
  tunnelHeaders,
} from "./support/serve.ts";

const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.close();
  }
  await stopAll();
});

const SAME = { "sec-fetch-site": "same-origin" };

const visit = (
  host: Host,
  id: string,
  path: string,
  headers: Record<string, string> = SAME,
  init: { method?: string; body?: string } = {},
): Promise<Response> => host.call(path, { host: `${id}.${DOMAIN}`, headers, ...init });

/** Answer every OPEN with `hello` (and the path), once its request ended. */
const echoing = (frame: { type: string; stream: number }, serve: FakeServe): void => {
  if (frame.type === "end") {
    const open = serve.opens().find((o) => o.stream === frame.stream);
    serve.reply(frame.stream, `hello ${open?.request.target}`);
  }
};

async function setup(options: Parameters<typeof startHost>[0] = {}) {
  const host = await startHost(options);
  const id = await liveApp(host, publisher);
  return { host, id };
}

describe("live app: create and tunnel admission", () => {
  test("a signed create mints a live record with no content", async () => {
    const { host, id } = await setup();
    const record = host.server.core.record(id);
    expect(record?.kind).toBe("live");
    expect(record?.bytes).toBe(0);
    expect(host.memory.records.get(id)?.kind).toBe("live");
    expect(host.memory.contents.size).toBe(0);
  });

  test("live apps count in the per-key cap, and publishing off refuses them", async () => {
    const host = await startHost({ limits: { maxLiveAppsPerKey: 1 } });
    await liveApp(host, publisher);
    const second = await host.signed(publisher, "POST", "/v1/apps/live");
    expect(second.status).toBe(409);
    host.files["kill-switch"] = { kind: "text", text: "publish" };
    host.advance(2000);
    const killed = await host.signed(await createPublisher(), "POST", "/v1/apps/live");
    expect(killed.status).toBe(503);
  });

  test("a live app takes no content", async () => {
    const { host, id } = await setup();
    const response = await host.signed(publisher, "PUT", `/v1/apps/${id}`, "<p>x</p>");
    expect(response.status).toBe(400);
  });

  test("an unsigned upgrade never becomes a tunnel", async () => {
    const { host, id } = await setup();
    const serve = dial(host, id, {});
    await until(() => serve.closed() !== undefined);
    expect(host.server.tunnels.has(id)).toBe(false);
    expect(serve.opened()).toBe(false);
  });

  test("another key's upgrade is refused with the reason", async () => {
    const { host, id } = await setup();
    const other = await createPublisher();
    const serve = dial(host, id, await tunnelHeaders(host, other, id));
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()).toEqual({ code: 4001, reason: "forbidden" });
    expect(host.server.tunnels.has(id)).toBe(false);
  });

  test("a replayed upgrade is refused", async () => {
    const { host, id } = await setup();
    const headers = await tunnelHeaders(host, publisher, id, freshNonce());
    const first = dial(host, id, headers);
    await until(() => first.opened() && host.server.tunnels.has(id));
    const again = dial(host, id, headers);
    await until(() => again.closed() !== undefined);
    expect(again.opened()).toBe(false);
    expect(first.closed()).toBeUndefined();
  });

  test("a static app has no tunnel", async () => {
    const host = await startHost();
    const id = await host.publish(publisher);
    const serve = dial(host, id, await tunnelHeaders(host, publisher, id));
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()?.code).toBe(4001);
    expect(host.server.tunnels.has(id)).toBe(false);
  });

  test("the newest signed tunnel replaces the old one", async () => {
    const { host, id } = await setup();
    const first = await connect(host, publisher, id);
    const second = await connect(host, publisher, id, echoing);
    await until(() => first.closed() !== undefined);
    expect(first.closed()?.code).toBe(4002);
    const response = await visit(host, id, "/");
    expect(await response.text()).toBe("hello /");
    expect(second.closed()).toBeUndefined();
  });

  test("past the tunnel cap, refused", async () => {
    const host = await startHost({ limits: { maxLiveTunnels: 1 } });
    const a = await liveApp(host, publisher);
    const b = await liveApp(host, publisher);
    await connect(host, publisher, a);
    const serve = dial(host, b, await tunnelHeaders(host, publisher, b));
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()?.reason).toBe("cap_reached");
  });
});

describe("live app: the visitor path", () => {
  test("without same-origin Fetch Metadata: the warning, and nothing opened", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, echoing);
    for (const headers of [
      {},
      {
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    ] as Record<string, string>[]) {
      const response = await visit(host, id, '/a/b?q="><script>', headers);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("not by tentacle");
      expect(body).toContain(`https://${DOMAIN}/report?app=${id}`);
      expect(body).toContain('href="/a/b?q=%22%3E%3Cscript%3E"');
      expect(body).not.toContain('"><script>');
    }
    const forbidden = await visit(host, id, "/", {
      "sec-fetch-site": "cross-site",
      "sec-fetch-mode": "cors",
    });
    expect(forbidden.status).toBe(403);
    const post = await visit(host, id, "/", {}, { method: "POST", body: "x" });
    expect(post.status).toBe(403);
    expect(serve.opens()).toHaveLength(0);
  });

  test("the Continue link never leaves the origin", async () => {
    const { host, id } = await setup();
    for (const path of ["//evil.example/x", "/\\evil.example/x"]) {
      const body = await (await visit(host, id, path, {})).text();
      expect(body).not.toContain('href="//');
      expect(body).not.toContain('href="/\\');
    }
  });

  test("a same-origin request opens a stream with method, target and headers", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, echoing);
    const response = await visit(host, id, "/p/q?x=1", {
      ...SAME,
      cookie: "a=1",
      "x-custom": "yes",
      "x-forwarded-for": "203.0.113.9",
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello /p/q?x=1");
    const request = serve.opens()[0]?.request;
    expect(request?.method).toBe("GET");
    expect(request?.target).toBe("/p/q?x=1");
    expect(request?.headers).toContainEqual(["cookie", "a=1"]);
    expect(request?.headers).toContainEqual(["x-custom", "yes"]);
    expect(request?.headers.map(([name]) => name)).not.toContain("x-forwarded-for");
  });

  test("a request body arrives whole, in chunks inside the window", async () => {
    const { host, id } = await setup();
    let received = 0;
    await connect(host, publisher, id, (frame, serve) => {
      if (frame.type === "data") {
        received += frame.bytes.length;
        serve.send({ type: "ack", stream: frame.stream, bytes: frame.bytes.length });
      }
      if (frame.type === "end") {
        serve.reply(frame.stream, `got ${received}`);
      }
    });
    const size = APPS_TUNNEL_WINDOW_BYTES * 3;
    const response = await visit(host, id, "/up", SAME, {
      method: "POST",
      body: "x".repeat(size),
    });
    expect(await response.text()).toBe(`got ${size}`);
  });

  test("a streamed response arrives as it is sent, and is acked", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, (frame, s) => {
      if (frame.type === "end") {
        s.send({ type: "head", stream: frame.stream, response: { status: 200, headers: [] } });
        s.send({ type: "data", stream: frame.stream, bytes: new TextEncoder().encode("c1;") });
      }
    });
    const response = await visit(host, id, "/stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe("c1;");
    const stream = serve.opens()[0]?.stream ?? 0;
    await until(() => serve.of(stream).some((f) => f.type === "ack" && f.bytes === 3));
    serve.send({ type: "data", stream, bytes: new TextEncoder().encode("c2;") });
    serve.send({ type: "end", stream });
    const second = await reader?.read();
    expect(new TextDecoder().decode(second?.value)).toBe("c2;");
    expect((await reader?.read())?.done).toBe(true);
  });

  test("host-forced headers; cookies with a Domain are dropped", async () => {
    const { host, id } = await setup();
    await connect(host, publisher, id, (frame, serve) => {
      if (frame.type === "end") {
        serve.reply(frame.stream, "ok", [
          ["set-cookie", "mine=1; Path=/"],
          ["set-cookie", "toss=1; Domain=.example.so"],
          ["set-cookie", "toss2=1;domain = example.so"],
          ["content-security-policy", "default-src 'self'"],
          ["referrer-policy", "unsafe-url"],
          ["permissions-policy", "camera=*"],
        ]);
      }
    });
    const response = await visit(host, id, "/");
    expect(response.headers.getSetCookie()).toEqual(["mine=1; Path=/"]);
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("permissions-policy")).toContain("camera=()");
    expect(response.headers.get("permissions-policy")).not.toContain("camera=*");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'self'");
  });

  test("a WebSocket is relayed both ways with the chosen subprotocol", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, (frame, s) => {
      if (frame.type === "open") {
        s.send({
          type: "head",
          stream: frame.stream,
          response: { status: 101, headers: [], protocol: "vite-hmr" },
        });
      }
      if (frame.type === "ws_text") {
        s.send({ type: "ws_text", stream: frame.stream, text: `echo:${frame.text}` });
      }
      if (frame.type === "ws_bin") {
        s.send({ type: "ws_bin", stream: frame.stream, bytes: frame.bytes });
      }
    });
    const got: unknown[] = [];
    let closed: number | undefined;
    const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/hmr`, {
      headers: { host: `${id}.${DOMAIN}`, ...SAME },
      protocols: ["vite-hmr"],
    } as unknown as string[]);
    sockets.push(socket);
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => got.push(event.data);
    socket.onclose = (event) => {
      closed = event.code;
    };
    await until(() => socket.readyState === WebSocket.OPEN);
    expect(socket.protocol).toBe("vite-hmr");
    expect(serve.opens()[0]?.request.ws?.protocols).toEqual(["vite-hmr"]);
    socket.send("hi");
    socket.send(new Uint8Array([1, 2, 9]));
    await until(() => got.length === 2);
    expect(got[0]).toBe("echo:hi");
    expect([...new Uint8Array(got[1] as ArrayBuffer)]).toEqual([1, 2, 9]);
    serve.send({
      type: "ws_close",
      stream: serve.opens()[0]?.stream ?? 0,
      code: 4000,
      reason: "x",
    });
    await until(() => closed !== undefined);
    expect(closed).toBe(4000);
  });

  test("a WebSocket is allowed by the app's own Origin alone, and by no other", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, (frame, s) => {
      if (frame.type === "open") {
        s.send({ type: "head", stream: frame.stream, response: { status: 101, headers: [] } });
      }
    });
    const attempt = (origin: string): WebSocket => {
      const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/w`, {
        headers: { host: `${id}.${DOMAIN}`, origin },
      } as unknown as string[]);
      sockets.push(socket);
      return socket;
    };
    const mine = attempt(`https://${id}.${DOMAIN}`);
    await until(() => mine.readyState === WebSocket.OPEN);
    const theirs = attempt("https://evil.example");
    let refused = false;
    theirs.onclose = () => {
      refused = true;
    };
    await until(() => refused);
    expect(serve.opens()).toHaveLength(1);
  });

  test("past the per-app stream cap: 503", async () => {
    const { host, id } = await setup({ limits: { maxStreamsPerApp: 2 } });
    const serve = await connect(host, publisher, id);
    const held = [visit(host, id, "/1"), visit(host, id, "/2")];
    await until(() => serve.opens().length === 2);
    const third = await visit(host, id, "/3");
    expect(third.status).toBe(503);
    expect(serve.opens()).toHaveLength(2);
    for (const open of serve.opens()) {
      serve.reply(open.stream, "done");
    }
    expect((await Promise.all(held)).map((r) => r.status)).toEqual([200, 200]);
  });

  test("past the per-address rate: 429", async () => {
    const { host, id } = await setup({ limits: { liveRequestsPerMinutePerIp: 2 } });
    await connect(host, publisher, id, echoing);
    expect((await visit(host, id, "/")).status).toBe(200);
    expect((await visit(host, id, "/")).status).toBe(200);
    expect((await visit(host, id, "/")).status).toBe(429);
  });

  test("no tunnel: the offline page", async () => {
    const { host, id } = await setup();
    const response = await visit(host, id, "/");
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Offline");
  });

  test("a tunnel that drops fails the waiting request", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id);
    const waiting = visit(host, id, "/");
    await until(() => serve.opens().length === 1);
    serve.socket.close();
    expect((await waiting).status).toBe(502);
  });

  test("a reset before the head is a 502", async () => {
    const { host, id } = await setup();
    await connect(host, publisher, id, (frame, serve) => {
      if (frame.type === "open") {
        serve.send({ type: "reset", stream: frame.stream, reason: "no" });
      }
    });
    expect((await visit(host, id, "/")).status).toBe(502);
  });

  test("an idle stream is reset by the sweep", async () => {
    const { host, id } = await setup({ limits: { liveStreamIdleMs: 1000 } });
    const serve = await connect(host, publisher, id);
    const waiting = visit(host, id, "/");
    await until(() => serve.opens().length === 1);
    host.advance(2000);
    await host.server.sweep();
    expect((await waiting).status).toBe(504);
    await until(() => serve.frames.some((f) => f.type === "reset"));
  });

  test("the daily byte cap resets live streams and refuses new ones", async () => {
    const { host, id } = await setup({ limits: { liveBytesPerDay: 100 } });
    const over = await connect(host, publisher, id, (frame, s) => {
      // Each request: a head, and 60 bytes, never an end.
      if (frame.type === "end") {
        s.send({ type: "head", stream: frame.stream, response: { status: 200, headers: [] } });
        s.send({ type: "data", stream: frame.stream, bytes: new Uint8Array(60) });
      }
    });
    const first = await visit(host, id, "/1");
    const reader = first.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(60);
    // The second passes the cap: BOTH live streams are reset, its bytes unsent.
    const received = await visit(host, id, "/2")
      .then((response) => response.arrayBuffer())
      .catch(() => new ArrayBuffer(0));
    expect(received.byteLength).toBe(0);
    await until(() => over.frames.filter((f) => f.type === "reset").length === 2);
    await reader?.cancel().catch(() => {});
    const next = await visit(host, id, "/");
    expect(next.status).toBe(503);
    expect(await next.text()).toContain("daily limit");
  });
});

describe("live app: bad input from the serve closes the tunnel", () => {
  const closes = async (hostile: (serve: FakeServe, stream: number) => void): Promise<void> => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, (frame, s) => {
      if (frame.type === "end") {
        hostile(s, frame.stream);
      }
    });
    const response = await visit(host, id, "/");
    await response.arrayBuffer().catch(() => {});
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()?.code).toBe(1008);
    expect(host.server.tunnels.has(id)).toBe(false);
  };

  test("a malformed frame", () => closes((serve) => serve.sendRaw(new Uint8Array([99, 0, 0]))));

  test("a stream the host never opened", () =>
    closes((serve, stream) => serve.send({ type: "end", stream: stream + 1 })));

  test("an OPEN from the serve", () =>
    closes((serve, stream) =>
      serve.send({
        type: "open",
        stream,
        request: { method: "GET", target: "/", headers: [] },
      }),
    ));

  test("a window overrun", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, (frame, s) => {
      if (frame.type === "end") {
        s.send({ type: "head", stream: frame.stream, response: { status: 200, headers: [] } });
        // Far past the window, whatever the ACKs say, to a visitor who never reads.
        const bytes = new Uint8Array(APPS_TUNNEL_CHUNK_BYTES);
        const chunks = APPS_TUNNEL_WINDOW_BYTES / APPS_TUNNEL_CHUNK_BYTES;
        for (let i = 0; i < chunks * 64; i++) {
          s.send({ type: "data", stream: frame.stream, bytes });
        }
      }
    });
    const visitor = await Bun.connect({
      hostname: "127.0.0.1",
      port: host.server.port,
      socket: {
        open(socket) {
          socket.write(
            `GET / HTTP/1.1\r\nHost: ${id}.${DOMAIN}\r\nSec-Fetch-Site: same-origin\r\n\r\n`,
          );
          // Stop reading (Bun's socket has it; its types do not).
          (socket as unknown as { pause(): void }).pause();
        },
        data() {},
      },
    });
    await until(() => serve.closed() !== undefined);
    visitor.end();
    expect(serve.closed()?.code).toBe(1008);
    expect(host.server.tunnels.has(id)).toBe(false);
  });

  test("an ACK for bytes never sent", () =>
    closes((serve, stream) => serve.send({ type: "ack", stream, bytes: 5 })));

  test("a late frame for a finished stream is ignored", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, echoing);
    expect((await visit(host, id, "/")).status).toBe(200);
    const stream = serve.opens()[0]?.stream ?? 0;
    serve.send({ type: "data", stream, bytes: new Uint8Array(3) });
    expect((await visit(host, id, "/again")).status).toBe(200);
    expect(serve.closed()).toBeUndefined();
  });
});

describe("live app: operator and lifetime", () => {
  test("kill all closes the tunnel and refuses at once", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, echoing);
    host.files["kill-switch"] = { kind: "text", text: "all" };
    host.advance(2000);
    expect((await visit(host, id, "/")).status).toBe(503);
    expect(serve.opens()).toHaveLength(0);
    await host.server.sweep();
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()).toEqual({ code: 4003, reason: "killed" });
  });

  test("kill publish keeps a running tunnel and refuses a new one", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id, echoing);
    host.files["kill-switch"] = { kind: "text", text: "publish" };
    host.advance(2000);
    await host.server.sweep();
    expect((await visit(host, id, "/")).status).toBe(200);
    const again = dial(host, id, await tunnelHeaders(host, publisher, id));
    await until(() => again.closed() !== undefined);
    expect(again.closed()?.reason).toBe("killed");
    expect(serve.closed()).toBeUndefined();
  });

  test("a key takedown closes the tunnel", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id);
    host.files.takedowns = { kind: "text", text: `key ${publisher.key} abuse\n` };
    host.advance(2000);
    await host.server.sweep();
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()).toEqual({ code: 4003, reason: "taken_down" });
    expect((await visit(host, id, "/")).status).toBe(410);
  });

  test("an unpublish closes the tunnel", async () => {
    const { host, id } = await setup();
    const serve = await connect(host, publisher, id);
    const response = await host.signed(publisher, "DELETE", `/v1/apps/${id}`);
    expect(response.status).toBe(204);
    await until(() => serve.closed() !== undefined);
    expect(serve.closed()?.reason).toBe("deleted");
    expect((await visit(host, id, "/")).status).toBe(410);
  });

  test("the lease lives with the tunnel, and ends after it", async () => {
    const { host, id } = await setup({ limits: { leaseMs: 60_000 } });
    const serve = await connect(host, publisher, id, echoing);
    for (let i = 0; i < 3; i++) {
      host.advance(120_000);
      await host.server.sweep();
    }
    expect(host.server.core.record(id)?.state).toBe("live");
    expect((await visit(host, id, "/")).status).toBe(200);
    serve.socket.close();
    await until(() => !host.server.tunnels.has(id));
    host.advance(59_000);
    await host.server.sweep();
    expect(host.server.core.record(id)?.state).toBe("live");
    host.advance(2000);
    await host.server.sweep();
    expect(host.server.core.record(id)?.state).toBe("expired");
    expect(host.server.core.record(id)?.kind).toBe("live");
    const late = dial(host, id, await tunnelHeaders(host, publisher, id));
    await until(() => late.closed() !== undefined);
    expect(late.closed()?.reason).toBe("expired");
  });

  test("no log line carries a path, a query or a header", async () => {
    const { host, id } = await setup();
    await connect(host, publisher, id, echoing);
    await (await visit(host, id, "/s3cr3t-path?tok=q1w2", { ...SAME, "x-h": "hdr9" })).text();
    await visit(host, id, "/s3cr3t-warn", {});
    await visit(host, id, "/s3cr3t-forbidden", { "sec-fetch-site": "cross-site" });
    await host.server.stop();
    const all = host.lines.join("\n");
    expect(all).toContain(id);
    for (const secret of ["s3cr3t", "q1w2", "hdr9"]) {
      expect(all).not.toContain(secret);
    }
  });
});
