/**
 * The daemon's relay dial-out against **R2's REAL relay** (docs/feat/mobile-relay.md
 * R4): the end-to-end proof that a phone reaches a session through the relay, the
 * revoke that closes a relay stream, a lying relay's `ready`, the reachability
 * gate, and a hostile relay flipping a spliced byte.
 *
 * The link is wired exactly as `serve` wires it (R5a does the config half): a
 * real `DeviceAuthority`, one `HandshakeLimiter` shared with nothing else in the
 * test, `bunRelayDialer`, and the plan's backoff constants.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_PROTOCOL_VERSION, encodeBase64Url, relayAddress } from "@tentacle/protocol";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { type ByteCarrier, type CarrierFrame, carrierFrameOf } from "@tentacle/transport";
import { RpcPeer } from "@tentacle/transport";
import { NoiseError, noiseInitiator, publicKeyOf, systemRandom } from "@tentacle/transport/noise";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { DeviceAuthority } from "../src/device-authority.ts";
import {
  REGISTRY_FILENAME,
  addDevice,
  deviceDir,
  deviceIdOf,
  loadOrCreateIdentity,
  openPairing,
  readAdoption,
  readIdentity,
  readSeen,
  removeDevices,
} from "../src/device-store.ts";
import { HandshakeLimiter } from "../src/handshake-limit.ts";
import {
  type RelayDialer,
  type RelayLinkTimers,
  type RelaySocketHost,
  type RunningRelayLink,
  bunRelayDialer,
  startRelayLink,
} from "../src/relay-link.ts";
import { SessionHost } from "../src/session-host.ts";

/** This serve's project (docs/feat/mobile-projects.md §2). */
const TEST_PROJECT = { key: "proj-0123456789ab", cwd: "/u/proj" };

const dirs: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const SECRET = new Uint8Array(32).fill(7);
const SECRET_TEXT = encodeBase64Url(SECRET);
const ID = relayIdOf(SECRET);

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

