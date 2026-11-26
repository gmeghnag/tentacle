/**
 * docs/feat/container-apps-devices.md: one device connection's preview tunnels.
 * Real loopback servers bound by the test (`port: 0`, kept bound), a recorded
 * `send`. Mutations: drop the credit check in `pump` → the window test fails;
 * drop the HTTP gate → the raw-protocol tests fail.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { type Server, type Socket, createServer } from "node:net";
import { MAX_TUNNELS_PER_CONNECTION, PREVIEW_WINDOW_BYTES } from "@tentacle/protocol";
import { until } from "../../client/test/support/fakes.ts";
import { PreviewTunnels, dialLoopback, httpRequestGate } from "../src/preview-tunnels.ts";

interface Sent {
  readonly method: string;
  readonly params: { tunnelId: string; data?: string; bytes?: number; reason?: string };
}

interface Upstream {
  readonly port: number;
  readonly received: Buffer[];
  readonly sockets: Socket[];
  closed: number;
}

const servers: Server[] = [];
const allSockets: Socket[] = [];
const tables: PreviewTunnels[] = [];
afterEach(() => {
  for (const t of tables.splice(0)) t.closeAll();
  for (const s of allSockets.splice(0)) s.destroy();
  for (const s of servers.splice(0)) s.close();
});

async function upstream(onData?: (socket: Socket, data: Buffer) => void): Promise<Upstream> {
  const state: Upstream = { port: 0, received: [], sockets: [], closed: 0 };
  const server = createServer((socket) => {
    state.sockets.push(socket);
    allSockets.push(socket);
    socket.on("data", (d) => {
      state.received.push(d);
      onData?.(socket, d);
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      state.closed++;
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return Object.assign(state, {
    port: typeof address === "object" && address ? address.port : 0,
  });
}

function table(): { tunnels: PreviewTunnels; sent: Sent[] } {
  const sent: Sent[] = [];
  const tunnels = new PreviewTunnels((method, params) => sent.push({ method, params }));
  tables.push(tunnels);
  return { tunnels, sent };
}

async function open(tunnels: PreviewTunnels, port: number, onClosed?: () => void) {
  const slot = tunnels.reserve();
  if (!slot) throw new Error("no slot");
  const id = slot.open(await dialLoopback(port), onClosed);
  if (id === undefined) throw new Error("not opened");
  return id;
}

const b64 = (text: string | Buffer): string =>
  (typeof text === "string" ? Buffer.from(text) : text).toString("base64");
const joined = (chunks: Buffer[]): Buffer =>
  Buffer.concat(chunks.map((chunk) => new Uint8Array(chunk)));
const received = (u: Upstream): string => joined(u.received).toString("latin1");
const bytesOf = (sent: Sent[], id: string): Buffer =>
  joined(
    sent
      .filter((s) => s.method === "preview/data" && s.params.tunnelId === id)
      .map((s) => Buffer.from(s.params.data ?? "", "base64")),
  );
const closes = (sent: Sent[]) => sent.filter((s) => s.method === "preview/close");
const REQUEST = "GET / HTTP/1.1\r\nHost: x\r\n\r\n";

describe("httpRequestGate", () => {
  const gate = (s: string) => httpRequestGate(Buffer.from(s, "latin1"));
  test("passes HTTP/1.x request lines, a WebSocket upgrade included", () => {
    expect(gate(REQUEST)).toBe("pass");
    expect(gate("POST /a?b=c HTTP/1.0\r\n")).toBe("pass");
    expect(gate("GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")).toBe(
      "pass",
    );
  });
  test("waits for the end of the first line, up to 8 KiB", () => {
    expect(gate("")).toBe("wait");
    expect(gate("GET / HT")).toBe("wait");
    expect(gate("GET / HTTP/1.1\r")).toBe("wait");
    expect(gate(`GET /${"a".repeat(8000)}`)).toBe("wait");
    expect(gate(`GET /${"a".repeat(8200)}`)).toBe("reject");
    expect(gate(`GET /${"a".repeat(8200)} HTTP/1.1\r\n`)).toBe("reject");
  });
  test("rejects everything else", () => {
    for (const s of [
      "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n",
      "GET / HTTP/1.1\n",
      "GET / HTTP/1.2\r\n",
      "GET  / HTTP/1.1\r\n",
      "GET / HTTP/1.1 \r\n",
      "HELO mail\r\n",
      "\r\nGET / HTTP/1.1\r\n",
      "*1\r\n$4\r\nPING\r\n",
      "\x16\x03\x01\x02\x00",
      "G(T / HTTP/1.1\r\n",
    ]) {
      expect([s, gate(s)]).toEqual([s, "reject"]);
    }
  });
});

describe("tunnels", () => {
  test("bytes both ways; the phone's bytes are acked once written", async () => {
    const u = await upstream((s) => s.write("HTTP/1.1 200 OK\r\n\r\nhi"));
    const { tunnels, sent } = table();
    const id = await open(tunnels, u.port);
    tunnels.data(id, b64(REQUEST));
    await until(() => bytesOf(sent, id).toString() === "HTTP/1.1 200 OK\r\n\r\nhi");
    expect(received(u)).toBe(REQUEST);
    const acks = sent.filter((s) => s.method === "preview/ack");
    expect(acks.reduce((n, a) => n + (a.params.bytes ?? 0), 0)).toBe(REQUEST.length);
  });

  test("a request line split across chunks is forwarded once complete, whole", async () => {
    const u = await upstream();
    const { tunnels } = table();
    const id = await open(tunnels, u.port);
    tunnels.data(id, b64("GET / HT"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(received(u)).toBe("");
    tunnels.data(id, b64("TP/1.1\r\n\r\n"));
    await until(() => received(u) === "GET / HTTP/1.1\r\n\r\n");
  });

  test("no ack: the upstream is paused at the window; an ack resumes it, nothing lost", async () => {
    const total = 4 * 1024 * 1024;
    const body = Buffer.alloc(total);
    for (let i = 0; i < total; i += 4) body.writeUInt32LE(i, i);
    const u = await upstream((s) => s.end(new Uint8Array(body)));
    const { tunnels, sent } = table();
    const id = await open(tunnels, u.port);
    tunnels.data(id, b64(REQUEST));
    await until(() => bytesOf(sent, id).length >= PREVIEW_WINDOW_BYTES);
    // Give a leaking pump every chance to run past the window.
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(bytesOf(sent, id).length).toBe(PREVIEW_WINDOW_BYTES);
    expect(closes(sent)).toEqual([]);
    for (const s of sent) {
      if (s.method === "preview/data") {
        expect(Buffer.from(s.params.data ?? "", "base64").length).toBeLessThanOrEqual(32 * 1024);
      }
    }
    // Ack as the phone would, until the server's end arrives.
    let acked = 0;
    await until(() => {
      const have = bytesOf(sent, id).length;
      if (have > acked) {
        expect(have - acked).toBeLessThanOrEqual(PREVIEW_WINDOW_BYTES);
        tunnels.ack(id, have - acked);
        acked = have;
      }
      return closes(sent).length > 0;
    });
    expect(bytesOf(sent, id).equals(new Uint8Array(body))).toBe(true);
    expect(closes(sent)[0]?.params).toEqual({ tunnelId: id, reason: "end" });
    expect(tunnels.size).toBe(0);
  });

  test("an over-ack grants no credit beyond the window", async () => {
    const u = await upstream((s) => s.write(new Uint8Array(2 * 1024 * 1024)));
    const { tunnels, sent } = table();
    const id = await open(tunnels, u.port);
    tunnels.ack(id, 10 * 1024 * 1024);
    tunnels.data(id, b64(REQUEST));
    await until(() => bytesOf(sent, id).length >= PREVIEW_WINDOW_BYTES);
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
    expect(bytesOf(sent, id).length).toBe(PREVIEW_WINDOW_BYTES);
  });

  test("not HTTP/1 first: closed, the upstream got 0 bytes", async () => {
    for (const first of ["PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n", "*1\r\n$4\r\nPING\r\n"]) {
      const u = await upstream();
      const { tunnels, sent } = table();
      const id = await open(tunnels, u.port);
      tunnels.data(id, b64(first));
      expect(closes(sent)[0]?.params.reason).toBe("not-http");
      tunnels.data(id, b64(REQUEST));
      await until(() => u.closed === 1);
      expect(received(u)).toBe("");
      expect(tunnels.size).toBe(0);
    }
  });

  test("a server that speaks first is not HTTP: closed, nothing sent to the phone", async () => {
    const u = await upstream();
    const { tunnels, sent } = table();
    await open(tunnels, u.port);
    await until(() => u.sockets.length === 1);
    u.sockets[0]?.write("SSH-2.0-OpenSSH\r\n");
    await until(() => closes(sent).length === 1);
    expect(sent.filter((s) => s.method === "preview/data")).toEqual([]);
  });

  test("a phone flooding past the window is closed; other tunnels live on", async () => {
    const u = await upstream();
    const { tunnels, sent } = table();
    const flooder = await open(tunnels, u.port);
    const other = await open(tunnels, u.port);
    tunnels.data(flooder, b64(REQUEST));
    const chunk = b64(Buffer.alloc(32 * 1024, 97));
    // Synchronous: no write callback can run in between.
    for (let i = 0; i < 8; i++) tunnels.data(flooder, chunk);
    expect(closes(sent).map((c) => c.params)).toEqual([{ tunnelId: flooder, reason: "window" }]);
    tunnels.data(other, b64(REQUEST));
    expect(tunnels.size).toBe(1);
  });

  test("a bad base64 or an oversized chunk closes the tunnel", async () => {
    const u = await upstream();
    for (const [data, reason] of [
      ["***", "bad-data"],
      ["abc", "bad-data"],
      [b64(Buffer.alloc(32 * 1024 + 1)), "chunk"],
    ] as const) {
      const { tunnels, sent } = table();
      const id = await open(tunnels, u.port);
      tunnels.data(id, data);
      expect(closes(sent)[0]?.params).toEqual({ tunnelId: id, reason });
      expect(tunnels.size).toBe(0);
    }
  });

  test("unknown tunnel: data answers preview/close; ack and close are ignored", () => {
    const { tunnels, sent } = table();
    tunnels.ack("nope", 1);
    tunnels.close("nope", "phone", false);
    expect(sent).toEqual([]);
    tunnels.data("nope", b64(REQUEST));
    expect(sent).toEqual([
      { method: "preview/close", params: { tunnelId: "nope", reason: "unknown-tunnel" } },
    ]);
  });

  test("the upstream ending closes the tunnel and runs onClosed once", async () => {
    const u = await upstream((s) => s.end());
    const { tunnels, sent } = table();
    let released = 0;
    const id = await open(tunnels, u.port, () => released++);
    tunnels.data(id, b64(REQUEST));
    await until(() => closes(sent).length === 1);
    tunnels.close(id, "again", true);
    expect(released).toBe(1);
    expect(closes(sent)).toHaveLength(1);
  });

  test("closeAll destroys the upstream sockets, silently, and refuses new slots", async () => {
    const u = await upstream();
    const { tunnels, sent } = table();
    let released = 0;
    await open(tunnels, u.port, () => released++);
    const pending = tunnels.reserve();
    tunnels.closeAll();
    await until(() => u.closed === 1);
    expect(released).toBe(1);
    expect(sent).toEqual([]);
    expect(tunnels.reserve()).toBeUndefined();
    // A dial that finishes after the close: its socket is destroyed.
    const late = await dialLoopback(u.port);
    expect(pending?.open(late)).toBeUndefined();
    expect(late.destroyed).toBe(true);
  });

  test("the 33rd tunnel (pending dials included) is refused; a release frees a slot", () => {
    const { tunnels } = table();
    const slots = Array.from({ length: MAX_TUNNELS_PER_CONNECTION }, () => tunnels.reserve());
    expect(slots.every((s) => s !== undefined)).toBe(true);
    expect(tunnels.reserve()).toBeUndefined();
    slots[0]?.release();
    slots[0]?.release();
    expect(tunnels.reserve()).toBeDefined();
    expect(tunnels.reserve()).toBeUndefined();
  });

  test("a refused dial rejects", async () => {
    await expect(dialLoopback(1)).rejects.toThrow();
  });
});
