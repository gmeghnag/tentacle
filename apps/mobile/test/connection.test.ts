/**
 * `openComputer` against a REAL in-process daemon (docs/feat/mobile-app-shell.md
 * "Tests"): the load-bearing property is that the app reaches `session/list`
 * through the unchanged `RemoteClient` stack over a WebSocket — no new
 * transport, no second session path (AGENTS §7).
 *
 * Bun's `WebSocket` is wrapped in an RN-shaped constructor (`(url, protocols,
 * options)`) so `rnWebSocketCtor`'s adapter is exercised exactly as the app's
 * would be. The pattern (SessionHost + startWsServer({port: 0, token})) is the
 * client tests' own (packages/client/test/ws-factory.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { webSocketChannelFactory } from "@tentacle/client";
import { RemoteClient } from "@tentacle/client";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import { SessionHost, startWsServer } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import type { ComputerRecord } from "../src/computers.ts";
import { openComputer } from "../src/connection.ts";
import type { RNWebSocketCtor } from "../src/rn-websocket.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CWD = "/tmp/mobile-app-shell";

const env = {
  id: "e",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

/** Enough model to finish a turn without a provider. */
class Echo implements ModelProvider {
  readonly id = "echo";
  async *stream(): AsyncIterable<{ type: "text"; delta: string } | { type: "done" }> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

/** RN's WebSocket signature: `(url, protocols?)`, not Bun's `(url, init)`. */
const RNShapedWebSocket = class {
  readonly #ws: WebSocket;
  constructor(url: string, protocols?: string | string[]) {
    this.#ws = new WebSocket(url, protocols);
  }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#ws.addEventListener(type, listener as never);
  }
  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#ws.removeEventListener(type, listener as never);
  }
  send(data: string): void {
    this.#ws.send(data);
  }
  close(code?: number, reason?: string): void {
    this.#ws.close(code, reason);
  }
} as unknown as RNWebSocketCtor;

function host(): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    createAgent: () => ({
      agent: new Agent({ model: new Echo(), tools: new ToolRegistry(), env: env as never }),
      permissions: new PermissionBroker(),
    }),
  });
}

async function withDaemon(
  token: string,
  run: (url: string, h: SessionHost) => Promise<void>,
): Promise<void> {
  const h = host();
  const server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: h, token });
  try {
    await run(server.url, h);
  } finally {
    server.stop();
  }
}

/** A second client (a laptop's) that seeds one session through the daemon. */
async function seeded(url: string, token: string): Promise<RemoteClient> {
  const factory = webSocketChannelFactory(url, { token });
  const client = new RemoteClient(await factory(), new PermissionBroker(), undefined, {
    channelFactory: factory,
  });
  await client.initialize();
  const session = client.newSession(undefined, SESSION_ID);
  for await (const _event of session.send("hi")) {
    // drain the turn: the session is then live, with one finished message
  }
  return client;
}

/** A plain second client over the real socket (a laptop's). */
async function dialTo(url: string, token: string): Promise<RemoteClient> {
  const factory = webSocketChannelFactory(url, { token });
  const client = new RemoteClient(await factory(), new PermissionBroker(), undefined, {
    channelFactory: factory,
  });
  await client.initialize();
  return client;
}

function record(url: string, token: string): ComputerRecord {
  return { id: "dev", name: "e2e-mac", url, token };
}

