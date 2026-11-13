/**
 * The `/e2e` device route (docs/feat/device-pairing.md 9b). REAL loopback
 * sockets, like the plan's Repro: the point of this slice is that a phone's
 * iOS-style `Origin` gets an authenticated connection on `/e2e` and 401 on the
 * plain route, that a revoke closes the live socket, and that a pairing
 * connection can do nothing but pair.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuplexChannel } from "@tentacle/transport";
import { RpcPeer } from "@tentacle/transport";
import { NoiseError, noiseInitiator, publicKeyOf, systemRandom } from "@tentacle/transport/noise";
import { DeviceAuthority, PAIRING_MAX_MESSAGE_BYTES } from "../src/device-authority.ts";
import {
  addDevice,
  loadOrCreateIdentity,
  openPairing,
  readIdentity,
  readSeen,
  removeDevices,
} from "../src/device-store.ts";
import type { HandshakeLimitOptions } from "../src/handshake-limit.ts";
import { SessionHost } from "../src/session-host.ts";
import { startWsServer } from "../src/ws-server.ts";

const dirs: string[] = [];
const servers: { stop(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const IOS_ORIGIN = "http://192.168.1.8:4001";

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

function store(): string {
  const configDir = mkdtempSync(join(tmpdir(), "ws-device-route-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  return configDir;
}

/** Dial a real WebSocket and adapt it to a `DuplexChannel` (the Repro's shape). */
function dial(
  url: string,
  headers: Record<string, string> = { Origin: IOS_ORIGIN },
  onSocketClose?: () => void,
): () => Promise<DuplexChannel> {
  return () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers } as never);
      let onMessage: ((d: string) => void) | undefined;
      let onClose: (() => void) | undefined;
      let opened = false;
      ws.addEventListener("message", (e) => onMessage?.(String(e.data)));
      ws.addEventListener("close", (e) => {
        // The SOCKET's own close, before any protocol layer can swallow it:
        // `RpcPeer` owns the channel's close handler once it is built.
        onSocketClose?.();
        onClose?.();
        if (!opened) reject(new Error(`closed ${e.code}`));
      });
      ws.addEventListener("open", () => {
        opened = true;
        resolve({
          send: (d) => ws.send(d),
          close: () => ws.close(),
          setOnMessage: (h) => {
            onMessage = h;
          },
          setOnClose: (h) => {
            onClose = h;
          },
        });
      });
      ws.addEventListener("error", () => reject(new Error("error")));
    });
}

interface Client {
  readonly peer: RpcPeer;
  readonly init: () => Promise<unknown>;
  readonly call: (method: string, params: unknown) => Promise<unknown>;
  readonly close: () => void;
}

/** A real device/pairing connection over the route. */
async function connect(
  url: string,
  privateKey: Uint8Array,
  remoteStatic: Uint8Array,
  onClose?: () => void,
): Promise<Client> {
  const raw = await dial(url, { Origin: IOS_ORIGIN }, onClose)();
  const secure = await noiseInitiator(raw, {
    staticKey: privateKey,
    remoteStatic,
    random: systemRandom,
  });
  const peer = new RpcPeer(secure, {
    onRequest: async () => {
      throw new Error("the daemon does not ask in these tests");
    },
    onNotification: () => {},
  });
  const init = (): Promise<unknown> =>
    peer.request("initialize", {
      protocolVersion: 24,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    });
  return {
    peer,
    init,
    call: (method, params) => peer.request(method, params),
    close: () => peer.close(),
  };
}

function serve(
  configDir: string,
  over: Partial<Parameters<typeof startWsServer>[0]> & {
    handshakeLimit?: HandshakeLimitOptions;
  } = {},
) {
  const { handshakeLimit, ...rest } = over;
  // ONE operator sink for both halves (the route's and the authority's own
  // lines: `device-revoked` is the authority's, `device-open` the route's).
  const audit: string[] = [];
  const authority = new DeviceAuthority({
    configDir,
    pollIntervalMs: 10,
    onAudit: (line) => audit.push(line),
  });
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: dummyHost,
    devices: { authority, ...(handshakeLimit ? { handshakeLimit } : {}) },
    onAudit: (line) => audit.push(line),
    ...rest,
  });
  servers.push(server);
  return { server, audit, authority, url: `${server.url}/e2e` };
}

