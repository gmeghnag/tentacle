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
import type { ImagePolicy } from "@tentacle/daemon";
import { SessionHost, startWsServer } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import type { ComputerRecord } from "../src/computers.ts";
import { APP_CLIENT_OPTIONS, openComputer } from "../src/connection.ts";
import { sha256Hex } from "../src/hash.ts";
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

function host(policy?: ImagePolicy): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    ...(policy === undefined ? {} : { images: policy }),
    createAgent: () => ({
      agent: new Agent({ model: new Echo(), tools: new ToolRegistry(), env: env as never }),
      permissions: new PermissionBroker(),
    }),
  });
}

async function withDaemon(
  token: string,
  run: (url: string, h: SessionHost) => Promise<void>,
  images?: ImagePolicy,
): Promise<void> {
  const h = host(images);
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

  /**
   * 13c's Repro 2, at the app's own boundary: the client `openComputer` builds
   * must carry a sha-256 that works where Bun is absent, or its first
   * `attachImage` throws before any frame.
   *
   * The assertion is the EXACT property (§2): an image goes out and its ref id
   * is the digest of its bytes. A link missing the option throws instead —
   * `remote-client.ts:1691-1702` — which is red here, not a weaker "a hasher is
   * configured somewhere".
   */
  test("attachImage over the app's own link: the ref id is the sha-256 of the bytes (mutation: drop APP_CLIENT_OPTIONS → red)", async () => {
    await withDaemon(
      "good",
      async (url) => {
        const link = await openComputer(record(url, "good"), { WebSocket: RNShapedWebSocket });
        try {
          const session = link.client.newSession(undefined, SESSION_ID);
          const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
          const ref = await session.attachImage(bytes, {
            mimeType: "image/png",
            name: "probe.png",
          });
          const oracle = new Bun.CryptoHasher("sha256");
          oracle.update(bytes);
          expect(ref).toEqual({
            id: oracle.digest("hex"),
            mimeType: "image/png",
            size: bytes.length,
            name: "probe.png",
          });
        } finally {
          await link.close();
        }
      },
      // The daemon must take image UPLOADS, exactly as `serve` does: images
      // off means the client refuses before the hasher is ever reached.
      { source: "store", maxBytes: 15 * 1024 * 1024 },
    );
  });

  test("the app's hasher IS the noble one, on every link (mutation: delete the option → red)", () => {
    // Beside the end-to-end proof above: ONE construction site, so a second
    // `new RemoteClient` in the app cannot ship without it. `APP_CLIENT_OPTIONS`
    // is what `openComputer` spreads into its options.
    expect(APP_CLIENT_OPTIONS.sha256Bytes).toBe(sha256Hex);
    expect(APP_CLIENT_OPTIONS.sha256Bytes(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * The mutation-proof half of the test above (AGENTS §9 non-vacuity).
   *
   * The digests are IDENTICAL on Bun — the default `bunSha256Bytes()` and this
   * app's noble one agree byte for byte (that is what `hash.test.ts` proves) —
   * so no assertion on an upload's result can tell the two apart. The property
   * that actually matters is "this hasher does not come from `globalThis.Bun`",
   * and on Bun identity is the only way to observe it. On Hermes the default is
   * `undefined` and the difference is a thrown `attachImage`, so this pins the
   * one code path where that default would be taken.
   */
  test("the client the app builds carries the noble hasher, NOT Bun's default (mutation: delete `...APP_CLIENT_OPTIONS` → red)", async () => {
    await withDaemon("good", async (url) => {
      const link = await openComputer(record(url, "good"), { WebSocket: RNShapedWebSocket });
      try {
        const wired = (link.client as unknown as { sha256Bytes?: unknown }).sha256Bytes;
        expect(wired).toBe(sha256Hex);
      } finally {
        await link.close();
      }
    });
  });
});
