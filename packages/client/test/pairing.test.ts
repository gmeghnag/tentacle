/**
 * `pairDevice` against a REAL daemon on loopback (docs/feat/device-pairing.md
 * 9c): the route (9b), the store (9a) and the handler, driven by the helper the
 * app's pairing screen uses. The "human" is a fake `pair` that watches the
 * claim and answers the way 9d's `pair` will — registry first, then decision.
 *
 * Properties pinned here and nowhere else:
 * - `onCompare` fires BEFORE `device/pair` goes out (the mutation the plan
 *   names: call it after, and the test sees no compare at claim time);
 * - a paired device can then dial the SAME address as a device and work — the
 *   pairing connection is not the session path (§7: one session path, and
 *   pairing is a one-shot RPC, not a session);
 * - every refusal reason reaches the caller as a `PairingRefused` with its
 *   reason, never as text.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceAuthority,
  type DeviceIdentity,
  SessionHost,
  addDevice,
  claimPairing,
  deviceIdOf,
  loadOrCreateIdentity,
  openPairing,
  readClaim,
  readRegistry,
  startWsServer,
  writePairingDecision,
} from "@tentacle/daemon";
import type { PairingPayload } from "@tentacle/protocol";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  noiseInitiator,
  noiseResponder,
  publicKeyOf,
  systemRandom,
} from "@tentacle/transport/noise";
import { PairingRefused, pairDevice } from "../src/pairing.ts";

const CODE = "K7M2QX9AB3";
const IOS_ORIGIN = "http://192.168.1.8:4001";
const dirs: string[] = [];
const servers: { stop(): void }[] = [];
const authorities: DeviceAuthority[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  for (const a of authorities.splice(0)) a.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await sleep(10);
}

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

function store(fill = 1): { configDir: string; identity: DeviceIdentity } {
  const configDir = mkdtempSync(join(tmpdir(), "client-pairing-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    // Distinct per store: two calls must be two DIFFERENT computers, or the
    // "wrong pinned key" case would pin the right one.
    random: () => key(fill),
  });
  if (!created.ok) throw new Error(created.reason);
  return { configDir, identity: created.identity };
}

/** The daemon on loopback with the device route, as `serve` wires it. */
function serve(configDir: string): { url: string; audit: string[]; host: SessionHost } {
  const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
  authorities.push(authority);
  const audit: string[] = [];
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: dummyHost,
    devices: { authority, pairingCheckMs: 20 },
    onAudit: (line) => audit.push(line),
  });
  servers.push(server);
  return { url: `${server.url}/e2e`, audit, host: dummyHost };
}

