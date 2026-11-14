/**
 * `openComputer` against a REAL in-process daemon (docs/feat/mobile-app-shell.md
 * "Tests"; the `/e2e` route is docs/feat/mobile-pairing-screen.md 11b.1): the
 * load-bearing property is that the app reaches `session/list` through the
 * unchanged `RemoteClient` stack — no new transport, no second session path
 * (AGENTS §7) — now over an AUTHENTICATED Noise channel, with the device key this
 * phone stored at pairing and the computer key it pinned.
 *
 * Bun's `WebSocket` is wrapped in an RN-shaped constructor (`(url, protocols,
 * options)`) so `rnWebSocketCtor`'s adapter is exercised exactly as the app's
 * would be, and it sends an iOS-style `Origin` (the `/e2e` route's whole reason
 * to exist). The daemon-side pattern (SessionHost + startWsServer) is the client
 * tests' own (`packages/client/test/pairing.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { ChannelError } from "@tentacle/client";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import {
  DeviceAuthority,
  type ImagePolicy,
  SessionHost,
  addDevice,
  deviceIdOf,
  loadOrCreateIdentity,
  startWsServer,
} from "@tentacle/daemon";
import { encodeBase64Url as encode } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { publicKeyOf } from "@tentacle/transport/noise";
import { createAppLog } from "../src/app-log.ts";
import type { SecureKV } from "../src/computer-store.ts";
import { createComputerStore } from "../src/computer-store.ts";
import type { StoredComputer } from "../src/computers.ts";
import { APP_CLIENT_OPTIONS, openComputer } from "../src/connection.ts";
import { sha256Hex } from "../src/hash.ts";
import { createLinkDiagnoser } from "../src/link-diagnosis.ts";
import type { RNWebSocketCtor } from "../src/rn-websocket.ts";
import { rnWebSocketCtor } from "../src/rn-websocket.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "e2e-token";
const IOS_ORIGIN = "http://192.168.1.8:4001";
const CWD = tmpdir();

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

/** RN's WebSocket signature `(url, protocols?, options?)`, with iOS's `Origin` on every dial. */
const RNShapedWebSocket = class {
  readonly #ws: WebSocket;
  constructor(url: string, protocols?: string | string[], options?: unknown) {
    const { headers } = (options ?? {}) as { headers?: Record<string, string> };
    this.#ws = new WebSocket(url, {
      protocols,
      headers: { Origin: IOS_ORIGIN, ...headers },
    } as never);
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

/** The app's constructor: RN's shape behind `rnWebSocketCtor` (as `App.tsx` wires it). */
const Ctor = rnWebSocketCtor(RNShapedWebSocket);

/** A deterministic 32-byte key, so the pin and the registry agree. */
const key = (fill: number) => new Uint8Array(32).fill(fill);
const PHONE_KEY = key(7);

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

interface Daemon {
  readonly url: string;
  /** The stored computer, exactly what pairing would have written (P3). */
  readonly computer: StoredComputer;
  stop(): void;
}

/**
 * A real daemon with the `/e2e` device route, a computer identity, and THIS
 * phone registered as a device — i.e. the state pairing leaves behind:
 * `computer.id` is the id of the key the app pinned, and the device key opens the
 * channel.
 */
function daemon(options: { readonly policy?: ImagePolicy } = {}): Daemon {
  const configDir = mkdtempSync(join(tmpdir(), "mobile-connection-"));
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(9),
  });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  // The registry holds the device's PUBLIC key (what pairing's claim carries):
  // the handshake authenticates us by the public half of our stored private key.
  const added = addDevice(configDir, {
    publicKey: publicKeyOf(PHONE_KEY),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) {
    throw new Error(added.reason);
  }
  const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: host(options.policy),
    devices: { authority, pairingCheckMs: 20 },
    token: TOKEN,
  });
  const computer: StoredComputer = {
    id: deviceIdOf(created.identity.publicKey),
    name: created.identity.name,
    computerKey: encode(created.identity.publicKey),
    addresses: [`${server.url}/e2e`],
    deviceName: "iPhone",
    pairedAt: 2_000,
    deviceKey: encode(PHONE_KEY),
  };
  return {
    url: `${server.url}/e2e`,
    computer,
    stop: () => {
      server.stop();
      authority.stop();
      rmSync(configDir, { recursive: true, force: true });
    },
  };
}

const open = (d: Daemon, log?: ReturnType<typeof createAppLog>): ReturnType<typeof openComputer> =>
  openComputer(d.computer, {
    WebSocket: RNShapedWebSocket,
    random: systemRandomBytes,
    ...(log === undefined ? {} : { log }),
  });

/** `expo-crypto`'s job on the phone; Bun's CSPRNG stands in here. */
function systemRandomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

