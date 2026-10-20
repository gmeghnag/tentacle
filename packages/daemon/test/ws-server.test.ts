import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { Agent } from "@tentacle/agent";
import { type ChatRequest, PermissionBroker, type StreamEvent } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { SessionHost } from "../src/session-host.ts";
import {
  isLoopbackHost,
  originAllowed,
  socketOptions,
  startWsServer,
  tokensMatch,
} from "../src/ws-server.ts";

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

describe("isLoopbackHost", () => {
  test("recognises loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.17")).toBe(false);
  });
});

describe("tokensMatch", () => {
  test("constant-time compare: equal only for identical tokens", () => {
    expect(tokensMatch("s3cret", "s3cret")).toBe(true);
    expect(tokensMatch("s3cret", "s3cre")).toBe(false);
    expect(tokensMatch("s3cret", "x3cret")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});

describe("originAllowed", () => {
  test("no allow-list: a headerless native client is allowed, any browser Origin denied", () => {
    expect(originAllowed(null)).toBe(true);
    expect(originAllowed("https://evil.example")).toBe(false);
    expect(originAllowed("http://localhost:3000")).toBe(false);
  });

  test("with an allow-list: only listed Origins pass, headerless is denied", () => {
    const allow = ["https://app.example"];
    expect(originAllowed("https://app.example", allow)).toBe(true);
    expect(originAllowed("https://evil.example", allow)).toBe(false);
    expect(originAllowed(null, allow)).toBe(false);
    expect(originAllowed("", allow)).toBe(false);
  });

  test("an empty allow-list behaves as none (default-deny Origins)", () => {
    expect(originAllowed(null, [])).toBe(true);
    expect(originAllowed("https://evil.example", [])).toBe(false);
  });
});

describe("startWsServer Origin enforcement (CSRF / DNS-rebinding)", () => {
  const statusFor = async (url: string, headers: Record<string, string>): Promise<number> =>
    (await fetch(url, { headers })).status;

  test("loopback default rejects a cross-origin browser upgrade (401 before upgrade)", async () => {
    const server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: dummyHost });
    const http = `http://127.0.0.1:${server.port}`;
    try {
      // A browser sends Origin → refused at the HTTP upgrade, before the socket.
      expect(await statusFor(http, { Origin: "https://evil.example" })).toBe(401);
      // A native client sends no Origin → passes auth, fails only the WS upgrade.
      expect(await statusFor(http, {})).toBe(426);
    } finally {
      server.stop();
    }
  });

  test("a configured allow-list admits the listed Origin and rejects others", async () => {
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: dummyHost,
      allowedOrigins: ["https://app.example"],
    });
    const http = `http://127.0.0.1:${server.port}`;
    try {
      expect(await statusFor(http, { Origin: "https://app.example" })).toBe(426);
      expect(await statusFor(http, { Origin: "https://evil.example" })).toBe(401);
    } finally {
      server.stop();
    }
  });
});

describe("startWsServer safe bind", () => {
  test("refuses a non-loopback bind without a token", () => {
    expect(() => startWsServer({ host: "0.0.0.0", port: 0, sessionHost: dummyHost })).toThrow(
      /non-loopback/i,
    );
  });

  test("a non-loopback bind WITH a token is allowed", () => {
    const server = startWsServer({
      host: "0.0.0.0",
      port: 0,
      token: "tok",
      sessionHost: dummyHost,
    });
    expect(server.url).toContain("0.0.0.0");
    server.stop();
  });
});

/** One masked client→server text frame (RFC 6455 §5.2), for a raw TCP client. */
function clientFrame(text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const len = payload.length;
  const header = len < 126 ? [0x81, 0x80 | len] : [0x81, 0x80 | 126, (len >> 8) & 0xff, len & 0xff];
  const mask = [1, 2, 3, 4];
  const frame = new Uint8Array(header.length + 4 + len);
  frame.set(header, 0);
  frame.set(mask, header.length);
  payload.forEach((b, i) => {
    frame[header.length + 4 + i] = b ^ (mask[i % 4] ?? 0);
  });
  return frame;
}