/** A real WebSocket the way a phone dials: iOS always sends an `Origin`. */
function dial(url: string): () => Promise<DuplexChannel> {
  return () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { Origin: IOS_ORIGIN } } as never);
      let onMessage: ((d: string) => void) | undefined;
      let onClose: (() => void) | undefined;
      let opened = false;
      ws.addEventListener("message", (e) => onMessage?.(String(e.data)));
      ws.addEventListener("close", (e) => {
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

function payloadFor(identity: DeviceIdentity, url: string): PairingPayload {
  return {
    v: 1,
    key: identity.publicKey,
    computer: identity.name,
    code: CODE,
    addresses: [url],
  };
}

/**
 * The fake human: watches for a claim on `sid` and answers it. `answer` is what
 * `pair` does — the registry write comes FIRST (F3), then the decision.
 */
async function human(
  configDir: string,
  sid: string,
  decision: { accept: boolean; name?: string },
): Promise<void> {
  await until(() => readClaim(configDir, sid) !== undefined);
  const claim = readClaim(configDir, sid);
  if (claim === undefined) throw new Error("no claim");
  if (decision.accept) {
    const added = addDevice(configDir, {
      publicKey: claim.publicKey,
      name: decision.name ?? claim.name,
      now: 5_000,
    });
    if (!added.ok) throw new Error(added.reason);
  }
  writePairingDecision(configDir, sid, decision.accept);
}

/** The same human, but thinking for `delayMs` first (a slow `[y/N]` answer). */
async function humanAfter(
  configDir: string,
  sid: string,
  delayMs: number,
  decision: { accept: boolean; name?: string },
): Promise<void> {
  await until(() => readClaim(configDir, sid) !== undefined);
  await sleep(delayMs);
  await human(configDir, sid, decision);
}

describe("pairDevice, the happy path", () => {
  test("a code, the human's `y` and the SAS → a device id; then a device dial works", async () => {
    const { configDir, identity } = store();
    const { url } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const deviceKey = key(7);
    const compares: string[] = [];
    const answering = human(configDir, opened.session.sid, { accept: true });
    const result = await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey,
      name: "iPhone di Gabriel",
      dial,
      random: systemRandom,
      onCompare: (sas) => {
        compares.push(sas);
      },
    });
    await answering;
    expect(result.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(result.computer).toEqual({ id: result.computer.id, name: "gabriel-mac" });
    // The SAS the phone showed is the one the terminal showed (the 9a store
    // computes it from the CLAIM's key, which is this device's).
    const claim = readClaim(configDir, opened.session.sid);
    expect(compares).toEqual([claim?.sas as string]);
    // The registry holds this device, under the channel's key.
    const registry = readRegistry(configDir);
    if (!registry.ok) throw new Error(registry.reason);
    expect(registry.registry.devices.map((d) => d.publicKey)).toEqual([publicKeyOf(deviceKey)]);
    // And now the SAME address, as a device: an ordinary connection (§7).
    const secure = await noiseInitiator(await dial(url)(), {
      staticKey: deviceKey,
      remoteStatic: identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("the daemon does not ask");
      },
      onNotification: () => {},
    });
    try {
      const init = (await peer.request("initialize", {
        protocolVersion: 24,
        clientCapabilities: {},
        clientInfo: { name: "phone", version: "0" },
      })) as { protocolVersion: number };
      expect(init.protocolVersion).toBe(24);
      // A paired device has a token client's rights (decision 5).
      const list = (await peer.request("session/list", {})) as { sessions: unknown[] };
      expect(Array.isArray(list.sessions)).toBe(true);
    } finally {
      peer.close();
    }
  });

  test("`onCompare` fires BEFORE `device/pair` is sent — i.e. before any claim exists", async () => {
    // The plan's mutation: call `onCompare` after the request. Then this test
    // sees a claim already on disk when the compare code is shown, and the
    // human could only ever say yes to an attack that already happened.
    const { configDir, identity } = store();
    const { url } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    let claimAtCompare: boolean | undefined;
    const answering = human(configDir, opened.session.sid, { accept: true });
    await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey: key(7),
      name: "iPhone di Gabriel",
      dial,
      random: systemRandom,
      onCompare: () => {
        claimAtCompare = readClaim(configDir, opened.session.sid) !== undefined;
      },
    });
    await answering;
    expect(claimAtCompare).toBe(false);
  });
});

