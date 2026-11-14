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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAY_PROTOCOL_VERSION, encodeBase64Url, relayAddress } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import { RpcPeer } from "@tentacle/transport";
import { NoiseError, noiseInitiator, publicKeyOf, systemRandom } from "@tentacle/transport/noise";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { DeviceAuthority } from "../src/device-authority.ts";
import {
  addDevice,
  loadOrCreateIdentity,
  openPairing,
  readIdentity,
  readSeen,
  removeDevices,
} from "../src/device-store.ts";
import { HandshakeLimiter } from "../src/handshake-limit.ts";
import {
  type RelayLinkTimers,
  type RunningRelayLink,
  bunRelayDialer,
  startRelayLink,
} from "../src/relay-link.ts";
import { SessionHost } from "../src/session-host.ts";

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
  const streams = new Map<string, { phone?: unknown; accept?: unknown; early?: string[] }>();
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
        const text = String(raw);
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
          const record: { phone?: unknown; accept?: unknown; early?: string[] } = {
            phone: ws,
            early: [text],
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
            const phone = pair?.[1].phone as { send(d: string): void } | undefined;
            if (!phone) return;
            data.forwarded = (data.forwarded ?? 0) + 1;
            phone.send(data.forwarded === options.flipNth ? flipOneChar(text) : text);
          }
          return;
        }
        const pair = streams.get(data.stream ?? "");
        const accept = pair?.accept as { send(d: string): void } | undefined;
        if (!accept) {
          // Held for the daemon's accept leg, exactly like the real relay.
          pair?.early?.push(text);
          return;
        }
        accept.send(text);
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
 * Flip one character in the middle of a `t1:<base64>` Noise frame: a changed
 * CIPHERTEXT byte, which the AEAD must reject (touching the `t1:` prefix instead
 * would only test the frame-shape guard, a different property).
 */
function flipOneChar(text: string): string {
  const chars = [...text];
  const at = Math.floor(chars.length / 2);
  const original = chars[at] ?? "A";
  chars[at] = original === "A" ? "B" : "A";
  return chars.join("");
}

/** A phone's `DuplexChannel` over a real WebSocket at the relay address. */
function dialPhone(url: string): Promise<{ channel: DuplexChannel; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let onMessage: ((d: string) => void) | undefined;
    let onClose: (() => void) | undefined;
    ws.addEventListener("message", (e) => onMessage?.(String(e.data)));
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
    const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
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
      protocolVersion: 24,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(24);
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
      protocolVersion: 24,
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
    const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
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
      protocolVersion: 24,
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
      protocolVersion: 24,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    })) as { protocolVersion: number };
    expect(init.protocolVersion).toBe(24);
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
    const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
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
    const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
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
    const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
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
