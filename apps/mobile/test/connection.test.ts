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
import { RemoteClient, type WebSocketCtor, webSocketChannelFactory } from "@tentacle/client";
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
import {
  APP_CLIENT_OPTIONS,
  clientErrorFields,
  openComputer,
  withDiagnostics,
} from "../src/connection.ts";
import { sha256Hex } from "../src/hash.ts";
import { createLinkDiagnoser } from "../src/link-diagnosis.ts";
import type { RNWebSocketCtor } from "../src/rn-websocket.ts";
import { rnWebSocketCtor } from "../src/rn-websocket.ts";

/** The serve's project (docs/feat/mobile-projects.md §2). */
const TEST_PROJECT = { key: "proj-0123456789ab", cwd: "/u/proj" };

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "e2e-token";
/** Canaries for the export test (F16): daemon-shaped prose a socket can really deliver. */
const PROMPT = "CANARY-PROMPT deploy the secret";
const TITLE = "CANARY-TITLE refactor the auth layer";
const COMPUTER = "CANARY-COMPUTER-MacBook";
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

function host(policy?: ImagePolicy, schedules = false): SessionHost {
  return new SessionHost({
    defaultCwd: CWD,
    ...(policy === undefined ? {} : { images: policy }),
    // `serve` and the worker pass this; a pod daemon never does (cron-tool D1).
    // Default limits, real timers: this harness only reads the table it produces.
    ...(schedules ? { schedules: {} } : {}),
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
  /** The daemon's own host: the test drives a session's table through it (cron-tool S6). */
  readonly sessions: SessionHost;
  stop(): void;
}

/**
 * A real daemon with the `/e2e` device route, a computer identity, and THIS
 * phone registered as a device — i.e. the state pairing leaves behind:
 * `computer.id` is the id of the key the app pinned, and the device key opens the
 * channel.
 */
function daemon(
  options: { readonly policy?: ImagePolicy; readonly schedules?: boolean } = {},
): Daemon {
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
    project: TEST_PROJECT,
    publicKey: publicKeyOf(PHONE_KEY),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) {
    throw new Error(added.reason);
  }
  const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
  const sessionHost = host(options.policy, options.schedules === true);
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost,
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
    sessions: sessionHost,
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

/**
 * A loopback `ws://…/e2e` URL nothing listens on: connecting is REFUSED at once,
 * which is the "this path is not there" failure (`opened: false`) a diagnosis is
 * fed. Bound and released, so the port is real but closed (no guess at a number).
 */
function freeLoopbackAddress(): string {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return `ws://127.0.0.1:${port}/e2e`;
}

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

  test("R6: the race dials the SECOND address when the first hangs, and the abandoned loser is NOT a diagnosis failure (mutation: observe in `abandon` → red; sequence → the second is never reached)", async () => {
    await withDaemon(async (d) => {
      const real = createLinkDiagnoser();
      // A SPY in front of the diagnoser: the property is not only the last verdict
      // (`dial()` calls `ok()` on success, which would hide anything) but that an
      // ABANDONED loser is never observed at all — it is a path that was not
      // needed, not a path that is down (mutation: observe in `abandon` → red).
      const observed: { readonly opened: boolean }[] = [];
      const diagnosis = {
        observe: (observation: Parameters<typeof real.observe>[0]) => {
          observed.push({ opened: observation.opened });
          return real.observe(observation);
        },
        ok: () => real.ok(),
        current: () => real.current(),
      };
      // A first address on a black hole: the TCP connection is accepted and the
      // upgrade never happens, which is what a LAN address looks like off-LAN.
      const hole = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { open() {}, data() {}, close() {} },
      });
      // A first address that REFUSES at once (a closed port): a genuine failed
      // open, which the diagnoser must be told about. It is what makes the
      // `opened: false` count below non-vacuous — the array is not merely empty
      // of ABANDONS, it does carry real failures.
      const refused = freeLoopbackAddress();
      const hanging = `ws://127.0.0.1:${hole.port}/e2e`;
      const computer: StoredComputer = {
        ...d.computer,
        addresses: [refused, hanging, d.computer.addresses[0] ?? ""],
      };
      const outcome = await openComputer(computer, {
        WebSocket: RNShapedWebSocket,
        random: systemRandomBytes,
        diagnosis,
      }).then(
        (link) => ({ ok: true as const, link }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        // REACHED at all is the property: under the old sequential loop the
        // black hole held the dial until the app's 15 s deadline.
        if (!outcome.ok) {
          throw outcome.error;
        }
        const link = outcome.link;
        expect(await link.client.sessionList()).toBeDefined();
        // The winner is the one the link names, and the verdict is `ok` — the
        // abandoned loser opened late and closed, which says nothing about
        // identity, so it must not appear as `unreachable` after the success.
        expect(link.address()).toBe(d.computer.addresses[0] ?? "");
        expect(link.diagnosis.current()).toBe("ok");
        // A genuine failed open IS reported (the refused port): so the array below
        // is not vacuous…
        expect(observed.filter((entry) => !entry.opened).length).toBe(1);
        // …and the hanging loser and any late one are NOT — a path that was not
        // needed says nothing about this computer's identity, and reporting it
        // would make a working link look `unreachable` (mutation: observe in
        // `abandon` → red; swallow a real failed open → red).
        await link.close();
      } finally {
        hole.stop(true);
      }
    });
  }, 30_000);

  test("R6: a loser that opens LATE is CLOSED, not left holding a socket (mutation: make `abandon` a no-op → red)", async () => {
    await withDaemon(async (d) => {
      // A "slow" daemon: it accepts the upgrade only when the test says so, so the
      // SECOND address (started by the 750 ms stagger) wins first and this one
      // arrives as the loser — exactly what a relay leg does when the direct path
      // answers a little after it.
      let acceptUpgrade: (() => void) | undefined;
      let closedCount = 0;
      // The diagnosis side of the same event: an abandoned loser must record
      // NOTHING (it is a path that was not needed, not one that is down), so a spy
      // in front of the real diagnoser counts the failed opens it was told about.
      const real = createLinkDiagnoser();
      const observed: { readonly opened: boolean }[] = [];
      const diagnosis = {
        observe: (observation: Parameters<typeof real.observe>[0]) => {
          observed.push({ opened: observation.opened });
          return real.observe(observation);
        },
        ok: () => real.ok(),
        current: () => real.current(),
      };
      const slow = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req, server) {
          // Hold the request: the test upgrades it later, so this path's socket
          // opens AFTER the other address has already won the race.
          acceptUpgrade = () => {
            server.upgrade(req, { data: {} });
          };
          return new Promise<Response>(() => {});
        },
        websocket: {
          message() {},
          close() {
            closedCount += 1;
          },
        },
      });
      const outcome = await openComputer(
        {
          ...d.computer,
          addresses: [`ws://127.0.0.1:${slow.port}/e2e`, d.computer.addresses[0] ?? ""],
        },
        { WebSocket: RNShapedWebSocket, random: systemRandomBytes, diagnosis },
      ).then(
        (link) => ({ ok: true as const, link }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      try {
        if (!outcome.ok) {
          throw outcome.error;
        }
        // The relay-side address answered first, so this path's socket was not
        // open yet (it was started, and holds the stagger)…
        expect(closedCount).toBe(0);
        // …and when it opens anyway, the winner is already handshaking: the late
        // path is CLOSED before any handshake. A socket left open is a stream and
        // a limiter slot nobody will use.
        acceptUpgrade?.();
        await Bun.sleep(200);
        expect(closedCount).toBe(1);
        // …and that close was SILENT: no failed-open observation for it
        // (mutation: observe in `abandon` → red).
        expect(observed.filter((entry) => !entry.opened)).toEqual([]);
        await outcome.link.close();
      } finally {
        slow.stop(true);
      }
    });
  }, 30_000);

  test("R6/review 1: a loser whose OPEN fails after the race was decided does NOT overwrite the verdict (mutation: observe in `open`'s catch → red)", async () => {
    await withDaemon(async (d) => {
      // The winner is the computer's own address, but with a STRANGER's device
      // key: the handshake is denied, which is authenticated → `revoked`, the one
      // verdict that offers Remove. A LAN address the phone is off-network holds
      // the first leg: it starts first and hangs, and its open rejects LATER, when
      // the race is long decided (a real TCP timeout, driven here by hand).
      const held: { terminate: () => void }[] = [];
      const hole = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(socket) {
            held.push(socket as unknown as { terminate: () => void });
          },
          data() {},
          close() {},
        },
      });
      const diagnosis = createLinkDiagnoser();
      const stranger: StoredComputer = {
        ...d.computer,
        deviceKey: encode(key(11)),
        addresses: [`ws://127.0.0.1:${hole.port}/e2e`, d.computer.addresses[0] ?? ""],
      };
      try {
        const caught = await openComputer(stranger, {
          WebSocket: RNShapedWebSocket,
          random: systemRandomBytes,
          diagnosis,
        }).catch((error: unknown) => error);
        // The authenticated verdict: the daemon refused this phone's key.
        expect((caught as { kind?: string }).kind).toBe("unauthorized");
        expect(diagnosis.current()).toBe("revoked");
        // The hanging leg's socket dies now — AFTER the race was decided. That is
        // a path that was not needed, not a computer that is down: reporting it
        // would turn an authenticated `revoked` into `unreachable`, and the row
        // would lose its Remove action.
        expect(held.length).toBe(1);
        held[0]?.terminate();
        await Bun.sleep(200);
        expect(diagnosis.current()).toBe("revoked");
      } finally {
        hole.stop(true);
      }
    });
  }, 30_000);

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

  test("a socket's canary close-reason and error text never reach the ring (F16)", () => {
    // The app's ONE wrapper, driven by a fake socket that hands it exactly the
    // daemon text a real one can (P4). Before the fix these went in as free
    // `detail` text, and `redact()` cannot tell prose from prose: a title or a
    // prompt fragment survived into the export (review round 1, finding 2).
    const log = createAppLog({ now: () => 1_700_000_000_000, capacity: 200 });
    const fired: Record<string, ((event: unknown) => void)[]> = {};
    class FakeSocket {
      addEventListener(type: string, listener: (event: unknown) => void): void {
        fired[type] = [...(fired[type] ?? []), listener];
      }
    }
    const Ctor = withDiagnostics(FakeSocket as unknown as WebSocketCtor, log);
    new (Ctor as unknown as new (url: string) => unknown)(
      `wss://example.local:8787/e2e?token=${TOKEN}`,
    );
    // What RN really delivers: a close with the peer's prose reason, an error
    // carrying the failing URL (a path, and the token query on iOS).
    for (const listener of fired.close ?? []) {
      listener({ code: 1006, reason: `${PROMPT} ${TITLE} ${COMPUTER}` });
    }
    for (const listener of fired.error ?? []) {
      listener({
        error: new Error(`WebSocket connection to 'wss://h:1/${TITLE}?token=${TOKEN}' failed`),
      });
    }
    const text = JSON.stringify(log.entries());
    for (const canary of [TOKEN, PROMPT, TITLE, COMPUTER, "token="]) {
      expect(text).not.toContain(canary);
    }
    // Non-vacuity: the entries exist and carry what IS allowed — the close code,
    // the error class, the dialled host (Owner Q8).
    expect(text).toContain('"dial"');
    expect(text).toContain('"code":1006');
    expect(text).toContain('"error":"Error"');
  });

  test("a client error logs its class and code, never the daemon's message (F16)", () => {
    // `RemoteClient.onError` carries an endpoint body, a malformed frame, or an
    // unknown mandatory update's daemon-supplied `type` — the exact channel a pod
    // controls. The fields must stay machine-readable (review round 1, finding 2).
    const plain = clientErrorFields(new Error(`${PROMPT} ${TITLE} ${COMPUTER}`));
    expect(plain).toEqual({ error: "Error" });
    const rpc = Object.assign(new Error(TITLE), { name: "RpcError", code: -32001 });
    expect(clientErrorFields(rpc)).toEqual({ error: "RpcError", code: -32001 });
    const text = JSON.stringify([plain, clientErrorFields(rpc)]);
    for (const canary of [PROMPT, TITLE, COMPUTER]) {
      expect(text).not.toContain(canary);
    }
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

/**
 * cron-tool S6: the phone trusts its daemon's own turns.
 *
 * THE LOAD-BEARING PROPERTY (docs/feat/cron-tool.md S6). `RemoteClient` drops
 * every `schedules` frame, every snapshot's table, every `turn_start.schedule`
 * ref and every delete when `daemonWakes` is off (`remote-client.ts:3500`,
 * `:3688`; `remote-session.ts:898`, `:1705`). So the app's ONE options set must
 * carry the bit, or no phone surface could ever see a wake — the section would
 * read `unsupported` over a daemon that schedules perfectly well.
 *
 * Proved END TO END over the app's own `openComputer` (not by asserting a
 * constant): the daemon really creates a wake and the phone really receives the
 * table and deletes through it.
 */
describe("scheduled wakes over the app's own link (cron-tool S6)", () => {
  /** Wait for a condition the daemon publishes asynchronously (no fixed sleep). */
  async function until(check: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`timed out waiting for ${label}`);
  }

  test("the app client sets daemonWakes (the one bit every wake surface hangs on)", () => {
    // `APP_CLIENT_OPTIONS` is what `openComputer` spreads into its `RemoteClient`.
    expect(APP_CLIENT_OPTIONS.daemonWakes).toBe(true);
  });

  test("a wake created daemon-side reaches the phone's table, and a delete removes it", async () => {
    const d = daemon({ schedules: true });
    const seeder = await seeded(d.url);
    const link = await open(d);
    try {
      // The session the app attaches to, made by THIS phone (its own handle).
      // Attached FIRST: a follow installed after the fact only sees later frames,
      // and the attach's own snapshot is the other door of the same table.
      const session = link.client.newSession(undefined, SESSION_ID, undefined, { attach: {} });
      await session.open();
      const seen: (readonly { id: string }[] | undefined)[] = [];
      const unsubscribe = session.onSchedules((report) => seen.push(report.rows));
      // The daemon creates the wake itself (the model's `schedule_create` path).
      const hosted = d.sessions.get(SESSION_ID);
      expect(hosted).toBeDefined();
      const link2 = hosted?.scheduleLink();
      expect(link2).not.toBeUndefined();
      const created = link2?.create({ prompt: "check CI on PR #412", every: "10m" });
      expect(created?.ok).toBe(true);
      await until(() => session.schedules?.length === 1, "the `schedules` frame");
      expect(session.schedules?.map((r) => r.id)).toEqual(["sc-1"]);
      expect(session.schedules?.[0]?.prompt).toBe("check CI on PR #412");
      expect(session.schedules?.[0]?.spec).toBe("every 10m");

      // The user's own handle deletes it through the app's client stack.
      const deleted = await session.deleteSchedule("sc-1");
      expect(deleted.deleted).toBe(true);
      await until(() => session.schedules?.length === 0, "the empty `schedules` frame");
      expect(session.schedules).toEqual([]);
      unsubscribe();
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      await link.close();
      await seeder.closeSessions();
      seeder.close();
      d.stop();
    }
  });

  test("a daemon that never schedules sends no table at all (never an empty list)", async () => {
    // A POD daemon's shape: no `schedules` option, so no `SnapshotResult.schedules`
    // and no frame — the phone's section must read `unsupported`, not "none left".
    await withDaemon(async (d) => {
      const seeder = await seeded(d.url);
      const link = await open(d);
      try {
        const session = link.client.newSession(undefined, SESSION_ID, undefined, { attach: {} });
        // `open()` is the resync read that folds `SnapshotResult.schedules`
        // (gated on the same bit): on a daemon that never schedules, nothing is
        // reported and nothing is claimed.
        await session.open();
        expect(session.schedules).toBeUndefined();
        // …and a delete is refused locally, with the client's own reason (no frame).
        const refused = await session.deleteSchedule("sc-1");
        expect(refused.deleted).toBe(false);
        expect(refused.reason).toBeTruthy();
      } finally {
        await link.close();
        await seeder.closeSessions();
        seeder.close();
      }
    });
  });
});