describe("pairDevice, the refusals", () => {
  test("a human slower than the request timeout still pairs (the window is 5 min, F3)", async () => {
    // The bug: one 30 s deadline covered `device/pair`, so a human who took
    // longer made the phone fail while the computer's terminal kept asking — a
    // `y` then registered a device that had reported failure. The property: the
    // request timeout applies to `initialize` ONLY; `device/pair` waits for the
    // DAEMON's answer (its 5-minute window, or a refusal). Driven at test speed
    // with a 50 ms `requestTimeoutMs` and a human who answers after 400 ms.
    {
      const { configDir, identity } = store();
      const { url } = serve(configDir);
      const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
      if (!opened.ok) throw new Error(opened.reason);
      const answering = humanAfter(configDir, opened.session.sid, 400, {
        accept: true,
        name: "iPhone di Gabriel",
      });
      const result = await pairDevice({
        payload: payloadFor(identity, url),
        deviceKey: key(7),
        name: "iPhone di Gabriel",
        dial,
        random: systemRandom,
        requestTimeoutMs: 50,
      });
      await answering;
      expect(result.deviceId).toBe(deviceIdOf(publicKeyOf(key(7))));
    }
  });

  test("a daemon that accepts the socket and never answers `initialize` still fails fast", async () => {
    // The other half: `initialize` must KEEP its deadline. A silent daemon (a
    // real Noise responder whose peer never answers) must not hang the pairing
    // screen — the timeout removed from `device/pair` still guards the
    // handshake.
    const { identity } = store();
    const [clientEnd, serverEnd] = createChannelPair();
    void noiseResponder(serverEnd, {
      staticKey: identity.privateKey,
      random: systemRandom,
      authorize: () => true,
    }).then((secure) => {
      // A peer that answers nothing at all.
      new RpcPeer(secure, {
        onRequest: () => new Promise(() => {}),
        onNotification: () => {},
      });
    });
    const failure = await pairDevice({
      payload: payloadFor(identity, "ws://127.0.0.1:1/e2e"),
      deviceKey: key(7),
      name: "iPhone",
      dial: () => async () => clientEnd,
      random: systemRandom,
      requestTimeoutMs: 60,
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as { name?: string }).name).toBe("cancelled");
  });

  test("`device/pair` is the only request without a deadline: a refusal still arrives", async () => {
    // A refusal is the daemon's answer, so it is what a slow human's socket sees
    // when the computer says `N` — the deadline change must not have swallowed
    // the reason (it is `RpcPeer`'s own reject, never a timeout).
    const { configDir, identity } = store();
    const { url } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const answering = humanAfter(configDir, opened.session.sid, 300, { accept: false });
    const failure = await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
      requestTimeoutMs: 50,
    }).catch((e) => e);
    await answering;
    expect(failure).toBeInstanceOf(PairingRefused);
    expect((failure as PairingRefused).reason).toBe("declined");
  });

  test("a wrong code is `PairingRefused{invalid_code}`", async () => {
    const { configDir, identity } = store();
    const { url } = serve(configDir);
    // A window for a DIFFERENT code: the phone's payload is stale.
    openPairing(configDir, { code: "ABCDEFGH23", now: Date.now(), pid: process.pid });
    const failure = await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(PairingRefused);
    expect((failure as PairingRefused).reason).toBe("invalid_code");
  });

  test("the human's `N` is `PairingRefused{declined}`, and nothing is registered", async () => {
    const { configDir, identity } = store();
    const { url } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const answering = human(configDir, opened.session.sid, { accept: false });
    const failure = await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
    }).catch((e) => e);
    await answering;
    expect((failure as PairingRefused).reason).toBe("declined");
    const registry = readRegistry(configDir);
    if (!registry.ok) throw new Error(registry.reason);
    expect(registry.registry.devices).toHaveLength(0);
  });

  test("a second phone on the same code is `used` (F1/F5)", async () => {
    const { configDir, identity } = store();
    const { url } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    // Someone else claimed this window first.
    claimPairing(configDir, {
      sid: opened.session.sid,
      deviceKey: key(9),
      name: "someone",
      now: Date.now(),
    });
    const failure = await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
    }).catch((e) => e);
    expect((failure as PairingRefused).reason).toBe("used");
  });

  test("no address answers → the dial's own failure (never a silent success)", async () => {
    const { identity } = store();
    // A port nothing listens on: the payload's address is unreachable.
    const failure = await pairDevice({
      payload: payloadFor(identity, "ws://127.0.0.1:1/e2e"),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(Error);
  });

  test("a wrong pinned computer key fails the HANDSHAKE, and the one-time code is not spent", async () => {
    // F23 in miniature: the phone's QR is stale, so the daemon it reaches is a
    // different one — the Noise handshake fails before any code is sent, so a
    // one-time code is never spent on the wrong computer. The exact
    // `ChannelError` kind is the transport's (`rejected` for a failed
    // handshake, `unreachable` for a close): the property here is that it is a
    // CHANNEL failure, never a `PairingRefused` (which would mean the code
    // reached a daemon that never authenticated us).
    const { configDir } = store(1);
    const other = store(5);
    const { url } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const failure = await pairDevice({
      // The pin is the OTHER computer's key.
      payload: payloadFor(other.identity, url),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
    }).catch((e) => e);
    expect(failure).not.toBeInstanceOf(PairingRefused);
    expect(["rejected", "unreachable"]).toContain((failure as { kind?: string }).kind);
    expect(readClaim(configDir, opened.session.sid)).toBeUndefined();
  });
});

describe("pairDevice is a one-shot RPC, not a session (§7)", () => {
  test("it opens no session and closes its socket: the daemon sees a pairing-only connection", async () => {
    // The property: pairing touches the channel, the peer and two methods. If it
    // were routed through `RemoteClient` there would be a `session/open` — and
    // it would be REFUSED anyway by the pairing principal's gate (9b), so a
    // second session path cannot even exist. Pinned here as: no session was
    // created, the connection carried the pairing principal (never `device`),
    // and the socket was closed by us.
    const { configDir, identity } = store();
    const { url, audit, host } = serve(configDir);
    const opened = openPairing(configDir, { code: CODE, now: Date.now(), pid: process.pid });
    if (!opened.ok) throw new Error(opened.reason);
    const answering = human(configDir, opened.session.sid, { accept: true });
    const result = await pairDevice({
      payload: payloadFor(identity, url),
      deviceKey: key(7),
      name: "iPhone",
      dial,
      random: systemRandom,
    });
    await answering;
    expect(result.deviceId).toMatch(/^[0-9a-f]{16}$/);
    // No session was ever opened on the daemon's host.
    expect(host.size).toBe(0);
    // It was a PAIRING connection: the route's own words for that, not a device's.
    expect(audit).toContain("pairing-open");
    expect(audit.filter((l) => l.startsWith("device-open"))).toEqual([]);
    expect(audit).toContain(`pairing-done ${result.deviceId.slice(0, 8)}`);
    // And the helper hung up: the route's teardown ran (`connection-close`).
    await until(() => audit.includes("connection-close"));
    expect(audit).toContain("connection-close");
  });
});