describe("the device route authenticates by key, not by Origin", () => {
  test("a paired key with an iOS Origin gets a working initialize (RED on the plain route: 401)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    const { url } = serve(configDir);
    const client = await connect(url, key(2), identity.identity.publicKey);
    try {
      const result = (await client.init()) as { protocolVersion: number };
      expect(result.protocolVersion).toBe(24);
    } finally {
      client.close();
    }
  });

  test("the plain route still refuses an iOS Origin (F20, unchanged)", async () => {
    const configDir = store();
    const { server } = serve(configDir);
    const status = (
      await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Origin: IOS_ORIGIN } })
    ).status;
    expect(status).toBe(401);
  });

  test("an unknown key is denied, and a client sees it as `unauthorized` (F15)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const { url } = serve(configDir);
    // A DENY: authenticated by the daemon's static key, so it is terminal for
    // a client — `@tentacle/client/secure-channel` maps exactly this kind to
    // `unauthorized`, which is what makes a revoked phone say "removed from
    // this computer" instead of retrying forever (F7).
    const failure = await connect(url, key(9), identity.identity.publicKey).catch((e) => e);
    expect(failure).toBeInstanceOf(NoiseError);
    expect((failure as NoiseError).kind).toBe("denied");
  });

  test("a plain client on the SAME server is untouched: no handshake, today's Connection", async () => {
    // The route is chosen at the UPGRADE, never inferred in `open`: with the
    // device route on, a loopback plain client (the local CLI) must still get
    // a plain `Connection` with no Noise handshake. Mutation: branch on
    // `devices` in `open` instead of on the socket's route -> red (this client
    // would be pushed into the responder and hang).
    const configDir = store();
    const { server } = serve(configDir);
    const ws = new WebSocket(server.url);
    const replies: unknown[] = [];
    ws.onmessage = (event) => replies.push(JSON.parse(String(event.data)));
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    try {
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: 24,
            clientCapabilities: {},
            clientInfo: { name: "cli", version: "0" },
          },
        }),
      );
      const deadline = Date.now() + 3_000;
      while (replies.length === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(replies).toHaveLength(1);
      expect((replies[0] as { result: { protocolVersion: number } }).result.protocolVersion).toBe(
        24,
      );
    } finally {
      ws.close();
    }
  });

  test("without `devices`, `/e2e` is the PLAIN route (F21: a pod daemon has no device route)", async () => {
    const server = startWsServer({ host: "127.0.0.1", port: 0, sessionHost: dummyHost });
    servers.push(server);
    const status = (
      await fetch(`http://127.0.0.1:${server.port}/e2e`, { headers: { Origin: IOS_ORIGIN } })
    ).status;
    expect(status).toBe(401);
  });
});