async function withDaemon(run: (d: Daemon) => Promise<void>, policy?: ImagePolicy): Promise<void> {
  const d = daemon(policy === undefined ? {} : { policy });
  try {
    await run(d);
  } finally {
    d.stop();
  }
}

/** A laptop client on the token route (the harness's own path): it seeds sessions. */
async function seeded(url: string): Promise<RemoteClient> {
  const plain = `ws://${new URL(url).host}/`;
  const factory = webSocketChannelFactory(plain, { token: TOKEN });
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

describe("openComputer over /e2e", () => {
  test("initialize + sessionList reach the daemon through the one client stack", async () => {
    await withDaemon(async (d) => {
      const seeder = await seeded(d.url);
      const link = await open(d);
      try {
        expect(link.init.protocolVersion).toBeGreaterThan(0);
        const page = await link.client.sessionList();
        expect(page.sessions.map((s) => s.sessionId)).toEqual([SESSION_ID]);
        expect(page.sessions[0]?.cwd).toBe(CWD);
        expect(page.sessions[0]?.archived).toBe(false);
        // The link knows which address answered, and the verdict is `ok`.
        expect(link.address()).toBe(d.computer.addresses[0] ?? "");
        expect(link.diagnosis.current()).toBe("ok");
      } finally {
        await link.close();
        await seeder.closeSessions();
        seeder.close();
      }
    });
  });

  test("a dial that SUCCEEDS resets the diagnosis the link was given (mutation: delete `diagnosis.ok()` → red)", async () => {
    await withDaemon(async (d) => {
      // ONE diagnoser per computer, carried across mounts (what `App.tsx` keeps):
      // it arrives with a two-attempt streak from earlier failures.
      const diagnosis = createLinkDiagnoser();
      diagnosis.observe({ opened: true, error: new ChannelError("unreachable", "closed") });
      diagnosis.observe({ opened: true, error: new ChannelError("unreachable", "closed") });
      expect(diagnosis.current()).toBe("unreachable");
      const link = await openComputer(d.computer, {
        WebSocket: RNShapedWebSocket,
        random: systemRandomBytes,
        diagnosis,
      });
      try {
        // The link IS that diagnoser (no second one silently decoupled from it),
        // and reaching the daemon is the success F11 says resets the count.
        expect(link.diagnosis).toBe(diagnosis);
        expect(link.diagnosis.current()).toBe("ok");
        // Not just the verdict: the STREAK is gone, so one later failure is not
        // a false "may have been reset" (the third attempt in a row).
        expect(
          diagnosis.observe({ opened: true, error: new ChannelError("unreachable", "closed") }),
        ).toBe("unreachable");
      } finally {
        await link.close();
      }
    });
  });

  test("a device key the computer does not know rejects the handshake (mutation: no Noise initiator → red)", async () => {
    await withDaemon(async (d) => {
      // A stranger's key with the right pinned computer key: the daemon denies
      // (message 2), which is authenticated — so the app can say `revoked`.
      const stranger: StoredComputer = { ...d.computer, deviceKey: encode(key(11)) };
      const caught = await openComputer(stranger, {
        WebSocket: RNShapedWebSocket,
        random: systemRandomBytes,
      }).catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe("ChannelError");
      expect((caught as { kind?: string }).kind).toBe("unauthorized");
    });
  });

  test("an unreadable stored key is a record error, not a silent empty key", async () => {
    await withDaemon(async (d) => {
      const broken: StoredComputer = { ...d.computer, deviceKey: "not-a-key" };
      const caught = await openComputer(broken, {
        WebSocket: RNShapedWebSocket,
        random: systemRandomBytes,
      }).catch((error: unknown) => error);
      expect((caught as Error).name).toBe("ComputerRecordError");
      expect((caught as Error).message).toContain("pair again");
    });
  });

  test("the client's broker HOLDS with no requester, never denying on its own (mutation: denyAll → red)", async () => {
    await withDaemon(async (d) => {
      const link = await open(d);
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
    await withDaemon(async (d) => {
      const seeder = await seeded(d.url);
      const link = await open(d);
      const session = link.client.newSession(undefined, SESSION_ID, undefined, { attach: {} });
      await session.open();
      // The laptop (the seeder) leaves first, so the phone is the LAST attached
      // client — exactly the case where 11a's `closeSessions()` ended the
      // session (Hazard 3 / decision 4).
      await seeder.drain();
      seeder.close();
      await Bun.sleep(50);
      // The app's exit path.
      await link.close();
      await Bun.sleep(50);
      // Still live daemon-side: `drain()` + `close()` detached it, never closed it.
      const observer = new RemoteClient(
        await webSocketChannelFactory(`ws://${new URL(d.url).host}/`, { token: TOKEN })(),
        new PermissionBroker(),
        undefined,
        {
          channelFactory: webSocketChannelFactory(`ws://${new URL(d.url).host}/`, {
            token: TOKEN,
          }),
        },
      );
      await observer.initialize();
      const page = await observer.sessionList({ limit: 10 });
      const entry = page.sessions.find((s) => s.sessionId === SESSION_ID);
      expect(entry?.archived).toBe(false);
      expect(entry?.attached).toBe(0);
      observer.close();
    });
  });

  test("onStatus subscribes and unsubscribes; after close the client no longer calls out", async () => {
    await withDaemon(async (d) => {
      const link = await open(d);
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
      async (d) => {
        const link = await open(d);
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
      }, // The daemon must take image UPLOADS, exactly as `serve` does: images
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
   * The digests are IDENTICAL on Bun — the default and this app's noble one agree
   * byte for byte (that is what `hash.test.ts` proves) — so no assertion on an
   * upload's result can tell the two apart. The property that actually matters is
   * "this hasher does not come from `globalThis.Bun`", and on Bun identity is the
   * only way to observe it. On Hermes the default is `undefined` and the
   * difference is a thrown `attachImage`, so this pins the one code path where
   * that default would be taken.
   */
  test("the client the app builds carries the noble hasher, NOT Bun's default (mutation: delete `...APP_CLIENT_OPTIONS` → red)", async () => {
    await withDaemon(async (d) => {
      const link = await open(d);
      try {
        const wired = (link.client as unknown as { sha256Bytes?: unknown }).sha256Bytes;
        expect(wired).toBe(sha256Hex);
      } finally {
        await link.close();
      }
    });
  });

  test("the store the app reads is what openComputer dials: id, key and addresses come from it", async () => {
    await withDaemon(async (d) => {
      // The end-to-end shape of 11b.1's seam: a Keychain store → a link.
      const items = new Map<string, string>();
      const kv: SecureKV = {
        async get(key) {
          return items.get(key) ?? null;
        },
        async set(key, value) {
          items.set(key, value);
        },
        async delete(key) {
          items.delete(key);
        },
      };
      const store = createComputerStore({ kv, keychainAccessible: 1 });
      await store.add(
        {
          id: d.computer.id,
          name: d.computer.name,
          computerKey: d.computer.computerKey,
          addresses: d.computer.addresses,
          deviceName: d.computer.deviceName,
          pairedAt: d.computer.pairedAt,
        },
        d.computer.deviceKey,
      );
      const stored = await store.get(d.computer.id);
      if (stored === undefined) {
        throw new Error("the store lost the computer");
      }
      const link = await openComputer(stored, {
        WebSocket: RNShapedWebSocket,
        random: systemRandomBytes,
      });
      try {
        const page = await link.client.sessionList();
        expect(Array.isArray(page.sessions)).toBe(true);
      } finally {
        await link.close();
      }
    });
  });
});

describe("the socket diagnostics reach the injected sink (docs/feat/mobile-lock.md D7)", () => {
  test("a dial logs its HOST only, never the URL (mutation: log the raw url → red)", async () => {
    await withDaemon(async (d) => {
      const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
      const link = await open(d, log);
      try {
        const dials = log.entries().filter((entry) => entry.kind === "dial");
        expect(dials.length).toBeGreaterThan(0);
        // The `/e2e` URL is host:port; the entry is typed, with the host as a field.
        const host = new URL(d.computer.addresses[0] ?? "").host;
        expect(dials[0]?.fields.host).toBe(host);
        // Nothing in the whole ring holds a `?token=` (there is none on /e2e) or
        // a full dialled URL: `url` is never a field.
        const text = JSON.stringify(log.entries());
        expect(text).not.toContain("?token=");
        expect(text).not.toContain("ws://");
      } finally {
        await link.close();
      }
    });
  });

  test("no console.log is left on the link's path (mutation: restore it → red)", async () => {
    // The app's one log line used to be `console.log('[tentacle] …')` and was
    // lost. A spy proves nothing writes to the console any more.
    const written: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      written.push(args.map(String).join(" "));
    };
    try {
      await withDaemon(async (d) => {
        const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
        const link = await open(d, log);
        try {
          await link.client.sessionList();
        } finally {
          await link.close();
        }
      });
    } finally {
      console.log = original;
    }
    expect(written.filter((line) => line.includes("[tentacle]"))).toEqual([]);
  });

  test("a link built with NO sink still works (the module-private ring), and never throws", async () => {
    await withDaemon(async (d) => {
      const seeder = await seeded(d.url);
      const link = await open(d);
      try {
        expect(Array.isArray((await link.client.sessionList()).sessions)).toBe(true);
      } finally {
        await link.close();
        await seeder.closeSessions();
        seeder.close();
      }
    });
  });
});
