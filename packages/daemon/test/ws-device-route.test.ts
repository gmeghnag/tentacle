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
  closePairing,
  deviceIdOf,
  loadOrCreateIdentity,
  openPairing,
  readClaim,
  readIdentity,
  readSeen,
  removeDevices,
  writePairingDecision,
} from "../src/device-store.ts";
import type { HandshakeLimitOptions } from "../src/handshake-limit.ts";
import { PAIRING_POLL_MS } from "../src/pairing-handler.ts";
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

/** A config dir with NO identity yet: the F14 window, where nothing authenticates. */
function emptyStore(): string {
  const configDir = mkdtempSync(join(tmpdir(), "ws-device-route-empty-"));
  dirs.push(configDir);
  return configDir;
}

/** Wait for `check` (the authority's poll is the only thing that re-reads the store). */
async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
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
    pairingCheckMs?: number;
  } = {},
) {
  const { handshakeLimit, pairingCheckMs, ...rest } = over;
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
    devices: {
      authority,
      ...(handshakeLimit ? { handshakeLimit } : {}),
      ...(pairingCheckMs !== undefined ? { pairingCheckMs } : {}),
    },
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

  test("a no-identity window gives every handshake slot back, so the route recovers (F14)", async () => {
    // The store is unreadable/absent: `staticKey()` is `undefined`, so the
    // socket can never authenticate and the route closes it at once. Each such
    // dial must END its limiter slot, or `maxConcurrent` dials during any F14
    // window brick `/e2e` with 429s until a restart — even after the human
    // fixes the store. Mutation: drop the no-identity path's `limiter.end()`.
    const configDir = emptyStore();
    const { server, authority } = serve(configDir, {
      handshakeLimit: { burst: 100, refillMs: 60_000, maxConcurrent: 2 },
    });
    const url = `${server.url}/e2e`;
    // Well past `maxConcurrent` (2): no slot is ever held long enough to matter.
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      outcomes.push(
        await new Promise<string>((resolve) => {
          const ws = new WebSocket(url, { headers: { Origin: IOS_ORIGIN } } as never);
          ws.addEventListener("close", () => resolve("closed"));
          // A 429 refuses the upgrade: the client only sees an error.
          ws.addEventListener("error", () => resolve("refused"));
        }),
      );
    }
    // Every dial was ADMITTED and then closed for its own reason (no identity).
    expect(outcomes).toEqual(["closed", "closed", "closed", "closed", "closed"]);
    // The human fixes the store: the very next handshake is admitted, with no
    // restart and no leftover 429.
    const created = loadOrCreateIdentity(configDir, { name: "gabriel-mac", now: 1_000 });
    if (!created.ok) throw new Error(created.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    await until(() => authority.staticKey() !== undefined);
    const client = await connect(url, key(2), created.identity.publicKey);
    try {
      const result = (await client.init()) as { protocolVersion: number };
      expect(result.protocolVersion).toBe(24);
    } finally {
      client.close();
    }
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

describe("a pairing connection ends with its window (9c)", () => {
  /**
   * A pairing connection is admitted only while a window is open, so it must
   * NOT outlive it (F16): `pair`'s exit handler removes the window, and the
   * worst case (a `pair` killed -9) is the window's own expiry. The route polls
   * the store, so either way the socket goes.
   */
  test("closing the window closes the pairing connection (mutation: drop the watcher → red)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const opened = openPairing(configDir, {
      code: "K7M2QX9AB3",
      now: Date.now(),
      pid: process.pid,
    });
    if (!opened.ok) throw new Error(opened.reason);
    const audit: string[] = [];
    const authority = new DeviceAuthority({
      configDir,
      pollIntervalMs: 10,
      onAudit: (l) => audit.push(l),
    });
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: dummyHost,
      devices: { authority, pairingCheckMs: 20 },
      onAudit: (l) => audit.push(l),
    });
    servers.push(server);
    let closed = false;
    const client = await connect(`${server.url}/e2e`, key(9), identity.identity.publicKey, () => {
      closed = true;
    });
    await client.init();
    // Close the window the way `pair`'s exit handler does: the connection must
    // go with it (its own socket `close` fires — a refused request would not,
    // because a pairing connection is refused EVERY method but device/pair).
    closePairing(configDir, opened.session.sid);
    const deadline = Date.now() + 3_000;
    while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(true);
    expect(audit).toContain("pairing-closed");
    client.close();
  });

  test("a window that goes away right after the human's `y` still answers SUCCESS (F3)", async () => {
    // F3's real shape: `pair` writes the registry and then removes its window on
    // exit, so the winning exchange's last moments have NO live window while the
    // daemon is still answering. The route's watcher (every 20 ms here) must not
    // close a connection that holds a claim — the handler (polling at its own
    // 100 ms) reads the REGISTRY first and answers success. Mutation: drop the
    // `holdingClaim` skip -> the socket closes first and the client sees a
    // dropped connection for a device that IS registered (measured: ~2/40 at the
    // 1 s default, i.e. every time once the watcher is faster than the poll).
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const opened = openPairing(configDir, {
      code: "K7M2QX9AB3",
      now: Date.now(),
      pid: process.pid,
    });
    if (!opened.ok) throw new Error(opened.reason);
    // The watcher ticks FASTER than the handler's poll (100 ms by default), so
    // the race this test pins is the one production has at 1 s vs 100 ms.
    const { url } = serve(configDir, { pairingCheckMs: PAIRING_POLL_MS / 5 });
    const deviceKeyPublic = publicKeyOf(key(7));
    const client = await connect(url, key(7), identity.identity.publicKey);
    try {
      await client.init();
      const request = client
        .call("device/pair", { code: "K7M2QX9AB3", name: "iPhone di Gabriel" })
        .catch((e: unknown) => e as Error);
      // The human's `y`, exactly as `pair` orders it: registry FIRST…
      await until(() => readClaim(configDir, opened.session.sid) !== undefined, 3_000);
      addDevice(configDir, { publicKey: deviceKeyPublic, name: "iPhone di Gabriel", now: 2_000 });
      writePairingDecision(configDir, opened.session.sid, true);
      // …and then `pair` exits, cleaning the window up (its exit handler).
      closePairing(configDir, opened.session.sid);
      const answer = (await request) as { deviceId?: string } & Error;
      expect(answer).not.toBeInstanceOf(Error);
      expect(answer.deviceId).toBe(deviceIdOf(deviceKeyPublic));
    } finally {
      client.close();
    }
  });

  test("`device/pair` on a DEVICE connection is `already_paired` (PairingRefused)", async () => {
    // A paired phone is not a pairing connection: its privilege was fixed at
    // the handshake, and re-pairing is a new key or `devices revoke`.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    const { url } = serve(configDir);
    const client = await connect(url, key(2), identity.identity.publicKey);
    try {
      await client.init();
      // `.catch` rather than `expect(...).rejects`: the pairing gate's error must
      // arrive as a `PairingRefused` RpcError with its reason, and reading it
      // out explicitly keeps the assertion on the DATA (Bun's `rejects` on a
      // long-lived peer can observe the later "connection closed" instead).
      const failure = (await client
        .call("device/pair", {
          code: "K7M2QX9AB3",
          name: "iPhone",
        })
        .catch((e) => e)) as { code: number; data?: unknown };
      expect(failure.code).toBe(-32017);
      expect(failure.data).toEqual({ reason: "already_paired" });
    } finally {
      client.close();
    }
  });

  test("a pairing connection still cannot reach a session method (the 9b gate holds)", async () => {
    // 9c adds `device/pair` to the pairing principal's allowed set. Everything
    // else must stay refused, or the exchange would have widened the privilege.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    openPairing(configDir, { code: "K7M2QX9AB3", now: Date.now(), pid: process.pid });
    const { url } = serve(configDir);
    const client = await connect(url, key(9), identity.identity.publicKey);
    try {
      await client.init();
      for (const method of ["session/list", "session/open", "daemon/session_ttl"]) {
        await expect(client.call(method, {})).rejects.toMatchObject({ code: -32001 });
      }
    } finally {
      client.close();
    }
  });
});

