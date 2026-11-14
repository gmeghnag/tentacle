/**
 * `acceptDevice` — the device path with no Bun socket under it
 * (docs/feat/mobile-relay.md R3). The direct `/e2e` route and the mobile
 * relay's accept leg both call this, so what it promises is proved here on an
 * in-memory `createChannelPair` channel: the same authenticating decisions, the
 * same "nothing is built until the responder RESOLVES" (F4/P2), and the same
 * exactly-once settle that frees the caller's handshake slot (F14).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DuplexChannel } from "@tentacle/transport";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  type NoiseError,
  noiseInitiator,
  publicKeyOf,
  systemRandom,
} from "@tentacle/transport/noise";
import { acceptDevice } from "../src/device-accept.ts";
import { DeviceAuthority } from "../src/device-authority.ts";
import {
  addDevice,
  closePairing,
  loadOrCreateIdentity,
  openPairing,
  readIdentity,
  readSeen,
} from "../src/device-store.ts";
import { SessionHost } from "../src/session-host.ts";

const dirs: string[] = [];
const authorities: DeviceAuthority[] = [];
afterEach(() => {
  for (const a of authorities.splice(0)) a.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

function store(): string {
  const configDir = mkdtempSync(join(tmpdir(), "device-accept-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  return configDir;
}

function authorityFor(configDir: string, audit: string[]): DeviceAuthority {
  const authority = new DeviceAuthority({
    configDir,
    pollIntervalMs: 10,
    onAudit: (line) => audit.push(line),
  });
  authorities.push(authority);
  return authority;
}

/** Let the pending microtask chains (frame delivery, resolve continuations) run. */
async function tick(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

interface Harness {
  /** The paired/unknown phone's end of the channel. */
  readonly phone: DuplexChannel;
  /** `onSettled` calls — the caller's limiter slot. */
  readonly settled: () => number;
  /** Connections `acceptDevice` built. */
  readonly built: () => number;
  readonly audit: string[];
  readonly authority: DeviceAuthority;
  readonly release: () => void;
}

function acceptOn(
  configDir: string,
  options: { closeAfterConfirm?: boolean; releaseInGap?: boolean; pairingCheckMs?: number } = {},
): Harness {
  const audit: string[] = [];
  const authority = authorityFor(configDir, audit);
  const [daemon, phone] = createChannelPair();
  let settled = 0;
  let built = 0;
  let closed = false;
  let inbound = 0;
  // `release()` as the CALLER holds it: the socket's `close` handler runs it
  // (ws-server.ts:346-348), which is before the responder's resolve.
  let release: () => void = () => {};
  const pair = phone;
  // The daemon end's close must be observable to the F22 check, exactly as the
  // socket wrapper's `isClosed()` is.
  const wrapped: DuplexChannel = {
    send: (d) => daemon.send(d),
    close: () => {
      closed = true;
      daemon.close();
    },
    setOnMessage: (handler) =>
      daemon.setOnMessage((data) => {
        inbound += 1;
        handler(data);
        // The F22 window made deterministic: the transport is gone the instant
        // the responder finished reading the confirm, before its continuation
        // (the resolve) runs — exactly what a real socket close in that gap is.
        if (options.closeAfterConfirm === true && inbound === 2) {
          closed = true;
        }
        if (options.releaseInGap === true && inbound === 2) {
          release();
        }
      }),
    setOnClose: (h) =>
      daemon.setOnClose(() => {
        closed = true;
        h();
      }),
  };
  const accepted = acceptDevice(wrapped, {
    authority,
    sessionHost: dummyHost,
    isClosed: () => closed,
    onAudit: (line) => audit.push(line),
    onSettled: () => {
      settled += 1;
    },
    onConnection: () => {
      built += 1;
    },
    ...(options.pairingCheckMs !== undefined ? { pairingCheckMs: options.pairingCheckMs } : {}),
  });
  release = accepted.release;
  return {
    phone: pair,
    settled: () => settled,
    built: () => built,
    audit,
    authority,
    release: accepted.release,
  };
}

/** Complete a real handshake from the phone's end and drive `initialize` over it. */
async function connect(
  phone: DuplexChannel,
  privateKey: Uint8Array,
  remoteStatic: Uint8Array,
): Promise<RpcPeer> {
  const secure = await noiseInitiator(phone, {
    staticKey: privateKey,
    remoteStatic,
    random: systemRandom,
  });
  return new RpcPeer(secure, {
    onRequest: async () => {
      throw new Error("the daemon does not ask in these tests");
    },
    onNotification: () => {},
  });
}

describe("acceptDevice builds a real Connection on a plain channel", () => {
  test("a registered key is admitted and `initialize` is served (the relay's path, no socket)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const added = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      now: 2_000,
    });
    if (!added.ok) throw new Error(added.reason);
    const h = acceptOn(configDir);
    const peer = await connect(h.phone, key(2), identity.identity.publicKey);
    try {
      const result = (await peer.request("initialize", {
        protocolVersion: 24,
        clientCapabilities: {},
        clientInfo: { name: "phone", version: "0" },
      })) as { protocolVersion: number };
      expect(result.protocolVersion).toBe(24);
      expect(h.built()).toBe(1);
      expect(h.settled()).toBe(1);
      expect(h.audit).toContain(`device-open ${added.device.id.slice(0, 8)}`);
      // "Last seen" is recorded on the RESOLVE, here as on the socket route.
      expect(readSeen(configDir).get(added.device.id)).toBeDefined();
      expect(h.authority.liveCount()).toBe(1);
    } finally {
      peer.close();
      h.release();
    }
  });

  test("an unknown key is denied, and nothing is built (F15)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const h = acceptOn(configDir);
    const denied = await connect(h.phone, key(9), identity.identity.publicKey).catch((e) => e);
    expect((denied as NoiseError).kind).toBe("denied");
    await tick();
    expect(h.built()).toBe(0);
    expect(h.settled()).toBe(1);
    expect(h.audit).toContain("device-denied");
    expect(readSeen(configDir).size).toBe(0);
  });

  test("a replayed message 1 builds nothing and records nothing (F4/P2)", async () => {
    // Mutation: build the `Connection` (or `touchSeen`) inside `authorize` —
    // which every message 1 reaches, replays included — and this fails.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const added = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      now: 2_000,
    });
    if (!added.ok) throw new Error(added.reason);
    // Capture a legitimate message 1.
    const captured: string[] = [];
    const first = acceptOn(configDir);
    const innerSend = first.phone.send.bind(first.phone);
    const tapped: DuplexChannel = {
      send: (d) => {
        captured.push(d);
        innerSend(d);
      },
      close: () => first.phone.close(),
      setOnMessage: (h) => first.phone.setOnMessage(h),
      setOnClose: (h) => first.phone.setOnClose(h),
    };
    const peer = await connect(tapped, key(2), identity.identity.publicKey);
    await tick();
    peer.close();
    first.release();
    if (captured.length === 0) throw new Error("no message 1 was captured");
    const seenAfterReal = readSeen(configDir).get(added.device.id);
    if (seenAfterReal === undefined) throw new Error("the real handshake must be seen");
    // Replay it on a FRESH channel and never send the confirm.
    const replay = acceptOn(configDir);
    replay.phone.send(captured[0] as string);
    await tick(60);
    expect(replay.built()).toBe(0);
    expect(replay.audit.some((l) => l.startsWith("device-open"))).toBe(false);
    // The timestamp is exactly what the genuine handshake wrote: a replay is
    // not "seen" without a single authenticated frame.
    expect(readSeen(configDir).get(added.device.id)).toBe(seenAfterReal);
    expect(replay.settled()).toBe(0); // still mid-handshake, the slot is held…
    replay.phone.close();
    await tick();
    expect(replay.settled()).toBe(1); // …and a close mid-handshake gives it back
  });
});