function store(): string {
  const configDir = mkdtempSync(join(tmpdir(), "relay-link-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  return configDir;
}

/** A paired device in the store: what makes `wantsReachability()` true. */
function pairPhone(configDir: string): string {
  const added = addDevice(configDir, {
    project: TEST_PROJECT,
    publicKey: publicKeyOf(key(2)),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) throw new Error(added.reason);
  return added.device.id;
}

/** Timers that never fire on their own: a test drives the clock, not the wall. */
function frozenTimers(): RelayLinkTimers & { timeouts: (() => void)[] } {
  const timeouts: (() => void)[] = [];
  return {
    timeouts,
    setTimeout: (fn) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
}

/** A limiter that COUNTS its calls: `end()` clamps at 0, so a double call is invisible otherwise. */
class CountingLimiter extends HandshakeLimiter {
  begins = 0;
  ends = 0;
  constructor() {
    super({ burst: 100, maxConcurrent: 4 });
  }
  override begin(address: string): boolean {
    const ok = super.begin(address);
    if (ok) this.begins += 1;
    return ok;
  }
  override end(): void {
    this.ends += 1;
    super.end();
  }
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/**
 * A HOSTILE relay for the byte-flip test: it implements just enough of the wire
 * (`hello` → `ready`, phone dial → `open`, accept leg → splice) to get a real
 * handshake going, then corrupts a spliced frame. Everything it does is what a
 * relay is allowed to do to the bytes it carries (AGENTS §7 "a relay is not
 * trusted"): the daemon must refuse the session, not negotiate with it.
 */
function startFlakyRelay(options: { flipNth: number }): { url: string; stop(): void } {
  interface Leg {
    role?: string;
    stream?: string;
    forwarded?: number;
  }
  let control: { send(d: string): void } | undefined;
  type Frame = string | Uint8Array;
  const streams = new Map<string, { phone?: unknown; accept?: unknown; early?: Frame[] }>();
  let count = 0;
  const server = Bun.serve<Leg>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      // `data` must be supplied at the upgrade: `ws.data` is exactly this object.
      if (srv.upgrade(req, { data: {} })) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        // E2E v2: the phone's Noise frames are binary; only control/accept frames are JSON text.
        const frame0: Frame = typeof raw === "string" ? raw : new Uint8Array(raw);
        const text = typeof raw === "string" ? raw : "";
        const data = ws.data;
        if (data.role === undefined) {
          let frame: { t?: string; stream?: string } = {};
          try {
            frame = JSON.parse(text) as { t?: string; stream?: string };
          } catch {
            // a phone's Noise frame is not JSON
          }
          if (frame.t === "hello") {
            data.role = "control";
            control = ws;
            ws.send(
              JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION, id: ID, features: [] }),
            );
            return;
          }
          if (frame.t === "accept") {
            data.role = "accept";
            const pair = streams.get(frame.stream ?? "");
            if (pair) {
              pair.accept = ws;
              // Flush what the phone sent before the daemon's leg existed, as
              // the real relay does (pre-accept buffer): a Noise message 1 is
              // sent the instant the phone dials.
              for (const early of pair.early ?? []) {
                ws.send(early);
              }
              pair.early = [];
              data.forwarded = 0;
            }
            return;
          }
          data.role = "phone";
          // A REAL token shape: `RelayStreamTokenSchema` is 22 base64url chars,
          // so a made-up "stream-0" would (correctly) be a malformed frame.
          const stream = mintStreamToken(count++);
          const record: { phone?: unknown; accept?: unknown; early?: Frame[] } = {
            phone: ws,
            early: [frame0],
          };
          streams.set(stream, record);
          data.stream = stream;
          data.forwarded = 0;
          control?.send(JSON.stringify({ t: "open", stream, ip: "127.0.0.1" }));
          return;
        }
        if (data.role !== "phone") {
          // The accept leg's own frames go back to the phone, corrupted on the
          // Nth one: the hostile act a real relay can always perform.
          if (data.role === "accept") {
            const pair = [...streams.entries()].find(([, p]) => p.accept === ws);
            const phone = pair?.[1].phone as { send(d: Frame): void } | undefined;
            if (!phone) return;
            data.forwarded = (data.forwarded ?? 0) + 1;
            phone.send(data.forwarded === options.flipNth ? flipOneByte(frame0) : frame0);
          }
          return;
        }
        const pair = streams.get(data.stream ?? "");
        const accept = pair?.accept as { send(d: Frame): void } | undefined;
        if (!accept) {
          // Held for the daemon's accept leg, exactly like the real relay.
          pair?.early?.push(frame0);
          return;
        }
        accept.send(frame0);
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** A 22-char base64url stream token, the shape the wire requires. */
function mintStreamToken(n: number): string {
  return encodeBase64Url(new Uint8Array(16).fill(n + 1));
}

/**
 * Flip one byte in the middle of a binary Noise frame: a changed CIPHERTEXT
 * byte, which the AEAD must reject (a text frame or a truncation would only
 * test the frame-shape guard, a different property).
 */
function flipOneByte(frame: string | Uint8Array): string | Uint8Array {
  if (typeof frame === "string") return frame;
  const out = Uint8Array.from(frame);
  const at = Math.floor(out.length / 2);
  out[at] = (out[at] ?? 0) ^ 0x01;
  return out;
}

/** A phone's `ByteCarrier` over a real WebSocket at the relay address (E2E v2: binary). */
function dialPhone(url: string): Promise<{ channel: ByteCarrier; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let onMessage: ((d: CarrierFrame) => void) | undefined;
    let onClose: (() => void) | undefined;
    ws.addEventListener("message", (e) => {
      const frame = carrierFrameOf(e.data);
      if (frame !== null) onMessage?.(frame);
    });
    ws.addEventListener("close", () => onClose?.());
    ws.addEventListener("error", () => reject(new Error(`phone socket error ${url}`)));
    ws.addEventListener("open", () =>
      resolve({
        ws,
        channel: {
          send: (d) => ws.send(d),
          close: () => ws.close(),
          setOnMessage: (h) => {
            onMessage = h;
          },
          setOnClose: (h) => {
            onClose = h;
          },
        },
      }),
    );
  });
}

interface Harness {
  readonly link: RunningRelayLink;
  readonly audit: string[];
  readonly relay: ReturnType<typeof startRelay>;
  readonly authority: DeviceAuthority;
  readonly configDir: string;
}

/** Start R2's relay, then the link against it, exactly as `serve` will. */
function harness(
  over: {
    configDir?: string;
    secret?: Uint8Array;
    limiter?: HandshakeLimiter;
    url?: string;
    timers?: RelayLinkTimers;
    liveness?: { pingMs?: number; pongMs?: number };
  } = {},
): Harness {
  const configDir = over.configDir ?? store();
  const relay = startRelay({ host: "127.0.0.1", port: 0, sweepMs: 10, onLog: () => {} });
  cleanups.push(() => relay.stop());
  const audit: string[] = [];
  const authority = new DeviceAuthority({
    project: TEST_PROJECT,
    configDir,
    pollIntervalMs: 10,
    onAudit: (line) => audit.push(line),
  });
  cleanups.push(() => authority.stop());
  const link = startRelayLink({
    url: over.url ?? relay.url,
    secret: over.secret ?? SECRET,
    authority,
    sessionHost: dummyHost,
    limiter: over.limiter ?? new HandshakeLimiter({ burst: 100 }),
    dial: bunDialerForTest(),
    onAudit: (line) => audit.push(line),
    ...(over.timers ? { timers: over.timers } : {}),
    ...(over.liveness ? { liveness: over.liveness } : {}),
  });
  cleanups.push(() => link.stop());
  return { link, audit, relay, authority, configDir };
}

/** The production dialer (a real Bun client WebSocket per leg). */
function bunDialerForTest() {
  return bunRelayDialer();
}

/**
 * A relay with NO socket at all: every frame is delivered by hand, so a test can
 * put an `open` where the relay could never legally put one, or send a 2 MiB
 * frame, and read the consequence exactly (R4 review round 1).
 */
interface FakeHost {
  readonly url: string;
  readonly sent: (string | Uint8Array)[];
  closed: boolean;
  onOpen?: () => void;
  onMessage?: (data: CarrierFrame) => void;
  onClose?: (info: { readonly code?: number; readonly reason?: string }) => void;
}

function fakeRelay(): { dial: RelayDialer; hosts: FakeHost[] } {
  const hosts: FakeHost[] = [];
  const dial: RelayDialer = (url) => {
    const host: FakeHost = { url, sent: [], closed: false };
    hosts.push(host);
    const socketHost: RelaySocketHost = {
      socket: {
        send: (data) => {
          host.sent.push(data);
        },
        close: () => {
          host.closed = true;
        },
      },
      setOnOpen: (handler) => {
        host.onOpen = handler;
      },
      setOnMessage: (handler) => {
        host.onMessage = handler;
      },
      setOnClose: (handler) => {
        host.onClose = handler;
      },
    };
    return socketHost;
  };
  return { dial, hosts };
}

/** Timers that RECORD a delay and fire only when the test says so. */
function recordingTimers(): RelayLinkTimers & { pending: { fn: () => void; ms: number }[] } {
  const pending: { fn: () => void; ms: number }[] = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      pending.push({ fn, ms });
      return pending.length;
    },
    clearTimeout: () => {},
    setInterval: () => 1,
    clearInterval: () => {},
  };
}