describe("startWsServer backpressure (a client that stops reading)", () => {
  // The frozen client opens a session over a raw socket and never reads again;
  // a healthy client prompts it into a big burst. Past the limit the server
  // must CLOSE the frozen socket (→ its Connection detaches) — never keep it
  // open while dropping frames silently — and the healthy client gets it all.
  test("the frozen socket is closed and detached; the healthy client receives every update", async () => {
    const CHUNKS = 400;
    const big = "x".repeat(20_000);
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => {
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model: {
            id: "burst",
            async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
              // One chunk per macrotask: a reading client drains between
              // them; the frozen one cannot. (A synchronous burst past the
              // limit would close any socket — hence limit > replay ring.)
              for (let i = 0; i < CHUNKS; i++) {
                await new Promise((r) => setTimeout(r, 0));
                yield { type: "text", delta: big };
              }
              yield { type: "done" };
            },
          },
          tools: new ToolRegistry(),
          env: {
            id: "noop",
            exec: () => Promise.reject(new Error("unused")),
            readFile: () => Promise.reject(new Error("unused")),
            writeFile: () => Promise.reject(new Error("unused")),
          },
        });
        return { agent, permissions };
      },
    });
    const audit: string[] = [];
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: host,
      backpressureLimit: 256 * 1024,
      onAudit: (line) => audit.push(line),
    });
    const sock = connect(server.port, "127.0.0.1");
    const healthy = new WebSocket(server.url);
    const healthyOpen = new Promise<void>((resolve) => {
      healthy.onopen = () => resolve();
    });
    try {
      await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
      sock.pause(); // never read: the kernel buffers fill, then Bun's queue
      sock.write(
        "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
      );
      const init = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
      sock.write(
        clientFrame(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: init })),
      );
      sock.write(
        clientFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "session/open",
            params: { sessionId: "S", create: true },
          }),
        ),
      );
      const until = (cond: () => boolean, ms = 3000): Promise<void> =>
        new Promise((resolve, reject) => {
          const deadline = Date.now() + ms;
          const poll = (): void => {
            if (cond()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out: ${String(cond)}`));
            else setTimeout(poll, 5);
          };
          poll();
        });
      await until(() => host.get("S")?.attachedCount === 1);

      const seqs: number[] = [];
      let ended = false;
      const responses = new Map<number, unknown>();
      healthy.onmessage = (event) => {
        const msg = JSON.parse(String(event.data));
        if (msg.method === "session/update") {
          seqs.push(msg.params.seq);
          if (msg.params.update.type === "turn_end") ended = true;
        } else if (typeof msg.id === "number") {
          responses.set(msg.id, msg.result ?? msg.error);
        }
      };
      await healthyOpen;
      const send = (id: number, method: string, params: unknown): void =>
        healthy.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      send(1, "initialize", init);
      await until(() => responses.has(1));
      send(2, "session/open", { sessionId: "S" });
      await until(() => responses.has(2));
      expect(host.get("S")?.attachedCount).toBe(2);
      send(3, "session/prompt", {
        sessionId: "S",
        turnId: "t",
        content: [{ type: "text", text: "go" }],
      });
      await until(() => ended, 10_000);

      // Closed by the server, detached from the session — not silently starved.
      await until(() => host.get("S")?.attachedCount === 1);
      expect(audit.filter((l) => l === "connection-close")).toHaveLength(1);
      // The healthy client missed nothing: contiguous from turn_start to turn_end.
      expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
      expect(seqs.length).toBe(CHUNKS + 2);
    } finally {
      healthy.close();
      sock.destroy();
      server.stop();
    }
  }, 20_000);
});

describe("socketOptions (the keepalive/backpressure contract, always on)", () => {
  test("pings always on, idle timeout 60 s by default, backpressure closes", () => {
    // Mutation: `sendPings: false` or no `idleTimeout` → red here, without the slow test.
    expect(socketOptions({})).toEqual({
      backpressureLimit: 16 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      idleTimeout: 60,
      sendPings: true,
    });
    expect(socketOptions({ idleTimeoutSec: 5, backpressureLimit: 1024 })).toMatchObject({
      idleTimeout: 5,
      backpressureLimit: 1024,
    });
  });
});

// Opt-in (~12 s): set TENTACLE_SLOW_TESTS=1. It proves what `socketOptions`
// cannot — that Bun really behaves that way on this version.
const SLOW = process.env.TENTACLE_SLOW_TESTS === "1";

describe("startWsServer keepalive (opt-in: set TENTACLE_SLOW_TESTS=1)", () => {
  // Bun's timers are native (uWS, 4 s ticks), so this is a real-socket test:
  // with `idleTimeoutSec: 1` a silent peer goes at ~8 s. Mutations: `sendPings:
  // false` → the healthy client is closed too; no `idleTimeout` → Bun's 120 s
  // default keeps the silent peer past the window.
  test.skipIf(!SLOW)(
    "a silent peer is closed and detached (TTL starts); an idle healthy client stays open",
    async () => {
      const host = new SessionHost({
        defaultCwd: "/tmp",
        createAgent: () => {
          const agent = new Agent({
            model: {
              id: "unused",
              async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
                yield { type: "done" };
              },
            },
            tools: new ToolRegistry(),
            env: {
              id: "noop",
              exec: () => Promise.reject(new Error("unused")),
              readFile: () => Promise.reject(new Error("unused")),
              writeFile: () => Promise.reject(new Error("unused")),
            },
          });
          return { agent, permissions: new PermissionBroker() };
        },
      });
      const audit: string[] = [];
      const server = startWsServer({
        host: "127.0.0.1",
        port: 0,
        sessionHost: host,
        idleTimeoutSec: 1,
        onAudit: (line) => audit.push(line),
      });
      const until = (cond: () => boolean, ms: number): Promise<void> =>
        new Promise((resolve, reject) => {
          const deadline = Date.now() + ms;
          const poll = (): void => {
            if (cond()) resolve();
            else if (Date.now() > deadline) reject(new Error(`timed out: ${String(cond)}`));
            else setTimeout(poll, 20);
          };
          poll();
        });
      const healthy = new WebSocket(server.url);
      let healthyClosed = false;
      healthy.onclose = () => {
        healthyClosed = true;
      };
      // Silent: completes the upgrade, opens a session, then never answers a ping.
      const healthyOpen = new Promise<void>((resolve) => {
        healthy.onopen = () => resolve();
      });
      const sock = connect(server.port, "127.0.0.1");
      const sockOpen = new Promise<void>((resolve) => sock.once("connect", () => resolve()));
      sock.on("data", () => {});
      try {
        await healthyOpen;
        await sockOpen;
        sock.write(
          "GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
        );
        const init = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
        sock.write(
          clientFrame(
            JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: init }),
          ),
        );
        sock.write(
          clientFrame(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              method: "session/open",
              params: { sessionId: "S", create: true },
            }),
          ),
        );
        await until(() => host.get("S")?.attachedCount === 1, 2000);
        const opened = Date.now();

        await until(() => audit.includes("connection-close"), 12_000);
        expect(Date.now() - opened).toBeLessThan(12_000);
        // Detached by the close → idle, so the reaper's clock is running.
        const liveness = host.get("S")?.liveness();
        expect(liveness).toMatchObject({ attached: 0, busy: false });

        // The healthy client outlives another full ping cycle.
        await new Promise((r) => setTimeout(r, 4500));
        expect(healthyClosed).toBe(false);
        expect(healthy.readyState).toBe(WebSocket.OPEN);
        expect(audit.filter((l) => l === "connection-close")).toHaveLength(1);
      } finally {
        healthy.close();
        sock.destroy();
        server.stop();
      }
    },
    25_000,
  );
});