describe("a pairing connection is pairing-only (F16)", () => {
  test("`session/list` on it is Unauthorized; `initialize` is allowed", async () => {
    // Mutation: skip the principal's method gate -> red.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    openPairing(configDir, { code: "K7M2QX9AB3", now: Date.now(), pid: process.pid });
    const { url } = serve(configDir);
    const client = await connect(url, key(9), identity.identity.publicKey);
    try {
      await client.init();
      await expect(client.call("session/list", {})).rejects.toMatchObject({
        code: -32001,
      });
    } finally {
      client.close();
    }
  });

  test("a frame over the pairing cap closes it (mutation: ignore the verdict cap -> red)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    openPairing(configDir, { code: "K7M2QX9AB3", now: Date.now(), pid: process.pid });
    const { url, audit } = serve(configDir);
    const raw = await dial(url)();
    const secure = await noiseInitiator(raw, {
      staticKey: key(9),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    let closed = false;
    secure.setOnClose(() => {
      closed = true;
    });
    secure.setOnMessage(() => {});
    // Over 64 KiB: refused by the reassembler, which closes the channel.
    secure.send("x".repeat(PAIRING_MAX_MESSAGE_BYTES + 1));
    const deadline = Date.now() + 3_000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(closed).toBe(true);
    expect(audit.some((l) => l.startsWith("e2e-violation"))).toBe(true);
  });
});

describe("revoke over a real socket", () => {
  test("a revoke closes the live connection within a tick, and its redial is denied (F7/F8)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const added = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      now: 2_000,
    });
    if (!added.ok) throw new Error(added.reason);
    const { url, audit } = serve(configDir);
    let closed = false;
    const client = await connect(url, key(2), identity.identity.publicKey, () => {
      closed = true;
    });
    await client.init();
    expect(closed).toBe(false);
    removeDevices(configDir, [added.device.id]);
    // "At once" = within one poll tick (the authority's, 10 ms here): the
    // socket is closed, so the live connection is gone.
    const deadline = Date.now() + 3_000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(audit).toContain(`device-revoked ${added.device.id.slice(0, 8)} closed=1`);
    expect(closed).toBe(true);
    // The redial is DENIED at the handshake (F8: a deny is terminal).
    const redial = await connect(url, key(2), identity.identity.publicKey).catch((e) => e);
    expect((redial as NoiseError).kind).toBe("denied");
  });

  test("a replayed Noise message 1 leaves `seen/` untouched (F4/P2)", async () => {
    // The property: `authorize` runs on EVERY message 1, replays included, so
    // nothing that records a success may live inside it. Mutation: call
    // `touchSeen` in `authorize` -> red (the replay would be "seen" without a
    // single authenticated frame).
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const added = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      now: 2_000,
    });
    if (!added.ok) throw new Error(added.reason);
    const { url, audit } = serve(configDir);
    // Capture message 1 off a real handshake, then replay it on a second socket
    // and never send the confirm.
    const captured: string[] = [];
    const tap = await dial(url, { Origin: IOS_ORIGIN })();
    const innerSend = tap.send.bind(tap);
    const tapped: DuplexChannel = {
      send: (d) => {
        captured.push(d);
        innerSend(d);
      },
      close: () => tap.close(),
      setOnMessage: (h) => tap.setOnMessage(h),
      setOnClose: (h) => tap.setOnClose(h),
    };
    // A COMPLETE first handshake: it is what legitimately records "seen".
    const secure = await noiseInitiator(tapped, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    expect(captured.length).toBeGreaterThan(0);
    // The first handshake was legitimately seen (it completed). The route's
    // `touchSeen` runs in the resolve's continuation, so give it a turn.
    await new Promise((r) => setTimeout(r, 100));
    const afterFirst = readSeen(configDir).get(added.device.id);
    if (afterFirst === undefined) throw new Error("the real handshake must be seen");
    secure.close();
    // Now REPLAY message 1 on a fresh socket and stop there.
    const replay = await dial(url, { Origin: IOS_ORIGIN })();
    replay.send(captured[0] as string);
    await new Promise((r) => setTimeout(r, 200));
    // The responder answered message 2 but built nothing: the "last seen"
    // timestamp is exactly what the real handshake set.
    expect(readSeen(configDir).get(added.device.id)).toBe(afterFirst);
    expect(audit.filter((l) => l.startsWith("device-open"))).toHaveLength(1);
  });

  test("the route touches `seen/<id>` on a successful resolve, never on a deny (F4/P2)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const added = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      now: 2_000,
    });
    if (!added.ok) throw new Error(added.reason);
    const { url } = serve(configDir);
    const client = await connect(url, key(2), identity.identity.publicKey);
    await client.init();
    expect(readSeen(configDir).get(added.device.id)).toBeDefined();
    client.close();
    // An unknown key never reaches a resolve, so nothing is recorded for it.
    await connect(url, key(9), identity.identity.publicKey).catch(() => {});
    expect(readSeen(configDir).size).toBe(1);
  });
});

describe("the upgrade is rate limited before any crypto (F6)", () => {
  test("past the burst, an upgrade from one address gets 429", async () => {
    const configDir = store();
    const { server } = serve(configDir, {
      handshakeLimit: { burst: 2, refillMs: 60_000, maxConcurrent: 100 },
    });
    const url = `http://127.0.0.1:${server.port}/e2e`;
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await fetch(url, { headers: { Origin: IOS_ORIGIN } })).status);
    }
    // The first two pass the limiter (426: no upgrade header), the rest 429.
    expect(statuses.slice(0, 2)).toEqual([426, 426]);
    expect(statuses.slice(2)).toEqual([429, 429]);
  });
});

describe("the bind rule (owner question 1)", () => {
  test("non-loopback + `devices` starts, and the plain route answers 401 to all", async () => {
    const configDir = store();
    const { server } = serve(configDir, { host: "0.0.0.0" });
    expect(server.url).toContain("0.0.0.0");
    expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(401);
    expect(
      (await fetch(`http://127.0.0.1:${server.port}/`, { headers: { Origin: IOS_ORIGIN } })).status,
    ).toBe(401);
  });

  test("non-loopback WITHOUT `devices` and without a token still throws (F26)", () => {
    expect(() => startWsServer({ host: "0.0.0.0", port: 0, sessionHost: dummyHost })).toThrow(
      /non-loopback/i,
    );
  });
});