/** A paired device, a fake relay and a link on RECORDING timers: frames by hand. */
function fakeHarness(over: { random?: () => number; limiter?: HandshakeLimiter } = {}) {
  const configDir = store();
  pairPhone(configDir);
  const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
  cleanups.push(() => authority.stop());
  const relay = fakeRelay();
  const timers = recordingTimers();
  const audit: string[] = [];
  const link = startRelayLink({
    url: "ws://127.0.0.1:4100",
    secret: SECRET,
    authority,
    sessionHost: dummyHost,
    limiter: over.limiter ?? new HandshakeLimiter({ burst: 100 }),
    dial: relay.dial,
    onAudit: (line) => audit.push(line),
    timers,
    seeds: { now: () => 0, random: over.random ?? (() => 0.5) },
  });
  cleanups.push(() => link.stop());
  const control = (): FakeHost => {
    // The NEWEST control socket: after a retry the link dials a fresh one, and a
    // frame delivered to the dead one is (correctly) ignored.
    const host = [...relay.hosts].reverse().find((s) => s.url.endsWith("/v1/daemon"));
    if (host?.onOpen === undefined || host.onMessage === undefined || host.onClose === undefined) {
      throw new Error("the link did not dial a control socket");
    }
    return host;
  };
  return { configDir, authority, relay, timers, audit, link, control };
}

/** The relay's own `ready` frame, with the id our secret derives. */
function readyFrame(): string {
  return JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION, id: ID, features: [] });
}

describe("hostile relay: a flipped byte in a spliced frame (F5)", () => {
  test("the AEAD refuses it, so no Connection survives and nothing is recorded", async () => {
    // A relay that SPLICES correctly except that it flips one character of the
    // phone's message 1 (or of the confirm). The Noise AEAD must refuse it: the
    // channel closes loudly, no `Connection` is built, no "last seen" is written.
    // Mutation: make the accept leg bypass `acceptDevice`'s Noise responder (e.g.
    // hand the raw socket to a `Connection`) -> a session would come up here.
    const configDir = store();
    pairPhone(configDir);
    const server = startFlakyRelay({ flipNth: 1 });
    const audit: string[] = [];
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: server.url,
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      onAudit: (line) => audit.push(line),
    });
    cleanups.push(() => link.stop());
    await waitFor(() => link.isConnected(), "the link to register");
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const phone = await dialPhone(link.address);
    cleanups.push(() => phone.ws.close());
    const failure = await noiseInitiator(phone.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(NoiseError);
    // Not a live session: the relay cannot drive one with corrupted frames.
    await Bun.sleep(100);
    expect(authority.liveCount()).toBe(0);
    expect(audit.some((l) => l.startsWith("device-open"))).toBe(false);
    expect(readSeen(configDir).size).toBe(0);
  });
});