describe("openComputer over a real daemon", () => {
  test("initialize + sessionList reach the daemon through the one client stack", async () => {
    await withDaemon("good", async (url) => {
      const seeder = await seeded(url, "good");
      const link = await openComputer(record(url, "good"), { WebSocket: RNShapedWebSocket });
      try {
        expect(link.init.protocolVersion).toBeGreaterThan(0);
        const page = await link.client.sessionList();
        expect(page.sessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
        expect(page.sessions[0]?.cwd).toBe(CWD);
        expect(page.sessions[0]?.archived).toBe(false);
      } finally {
        await link.close();
        await seeder.closeSessions();
        seeder.close();
      }
    });
  });

  test("a wrong token rejects the dial (the app then shows 'Can't connect')", async () => {
    await withDaemon("good", async (url) => {
      const caught = await openComputer(record(url, "wrong"), {
        WebSocket: RNShapedWebSocket,
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("ChannelError");
    });
  });

  test("the client's broker HOLDS with no requester, never denying on its own (mutation: denyAll → red)", async () => {
    await withDaemon("good", async (url) => {
      const link = await openComputer(record(url, "good"), { WebSocket: RNShapedWebSocket });
      try {
        // The ONE broker lives behind RemoteClient (AGENTS §7 single broker) and
        // is exposed on the link: what the session screen sets its sheet on.
        expect(link.permissions).toBeInstanceOf(PermissionBroker);
        const broker = (link.client as unknown as { permissions: PermissionBroker }).permissions;
        expect(broker).toBe(link.permissions); // the same instance, not a copy
        let answered = false;
        const pending = broker
          .request({
            id: "r1",
            kind: "command",
            command: "rm -rf /",
          } as never)
          .then((answer) => {
            answered = true;
            return answer;
          });
        // Give a deny broker every chance to answer: it must NOT (11a's denyAll
        // answered a "No" nobody gave — the plan's Repro 2).
        await Bun.sleep(50);
        expect(answered).toBe(false);
        // The sheet mounts: the held request is delivered to its requester.
        const asked: string[] = [];
        link.permissions.setRequester(async (req) => {
          asked.push((req as unknown as { id: string }).id);
          return { allowed: true };
        });
        expect(await pending).toEqual({ allowed: true });
        expect(asked).toEqual(["r1"]);
      } finally {
        await link.close();
      }
    });
  });

  test("link.close() leaves without a session/close: as the last client it does not end the session (mutation: closeSessions() → red)", async () => {
    await withDaemon("good", async (url, h) => {
      const seeder = await seeded(url, "good");
      const link = await openComputer(record(url, "good"), { WebSocket: RNShapedWebSocket });
      const session = link.client.newSession(undefined, SESSION_ID, undefined, { attach: {} });
      await session.open();
      const live = h.get(SESSION_ID);
      if (live === undefined) throw new Error("the session is not live");
      expect(live.attachedCount).toBe(2);
      // The laptop (the seeder) leaves first, so the phone is the LAST attached
      // client — exactly the case where 11a's `closeSessions()` ended the
      // session (Hazard 3 / decision 4).
      await seeder.drain();
      seeder.close();
      await Bun.sleep(50);
      expect(live.attachedCount).toBe(1);
      // The app's exit path.
      await link.close();
      await Bun.sleep(50);
      // Still live daemon-side: `drain()` + `close()` detached it, never closed it.
      expect(h.get(SESSION_ID)).toBeDefined();
      expect(h.get(SESSION_ID)?.attachedCount).toBe(0);
      // The session is observably usable to a fresh client (a reopen/attach of
      // the SAME id finds it live, not archived).
      const observer = await dialTo(url, "good");
      const page = await observer.sessionList({ limit: 10 });
      const entry = page.sessions.find((s) => s.sessionId === SESSION_ID);
      expect(entry?.archived).toBe(false);
      expect(entry?.attached).toBe(0);
      observer.close();
    });
  });

  test("onStatus subscribes and unsubscribes; after close the client no longer calls out", async () => {
    await withDaemon("good", async (url) => {
      const link = await openComputer(record(url, "good"), { WebSocket: RNShapedWebSocket });
      const states: string[] = [];
      const off = link.onStatus((status) => states.push(status.state));
      expect(typeof off).toBe("function");
      off();
      expect(states).toEqual([]); // nothing pushed synchronously; nothing leaked
      await link.close();
      const after = await link.client.sessionList().catch((error: unknown) => error);
      expect(after).toBeInstanceOf(Error);
    });
  });
});