describe("a pairing held open does not serialise the daemon (§7)", () => {
  test("while `device/pair` waits on the human, another connection's `session/list` is answered", async () => {
    // The invariant: `RpcPeer` dispatches inbound requests concurrently, so a
    // `device/pair` held for the human's `y` must not block anything else —
    // including the daemon's own other work on ANOTHER connection. Mutation:
    // serialise `Connection`'s handler (an await/lock around dispatch) -> the
    // `session/list` below would only be answered once pairing finished.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    openPairing(configDir, { code: "K7M2QX9AB3", now: Date.now(), pid: process.pid });
    const { server } = serve(configDir);
    const pairing = await connect(`${server.url}/e2e`, key(9), identity.identity.publicKey);
    const device = await connect(`${server.url}/e2e`, key(2), identity.identity.publicKey);
    try {
      await pairing.init();
      await device.init();
      // The pairing request is STARTED and deliberately never answered: no
      // claim is accepted and no window is closed, so the handler is parked in
      // its wait for the whole test.
      let pairingSettled = false;
      const pending = pairing
        .call("device/pair", { code: "K7M2QX9AB3", name: "iPhone" })
        .finally(() => {
          pairingSettled = true;
        });
      pending.catch(() => {});
      // The OTHER connection is served meanwhile: this is the property.
      const started = Date.now();
      const list = (await device.call("session/list", {})) as { sessions: unknown[] };
      expect(Array.isArray(list.sessions)).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(pairingSettled).toBe(false);
      pairing.close();
      await pending.catch(() => {});
    } finally {
      pairing.close();
      device.close();
    }
  });
});