describe("hostile relay: an `open` flood (F7)", () => {
  test("past the shared cap every stream is refused and the link stays healthy", async () => {
    // `maxConcurrent` 2 and a relay that announces 6 streams at once. The
    // limiter (SHARED with the direct route) admits at most 2; the rest are
    // refused and their slots return, so the daemon is never wedged.
    // Mutation: forget `limiter.begin` in `openStream` -> every stream is
    // admitted and `relay-accept-failed` never appears.
    const configDir = store();
    pairPhone(configDir);
    const limiter = new HandshakeLimiter({ burst: 100, maxConcurrent: 2 });
    const h = harness({ configDir, limiter });
    await waitFor(() => h.link.isConnected(), "the link to register");
    // Ask R2's relay for six simultaneous phone dials to the same id: each
    // becomes an `open`, and the daemon's cap must hold.
    const phones = await Promise.all(
      Array.from({ length: 6 }, () => dialPhone(h.link.address).catch(() => undefined)),
    );
    for (const phone of phones) {
      if (phone) cleanups.push(() => phone.ws.close());
    }
    await waitFor(
      () => h.audit.filter((l) => l === "relay-accept-failed").length > 0,
      "the cap to refuse at least one stream",
    );
    // The link itself is untouched: it is still registered and still answering.
    expect(h.link.isConnected()).toBe(true);
    // Every slot came back once the refused legs closed (the daemon is healthy:
    // a later stream can still be admitted).
    await waitFor(() => limiter.inFlight <= 2, "the limiter to settle at or under the cap");
    for (const phone of phones) phone?.ws.close();
  });
});

describe("the end-to-end proof: a phone reaches a session THROUGH the relay", () => {
  test("a paired phone completes Noise over the relay and runs `session/list`", async () => {
    const configDir = store();
    pairPhone(configDir);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const h = harness({ configDir });
    const id = relayIdOf(SECRET);
    expect(h.link.id).toBe(id);
    expect(h.link.address).toBe(relayAddress(h.relay.url, id));

    await waitFor(() => h.link.isConnected(), "the link to register");
    const phone = await dialPhone(h.link.address);
    cleanups.push(() => phone.ws.close());
    const secure = await noiseInitiator(phone.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("the daemon does not ask here");
      },
      onNotification: () => {},
    });
    cleanups.push(() => peer.close());
    const init = (await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    const list = (await peer.request("session/list", {})) as { sessions?: unknown[] };
    expect(Array.isArray(list.sessions)).toBe(true);
    // The audit names both halves: the relay's own line, then the device path's.
    expect(h.audit).toContain(`relay-ready ${id.slice(0, 8)}`);
    expect(h.audit).toContain("relay-open");
    expect(h.audit.some((l) => l.startsWith("device-open"))).toBe(true);
    expect(h.authority.liveCount()).toBe(1);
  });
});

describe("revoke closes the relay stream within one authority poll (F11)", () => {
  test("a revoked device's live relay connection is closed by the same handle", async () => {
    const configDir = store();
    const deviceId = pairPhone(configDir);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const h = harness({ configDir });
    await waitFor(() => h.link.isConnected(), "the link to register");
    const phone = await dialPhone(h.link.address);
    let phoneClosed = false;
    phone.ws.addEventListener("close", () => {
      // The relay's cascade: our accept leg closed -> the phone leg closes.
      phoneClosed = true;
    });
    const secure = await noiseInitiator(phone.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("unused");
      },
      onNotification: () => {},
    });
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    });
    expect(h.authority.liveCount()).toBe(1);
    // Revoke: the authority's poll must close the relay leg with the SAME handle
    // the direct route gets (mutation: skip `authority.register` in the device
    // path -> nothing closes and this times out).
    removeDevices(configDir, [deviceId]);
    await waitFor(() => h.authority.liveCount() === 0, "the revoke to close the connection");
    expect(h.audit.some((l) => l.startsWith(`device-revoked ${deviceId.slice(0, 8)}`))).toBe(true);
    await waitFor(() => phoneClosed, "the phone leg to close");
    peer.close();
  });
});

describe("today's phone over the relay: zero steps after the upgrade (Q3, review round 1 F1)", () => {
  test("an unadopted legacy entry dials the relay, and its first relay handshake adopts it", async () => {
    // Mutation: `wantsReachability` counts only `devices` (not `adoptable`) ->
    // the link never registers, so the phone (cellular / old direct port dead)
    // gets 4404 forever and is never adopted.
    const configDir = store();
    mkdirSync(deviceDir(configDir), { recursive: true });
    const phoneKey = publicKeyOf(key(2));
    const id = deviceIdOf(phoneKey);
    writeFileSync(
      join(deviceDir(configDir), REGISTRY_FILENAME),
      JSON.stringify({
        v: 1,
        devices: [{ id, name: "iPhone", publicKey: encodeBase64Url(phoneKey), pairedAt: 1 }],
      }),
    );
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const h = harness({ configDir });
    await waitFor(() => h.link.isConnected(), "the link to register for a legacy phone");
    const phone = await dialPhone(h.link.address);
    cleanups.push(() => phone.ws.close());
    const secure = await noiseInitiator(phone.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("the daemon does not ask here");
      },
      onNotification: () => {},
    });
    cleanups.push(() => peer.close());
    const init = (await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    const adoption = readAdoption(configDir, id);
    expect(adoption.kind === "bound" ? adoption.project.key : adoption.kind).toBe(TEST_PROJECT.key);
    expect(h.authority.knows(id)).toBe(true);
  });
});