describe("every outcome settles exactly once (the caller's slot)", () => {
  test("a channel closed mid-handshake still settles, once (mutation: no close path -> held forever)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    const h = acceptOn(configDir);
    // The handshake starts and is abandoned before the confirm (the phone walks
    // away right after its message 1): without the settle on the responder's
    // REJECT path, the caller's concurrent cap would be held by a phone that is
    // gone (`maxConcurrent` 32 in production).
    const phone = h.phone;
    const innerSend = phone.send.bind(phone);
    let sent = 0;
    const hangsUp: DuplexChannel = {
      send: (d) => {
        innerSend(d);
        sent += 1;
        if (sent === 1) phone.close(); // gone before the confirm can arrive
      },
      close: () => phone.close(),
      setOnMessage: (cb) => phone.setOnMessage(cb),
      setOnClose: (cb) => phone.setOnClose(cb),
    };
    const abandoned = await connect(hangsUp, key(2), identity.identity.publicKey).catch((e) => e);
    expect((abandoned as NoiseError).kind).toBe("closed");
    await tick();
    expect(h.settled()).toBe(1);
    expect(h.built()).toBe(0);
    // A late release() (the transport's own close) must not settle it again.
    h.release();
    expect(h.settled()).toBe(1);
  });

  test("no identity: settles at once and closes the channel (F14 — no leaked slot per dial)", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "device-accept-empty-"));
    dirs.push(configDir);
    const h = acceptOn(configDir);
    // Synchronous: no handshake is ever started, so nothing else could settle it.
    expect(h.settled()).toBe(1);
    expect(h.audit).toContain("e2e-no-identity");
    expect(h.built()).toBe(0);
    h.release();
    expect(h.settled()).toBe(1);
  });

  test("release() drops the authority's handle, so a later revoke cannot touch it (F11)", async () => {
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    const h = acceptOn(configDir);
    const peer = await connect(h.phone, key(2), identity.identity.publicKey);
    await peer.request("initialize", {
      protocolVersion: 24,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    });
    expect(h.authority.liveCount()).toBe(1);
    h.release();
    expect(h.authority.liveCount()).toBe(0);
    // Idempotent: a second release (both teardown paths can run) changes nothing.
    h.release();
    expect(h.authority.liveCount()).toBe(0);
    peer.close();
  });

  test("a channel closed between the confirm and the build leaves no attached connection (F22)", async () => {
    // The hardest obligation the extraction carries: the handshake can resolve
    // after the transport is gone, and the channel's close handler already ran
    // (it will never call back), so the build itself must notice.
    // Mutation: drop the `isClosed()` branch -> the authority keeps a live
    // handle for a connection nobody can reach, forever.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    const h = acceptOn(configDir, { closeAfterConfirm: true });
    const peer = await connect(h.phone, key(2), identity.identity.publicKey);
    peer.close();
    await tick(60);
    expect(h.built()).toBe(1);
    expect(h.authority.liveCount()).toBe(0);
  });

  test("release() in the confirm→build gap still drops the handle the build registers (R3 review 1)", async () => {
    // The CALLER's order, which is what the extraction changed: the socket's
    // close handler runs `release()` (ws-server.ts) BEFORE the responder
    // resolves. Latching the teardown on that first call makes the F22 path a
    // no-op, and the authority then keeps a dead handle forever.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", now: 2_000 });
    const h = acceptOn(configDir, { releaseInGap: true, closeAfterConfirm: true });
    const peer = await connect(h.phone, key(2), identity.identity.publicKey);
    peer.close();
    await tick(60);
    expect(h.built()).toBe(1);
    expect(h.authority.liveCount()).toBe(0);
  });

  test("a release() in the gap also stops the pairing watcher (R3 review 1)", async () => {
    // The pairing variant of the same order, on its own property: a leaked
    // watcher keeps an interval that audits `pairing-closed` and calls
    // `handle.close()` every tick for the process's life.
    const configDir = store();
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const opened = openPairing(configDir, {
      code: "K7M2QX9AB3",
      now: Date.now(),
      pid: process.pid,
    });
    if (!opened.ok) throw new Error(opened.reason);
    const h = acceptOn(configDir, {
      releaseInGap: true,
      closeAfterConfirm: true,
      pairingCheckMs: 5,
    });
    const peer = await connect(h.phone, key(7), identity.identity.publicKey);
    peer.close();
    await tick(60);
    expect(h.built()).toBe(1);
    // The window goes away (pair's exit handler): only a live watcher reacts.
    closePairing(configDir, opened.session.sid);
    await tick(60);
    expect(h.audit.filter((line) => line === "pairing-closed")).toHaveLength(0);
  });
});