describe("the attempt cap over a real socket (F6/F16)", () => {
  test("five wrong codes answer `too_many_attempts` and then close the connection", async () => {
    // The cap's teeth are on the SOCKET (the handler is per connection): a
    // hostile peer during a window gets five guesses and is then gone, so it
    // cannot grind a 50-bit code on one connection.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    openPairing(configDir, { code: "K7M2QX9AB3", now: Date.now(), pid: process.pid });
    const { url } = serve(configDir);
    let socketClosed = false;
    const client = await connect(url, key(9), identity.identity.publicKey, () => {
      socketClosed = true;
    });
    async function refusal(): Promise<{ code: number; data?: unknown }> {
      const raw = await client
        .call("device/pair", { code: "ZZZZZZZZZZ", name: "attacker" })
        .catch((e: unknown) => e);
      return raw as { code: number; data?: unknown };
    }
    try {
      await client.init();
      for (let i = 1; i <= 4; i++) {
        const answer = await refusal();
        expect(answer.code).toBe(-32017);
        expect(answer.data).toEqual({ reason: "invalid_code" });
      }
      const fifth = await refusal();
      expect(fifth.code).toBe(-32017);
      expect(fifth.data).toEqual({ reason: "too_many_attempts" });
      // The refusal frame goes out FIRST, then the socket is closed.
      const deadline = Date.now() + 3_000;
      while (!socketClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(socketClosed).toBe(true);
    } finally {
      client.close();
    }
  });

  test("requests PIPELINED past the cap cannot spend the window (F6/F16)", async () => {
    // `RpcPeer` dispatches inbound requests CONCURRENTLY (§7) and the cap's
    // close is a macrotask, so a peer that fires eight wrong codes and then the
    // right one, without awaiting, has them all in flight before the close.
    // Mutation: drop the handler's entry check -> the 9th request claims the
    // window (the 5-guesses-per-connection promise gone).
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const opened = openPairing(configDir, {
      code: "K7M2QX9AB3",
      now: Date.now(),
      pid: process.pid,
    });
    if (!opened.ok) throw new Error(opened.reason);
    const { url } = serve(configDir);
    const client = await connect(url, key(9), identity.identity.publicKey);
    const calls: Promise<unknown>[] = [];
    try {
      await client.init();
      for (let i = 0; i < 8; i++) {
        calls.push(
          client.call("device/pair", { code: "ZZZZZZZZZZ", name: "attacker" }).catch((e) => e),
        );
      }
      // The RIGHT code last, in the same burst.
      calls.push(
        client
          .call("device/pair", { code: "K7M2QX9AB3", name: "attacker" })
          .catch((e: unknown) => e),
      );
      const answered = (await Promise.all(calls)) as { code: number; data?: { reason?: string } }[];
      const reasons = answered.map((a) => a.data?.reason);
      // The first five are guesses; everything pipelined behind them is refused
      // without a lookup, so the right code never reaches the store.
      expect(reasons.slice(0, 4)).toEqual(Array(4).fill("invalid_code"));
      expect(reasons.slice(4)).toEqual(Array(5).fill("too_many_attempts"));
      expect(readClaim(configDir, opened.session.sid)).toBeUndefined();
    } finally {
      client.close();
    }
  });
});