describe("the reachability gate (Owner Q1)", () => {
  test("no device and no pairing window opens NO socket at all", async () => {
    // Mutation: drop the `relayWanted` check in `dial` -> a hello arrives and the
    // audit gains `relay-ready`, so both assertions below fail.
    const h = harness({ timers: frozenTimers() });
    await Bun.sleep(120);
    expect(h.link.isConnected()).toBe(false);
    expect(h.audit.some((l) => l.startsWith("relay-ready"))).toBe(false);
    // The relay saw nothing: its registry is empty.
    expect(h.relay.core.registeredCount).toBe(0);
  });

  test("a pairing window alone is enough to dial (the pairing race, F17)", async () => {
    const configDir = store();
    // A window with a live `pid` and a future expiry: `hasLivePairing` says yes.
    // No `now`: the authority judges expiry against the REAL clock (F24).
    openPairing(configDir, {
      project: TEST_PROJECT,
      code: "7Q4ZM9XK2B",
      ttlMs: 600_000,
      pid: process.pid,
    });
    const h = harness({ configDir });
    await waitFor(() => h.link.isConnected(), "the link to register for a pairing window");
  });
});

describe("a lying relay: `ready.id` must match our own secret (F7)", () => {
  test("a wrong id drops the link and never becomes `connected`", async () => {
    // A fake relay that registers nothing and answers `ready` with a foreign id.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string };
          if (frame.t === "hello") {
            ws.send(JSON.stringify({ t: "ready", v: 1, id: "A".repeat(22), features: [] }));
          }
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const configDir = store();
    pairPhone(configDir);
    const timers = frozenTimers();
    const audit: string[] = [];
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: `ws://127.0.0.1:${server.port}`,
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      onAudit: (line) => audit.push(line),
      timers,
    });
    cleanups.push(() => link.stop());
    await waitFor(() => audit.includes("relay-down wrong-id"), "the lying relay to be dropped");
    // Never `connected`, so no phone is ever routed here.
    expect(link.isConnected()).toBe(false);
    expect(audit.some((l) => l.startsWith("relay-ready"))).toBe(false);
  });
});

describe("the limiter slot ends EXACTLY once per stream", () => {
  test("an abandoned stream calls end() once, not twice (a leaked cap otherwise)", async () => {
    // `HandshakeLimiter.end` clamps at 0, so a double call is INVISIBLE through
    // `inFlight` — a vacuity trap for this exact property (AGENTS §9). A
    // counting subclass counts the calls themselves: the leg's close handler and
    // `acceptDevice`'s settle both reach the slot, and only one may win.
    // Mutation: drop the once-guard in `endSlot` -> 2, and with `maxConcurrent`
    // 1 a live handshake's slot is stolen by the dead dial's second decrement.
    const limiter = new CountingLimiter();
    const configDir = store();
    pairPhone(configDir);
    const h = harness({ configDir, limiter });
    await waitFor(() => h.link.isConnected(), "the link to register");
    const phone = await dialPhone(h.link.address);
    // Walk away with nothing sent: the handshake never starts, so the ONLY
    // settle path is the leg's close.
    phone.ws.close();
    await waitFor(() => limiter.ends > 0, "the abandoned stream to release its slot");
    await Bun.sleep(60);
    expect(limiter.begins).toBe(1);
    expect(limiter.ends).toBe(1);
  });

  test("a stream that completes calls end() once too (close after resolve)", async () => {
    const limiter = new CountingLimiter();
    const configDir = store();
    pairPhone(configDir);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const h = harness({ configDir, limiter });
    await waitFor(() => h.link.isConnected(), "the link to register");
    const phone = await dialPhone(h.link.address);
    const secure = await noiseInitiator(phone.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("unused");
      },
      onNotification: () => {},
    });
    await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    });
    // The resolve settles the slot; the later socket close must not settle again.
    await waitFor(() => limiter.ends === 1, "the resolve to end the slot");
    peer.close();
    phone.ws.close();
    await Bun.sleep(80);
    expect(limiter.ends).toBe(1);
  });
});

describe("a phone that walks away mid-handshake frees its limiter slot", () => {
  test("the slot returns exactly once, so the cap is not leaked", async () => {
    const configDir = store();
    pairPhone(configDir);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    // maxConcurrent 1: if the abandoned stream leaked its slot, the next dial
    // could never be admitted and this test would time out.
    const limiter = new HandshakeLimiter({ burst: 100, maxConcurrent: 1 });
    const h = harness({ configDir, limiter });
    await waitFor(() => h.link.isConnected(), "the link to register");
    const first = await dialPhone(h.link.address);
    // Send nothing: the handshake never starts, then close the phone leg.
    first.ws.close();
    await waitFor(() => limiter.inFlight === 0, "the abandoned stream's slot to come back");
    // A second phone is admitted (and completes), proving nothing leaked.
    const second = await dialPhone(h.link.address);
    cleanups.push(() => second.ws.close());
    const secure = await noiseInitiator(second.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("unused");
      },
      onNotification: () => {},
    });
    cleanups.push(() => peer.close());
    const init = (await peer.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(PROTOCOL_VERSION);
    // The second stream is LIVE: the slot it took was free because the
    // abandoned one gave its own back (mutation: drop the leg's close handler ->
    // `inFlight` never returns to 0 and this test times out above).
    expect(h.authority.liveCount()).toBe(1);
  });
});

describe("a key that is not in the registry gets no session (F5/F6, unchanged device path)", () => {
  test("an unknown key is denied over the relay, exactly as on the direct route", async () => {
    const configDir = store();
    pairPhone(configDir);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const h = harness({ configDir });
    await waitFor(() => h.link.isConnected(), "the link to register");
    const phone = await dialPhone(h.link.address);
    cleanups.push(() => phone.ws.close());
    const failure = await noiseInitiator(phone.channel, {
      staticKey: key(9),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(NoiseError);
    expect((failure as NoiseError).kind).toBe("denied");
    expect(h.authority.liveCount()).toBe(0);
  });
});

describe("stop", () => {
  test("stop closes the control socket and every accept leg, and is idempotent", async () => {
    const configDir = store();
    pairPhone(configDir);
    const h = harness({ configDir });
    await waitFor(() => h.link.isConnected(), "the link to register");
    expect(h.relay.core.registeredCount).toBe(1);
    h.link.stop();
    await waitFor(() => h.relay.core.registeredCount === 0, "the registration to go");
    expect(h.link.isConnected()).toBe(false);
    expect(h.link.openStreams()).toBe(0);
    h.link.stop(); // idempotent
  });
});

describe("a dead-but-open control path reconnects (F2, R0(c))", () => {
  test("a relay that never answers `ping` is dropped and the link dials again", async () => {
    // R0(c) measured that Bun's client NEVER notices a dead TCP path (70 s,
    // state still `open`). So this fake relay answers `hello` and then ignores
    // every `ping`: only the app-level deadline can save the link.
    // Mutation: drop the `live.expired(at)` branch in `startLiveness` -> the
    // link stays `connected` forever and no second `hello` ever arrives.
    let hellos = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string };
          if (frame.t !== "hello") return; // a `ping` is ignored: a dead path
          hellos += 1;
          ws.send(JSON.stringify({ t: "ready", v: 1, id: ID, features: [] }));
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const configDir = store();
    pairPhone(configDir);
    const audit: string[] = [];
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: `ws://127.0.0.1:${server.port}`,
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      onAudit: (line) => audit.push(line),
      // Seconds instead of 25/10, and no jitter, so the deadline is observable
      // without waiting for production numbers.
      liveness: { pingMs: 20, pongMs: 20 },
      seeds: { now: () => Date.now(), random: () => 0 },
      timers: {
        setTimeout: (fn, ms) => {
          const h = setTimeout(fn, ms);
          (h as { unref?: () => void }).unref?.();
          return h;
        },
        clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        setInterval: (fn, ms) => {
          const h = setInterval(fn, ms);
          (h as { unref?: () => void }).unref?.();
          return h;
        },
        clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      },
    });
    cleanups.push(() => link.stop());
    await waitFor(() => hellos >= 1, "the first registration");
    await waitFor(
      () => audit.includes("relay-down timeout"),
      "the missed pong to drop the dead path",
    );
    // …and it actually reconnects: a second `hello` reaches the relay. (The
    // reconnect is jitter-0 here, so `isConnected` may already be true again —
    // the LINE and the second hello are the observable facts.)
    await waitFor(() => hellos >= 2, "the link to dial again after the deadline");
    expect(audit.filter((l) => l === "relay-down timeout")).toHaveLength(1);
  });
});

describe("an unusable relay URL never dials", () => {
  test("a non-loopback ws:// is refused with one line and no connection", async () => {
    // The secret must never cross a network in clear: R5a refuses to START on
    // such a URL; the link refuses to dial one either (defence in depth).
    const configDir = store();
    pairPhone(configDir);
    const audit: string[] = [];
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: "ws://relay.example.com",
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter(),
      dial: () => {
        throw new Error("must not dial an invalid URL");
      },
      onAudit: (line) => audit.push(line),
      timers: frozenTimers(),
    });
    cleanups.push(() => link.stop());
    expect(audit).toContain("relay-down url-invalid");
    expect(link.isConnected()).toBe(false);
  });
});

describe("version skew (F13)", () => {
  test("a relay answering `error:version` is held an hour, with ONE line", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string };
          if (frame.t === "hello") {
            ws.send(
              JSON.stringify({
                t: "error",
                code: "version",
                supported: [RELAY_PROTOCOL_VERSION + 1],
              }),
            );
          }
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const configDir = store();
    pairPhone(configDir);
    const delay: number[] = [];
    const timers: RelayLinkTimers = {
      setTimeout: (fn, ms) => {
        delay.push(ms);
        void fn;
        return 1;
      },
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {},
    };
    const audit: string[] = [];
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: `ws://127.0.0.1:${server.port}`,
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      onAudit: (line) => audit.push(line),
      timers,
      seeds: { now: () => 0, random: () => 0.5 },
    });
    cleanups.push(() => link.stop());
    await waitFor(() => delay.length > 0, "the version hold to be scheduled");
    expect(delay[0]).toBe(3_600_000);
    expect(audit.filter((l) => l === "relay-down version")).toHaveLength(1);
  });
});

describe("an oversize control frame cannot be looped into a memory allocation (F7, R4 review 1)", () => {
  test("a `ready` after an oversize frame does not reset the oversize backoff", () => {
    // R0(b)/(d): Bun materialises the frame before any handler runs and a client
    // constructor ignores `maxPayloadLength`, so an oversize frame has already
    // been allocated by the time we see it. What we CAN refuse is being dialled
    // into the same allocation in a tight loop: a hostile relay sends `ready`
    // (which normally resets the backoff) and then a 200 KiB frame, over and over.
    // Mutation: let `ready` reset the counter the oversize wait reads (i.e. use
    // `attempt` for `oversize` too) -> every cycle waits the same ~1 s, the
    // review's [991, 991, 991, 991, 991], and the allocation happens about once
    // a second, forever.
    const h = fakeHarness({ random: () => 0.99 });
    const delays: number[] = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const host = h.control();
      host.onOpen?.();
      host.onMessage?.(readyFrame()); // the relay proves it knows our id…
      host.onMessage?.(`{"t":"ping"}${"x".repeat(200 * 1024)}`); // …then 200 KiB
      const next = h.timers.pending.pop();
      if (next === undefined) throw new Error("no retry was scheduled");
      delays.push(next.ms);
      next.fn();
    }
    // The waits GROW, cycle after cycle, even though EVERY cycle had a `ready`:
    // that is the whole finding. (The pre-fix run was [991, 991, 991, 991, 991]
    // with `relay-down closed`, precisely because `ready` reset the counter.)
    expect(delays).toHaveLength(5);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThan(delays[i - 1] ?? 0);
    }
    // …and it is the OVERSIZE reason we are on, not a generic close.
    expect(h.audit).toContain("relay-down oversize");
    expect(h.audit).not.toContain("relay-down closed");
  });

  test("the oversize backoff outlives the `ready` that follows it", () => {
    // The same loop seen one step at a time: after a retry the relay registers
    // again and immediately oversizes again. The second wait must be strictly
    // longer — with the shared counter it is the same first step again.
    // Mutation: `backoffCounterFor` returns `attempt` for `oversize`.
    const h = fakeHarness({ random: () => 0.99 });
    const first = h.control();
    first.onOpen?.();
    first.onMessage?.(readyFrame());
    first.onMessage?.(`{"t":"ping"}${"x".repeat(200 * 1024)}`);
    expect(h.link.isConnected()).toBe(false);
    const retry = h.timers.pending.pop();
    if (retry === undefined) throw new Error("no retry was scheduled");
    retry.fn();
    const second = h.control();
    second.onOpen?.();
    second.onMessage?.(readyFrame());
    second.onMessage?.(`{"t":"ping"}${"x".repeat(200 * 1024)}`);
    const again = h.timers.pending.pop();
    if (again === undefined) throw new Error("no second retry was scheduled");
    expect(again.ms).toBeGreaterThan(retry.ms);
  });
});

describe("`open` before an accepted `ready` is refused (F7, R4 review 1)", () => {
  test("no `ready` at all means no accept dial and no limiter slot", () => {
    // The `ready.id` check is only worth anything if `open` NEEDS a `ready`: a
    // relay that never registers gets exactly what a lying one would — an accept
    // leg and a limiter slot — otherwise. Mutation: drop the `ready` guard in
    // the `open` branch -> one `/v1/accept` dial and `openStreams() === 1`.
    const limiter = new CountingLimiter();
    const h = fakeHarness({ limiter });
    const host = h.control();
    host.onOpen?.();
    host.onMessage?.(
      JSON.stringify({
        t: "open",
        stream: encodeBase64Url(new Uint8Array(16).fill(3)),
        ip: "1.2.3.4",
      }),
    );
    expect(h.relay.hosts.filter((s) => s.url.endsWith("/v1/accept"))).toHaveLength(0);
    expect(h.link.openStreams()).toBe(0);
    expect(limiter.begins).toBe(0);
    // …and a stream announced AFTER an accepted `ready` still works, so the
    // guard is on the handshake and not on `open` itself.
    host.onMessage?.(readyFrame());
    host.onMessage?.(
      JSON.stringify({
        t: "open",
        stream: encodeBase64Url(new Uint8Array(16).fill(4)),
        ip: "1.2.3.4",
      }),
    );
    expect(h.relay.hosts.filter((s) => s.url.endsWith("/v1/accept"))).toHaveLength(1);
    expect(limiter.begins).toBe(1);
  });
});

describe("a control-socket close leaves live streams alone (F2, R4 review 1)", () => {
  test("the relay dropping control does not detach a phone mid-session", () => {
    // The relay's own semantics (`apps/relay/src/relay-core.ts`: "its streams
    // live on, F2"): a control socket is per-registration, and a stream is a
    // separate splice of two sockets. One control blip must not kill every live
    // phone. Mutation: `dropStreams()` in the control `setOnClose` handler ->
    // the leg is closed and `openStreams()` is 0 below.
    const h = fakeHarness();
    const host = h.control();
    host.onOpen?.();
    host.onMessage?.(readyFrame());
    host.onMessage?.(
      JSON.stringify({
        t: "open",
        stream: encodeBase64Url(new Uint8Array(16).fill(5)),
        ip: "1.2.3.4",
      }),
    );
    const leg = h.relay.hosts.find((s) => s.url.endsWith("/v1/accept"));
    if (leg === undefined) throw new Error("the accept leg was not dialled");
    leg.onOpen?.();
    expect(h.link.openStreams()).toBe(1);
    // The relay drops ONLY the control socket.
    host.onClose?.({});
    expect(leg.closed).toBe(false);
    expect(h.link.openStreams()).toBe(1);
    expect(h.link.isConnected()).toBe(false);
    // `stop()` is still what closes every leg.
    h.link.stop();
    expect(leg.closed).toBe(true);
    expect(h.link.openStreams()).toBe(0);
  });
});

describe("E2E v2 over the relay leg (docs/feat/noise-binary-carrier.md)", () => {
  test("T-D2: the `accept` frame is JSON text; a leg delivering bytes completes the handshake", async () => {
    const h = fakeHarness();
    const identity = readIdentity(h.configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const host = h.control();
    host.onOpen?.();
    host.onMessage?.(readyFrame());
    host.onMessage?.(
      JSON.stringify({
        t: "open",
        stream: encodeBase64Url(new Uint8Array(16).fill(6)),
        ip: "1.2.3.4",
      }),
    );
    const leg = h.relay.hosts.find((s) => s.url.endsWith("/v1/accept"));
    if (leg === undefined) throw new Error("the accept leg was not dialled");
    leg.onOpen?.();
    const [acceptFrame] = leg.sent;
    expect(typeof acceptFrame).toBe("string");
    expect(JSON.parse(acceptFrame as string)).toMatchObject({ t: "accept" });
    // The phone end: its bytes reach the leg's handler; the leg's sends come back.
    let toPhone: ((f: CarrierFrame) => void) | undefined;
    let pumped = 1;
    const pump = setInterval(() => {
      while (pumped < leg.sent.length) {
        const f = leg.sent[pumped++];
        if (f !== undefined) toPhone?.(f);
      }
    }, 1);
    try {
      const phone: ByteCarrier = {
        send: (d) => queueMicrotask(() => leg.onMessage?.(d)),
        close: () => leg.onClose?.({}),
        setOnMessage: (fn) => {
          toPhone = fn;
        },
        setOnClose: () => {},
      };
      const secure = await noiseInitiator(phone, {
        staticKey: key(2),
        remoteStatic: identity.identity.publicKey,
        random: systemRandom,
      });
      expect(secure.remoteStatic).toEqual(identity.identity.publicKey);
      // Everything the daemon sent after `accept` was binary.
      expect(leg.sent.slice(1).every((f) => f instanceof Uint8Array)).toBe(true);
      expect(leg.sent.length).toBeGreaterThan(1);
      secure.close();
    } finally {
      clearInterval(pump);
    }
  });

  test("T-D2: a binary frame on the control socket is a close, never a parse", () => {
    // The bytes of a VALID `ready`: decoded and parsed, they would register the link.
    const h = fakeHarness();
    const host = h.control();
    host.onOpen?.();
    host.onMessage?.(new TextEncoder().encode(readyFrame()));
    expect(h.link.isConnected()).toBe(false);
    expect(host.closed).toBe(true);
    expect(h.audit).toContain("relay-down closed");
  });
});
