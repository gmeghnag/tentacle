/**
 * Per-project pairing, daemon side (docs/feat/mobile-projects.md §1–§5, slice
 * (a) feat/project-pairing). The property: a device key opens ONE `serve` (the
 * project it was paired to, or — for a legacy key — the first project that
 * completes a handshake with it), a pairing window admits strangers only on its
 * own project's serve, and a serve with no device of its own never wants the
 * relay. Each test names the mutation that turns it red.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonDiscovery } from "@tentacle/protocol";
import { type DuplexChannel, RpcPeer, createChannelPair } from "@tentacle/transport";
import { noiseInitiator, publicKeyOf, systemRandom } from "@tentacle/transport/noise";
import { Connection } from "../src/connection.ts";
import { acceptDevice } from "../src/device-accept.ts";
import { DeviceAuthority } from "../src/device-authority.ts";
import {
  ADOPTED_DIR,
  DEVICE_DIR,
  DEVICE_STORE_VERSION,
  REGISTRY_FILENAME,
  addDevice,
  claimPairing,
  deviceIdOf,
  findPairing,
  hasLivePairing,
  loadOrCreateIdentity,
  openPairing,
  readAdoption,
  readIdentity,
  readRegistry,
  removeDevices,
} from "../src/device-store.ts";
import { PairHandler } from "../src/pairing-handler.ts";
import { type DiscoverySource, SessionHost } from "../src/session-host.ts";
import { deviceRouteOf, startWsServer } from "../src/ws-server.ts";

const P = { key: "tentacle-aaaaaaaaaaaa", cwd: "/u/tentacle" };
const Q = { key: "assistant-bbbbbbbbbbbb", cwd: "/u/assistant" };
const CODE = "K7M2QX9AB3";

const dirs: string[] = [];
const stops: { stop(): void }[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const devicesDir = (configDir: string) => join(configDir, DEVICE_DIR);

function store(): string {
  const configDir = mkdtempSync(join(tmpdir(), "project-pairing-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "gabriel-mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  return configDir;
}

function authority(
  configDir: string,
  project: { key: string; cwd: string },
  audit: string[] = [],
): DeviceAuthority {
  const a = new DeviceAuthority({
    configDir,
    project,
    pollIntervalMs: 10,
    onAudit: (line) => audit.push(line),
  });
  stops.push(a);
  return a;
}

/** A registry exactly as a pre-project build wrote it (v1, no `project`). */
function writeV1Registry(configDir: string, publicKeys: Uint8Array[]): void {
  mkdirSync(devicesDir(configDir), { recursive: true });
  const { encodeBase64Url } = require("@tentacle/protocol") as {
    encodeBase64Url: (b: Uint8Array) => string;
  };
  writeFileSync(
    join(devicesDir(configDir), REGISTRY_FILENAME),
    JSON.stringify({
      v: 1,
      devices: publicKeys.map((pk, i) => ({
        id: deviceIdOf(pk),
        name: `iPhone ${i}`,
        publicKey: encodeBase64Url(pk),
        pairedAt: 1,
      })),
    }),
  );
}

async function until(check: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

/** `acceptDevice` on an in-memory channel for one serve's authority. */
function acceptOn(a: DeviceAuthority, host: SessionHost = dummyHost) {
  const audit: string[] = [];
  const [daemon, phone] = createChannelPair();
  let built = 0;
  let closed = false;
  const wrapped: DuplexChannel = {
    send: (d) => daemon.send(d),
    close: () => {
      closed = true;
      daemon.close();
    },
    setOnMessage: (h) => daemon.setOnMessage(h),
    setOnClose: (h) =>
      daemon.setOnClose(() => {
        closed = true;
        h();
      }),
  };
  const accepted = acceptDevice(wrapped, {
    authority: a,
    sessionHost: host,
    isClosed: () => closed,
    onAudit: (line) => audit.push(line),
    onConnection: () => {
      built += 1;
    },
  });
  stops.push({ stop: accepted.release });
  // `closed`: the daemon closed its end (the phone's own close handler belongs to
  // the Noise layer once it runs, so the daemon end is what is observed).
  return { phone, audit, built: () => built, closedByDaemon: () => closed };
}

async function handshake(phone: DuplexChannel, privateKey: Uint8Array, computer: Uint8Array) {
  const secure = await noiseInitiator(phone, {
    staticKey: privateKey,
    remoteStatic: computer,
    random: systemRandom,
  });
  const peer = new RpcPeer(secure, {
    onRequest: async () => {
      throw new Error("unused");
    },
    onNotification: () => {},
  });
  stops.push({ stop: () => peer.close() });
  return peer;
}

const initialize = (peer: RpcPeer) =>
  peer.request("initialize", {
    protocolVersion: 24,
    clientCapabilities: {},
    clientInfo: { name: "phone", version: "0" },
  });

function computerKey(configDir: string): Uint8Array {
  const identity = readIdentity(configDir);
  if (!identity.ok) throw new Error(identity.reason);
  return identity.identity.publicKey;
}

describe("the verdict is per project (the repro's (1)+(2), inverted)", () => {
  test("a key paired to P is a device on P's serve and DENIED on Q's", () => {
    // Mutation: skip the project comparison in the snapshot → Q says `device`.
    const configDir = store();
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: P });
    const onP = authority(configDir, P).authorize(publicKeyOf(key(2)));
    const onQ = authority(configDir, Q).authorize(publicKeyOf(key(2)));
    expect(onP !== false && onP.kind).toBe("device");
    expect(onQ).toBe(false);
  });

  test("a window opened for P admits a stranger on P only", () => {
    // Mutation: an unfiltered `hasLivePairing` → Q says `pairing`.
    const configDir = store();
    openPairing(configDir, { code: CODE, project: P });
    const onP = authority(configDir, P).authorize(publicKeyOf(key(9)));
    const onQ = authority(configDir, Q).authorize(publicKeyOf(key(9)));
    expect(onP !== false && onP.kind).toBe("pairing");
    expect(onQ).toBe(false);
    expect(hasLivePairing(configDir, { project: Q.key })).toBeUndefined();
    expect(hasLivePairing(configDir, { project: P.key })).toBeDefined();
  });

  test("`wantsReachability`: only a device or a window OF THIS PROJECT dials the relay", () => {
    // Mutations: count every registry entry; count unadopted legacy entries.
    const configDir = store();
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: P });
    const p = authority(configDir, P);
    const q = authority(configDir, Q);
    expect(p.wantsReachability()).toBe(true);
    expect(q.wantsReachability()).toBe(false); // the repro's (3), inverted
    openPairing(configDir, { code: CODE, project: Q });
    expect(q.wantsReachability()).toBe(true);
  });

  test("an unadopted legacy entry dials nobody's relay", () => {
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    expect(authority(configDir, P).wantsReachability()).toBe(false);
    expect(authority(configDir, Q).wantsReachability()).toBe(false);
  });

  test("`knows` (the push-time check) is scoped: Q's notifier never pushes to P's device", () => {
    const configDir = store();
    const added = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      project: P,
    });
    if (!added.ok) throw new Error(added.reason);
    expect(authority(configDir, P).knows(added.device.id)).toBe(true);
    expect(authority(configDir, Q).knows(added.device.id)).toBe(false);
  });
});

describe("legacy adoption: today's phone keeps working on the project it uses (§3, Q3)", () => {
  test("a v1 registry reads as all-legacy, and `authorize` writes NOTHING (P1)", () => {
    // Mutation: adopt inside `authorize` → the `adopted/` dir exists after it.
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    const read = readRegistry(configDir);
    expect(read.ok && read.registry.devices[0]?.project).toBeUndefined();
    const onP = authority(configDir, P).authorize(publicKeyOf(key(2)));
    const onQ = authority(configDir, Q).authorize(publicKeyOf(key(2)));
    expect(onP !== false && onP.kind === "device" && onP.adopt).toBe(true);
    expect(onQ !== false && onQ.kind === "device" && onQ.adopt).toBe(true);
    expect(existsSync(join(devicesDir(configDir), ADOPTED_DIR))).toBe(false);
  });

  test("the first handshake on P adopts the key; Q then denies it; no re-pairing on P", async () => {
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    const id = deviceIdOf(publicKeyOf(key(2)));
    const p = authority(configDir, P);
    const h = acceptOn(p);
    const peer = await handshake(h.phone, key(2), computerKey(configDir));
    await initialize(peer); // a working device connection, zero steps
    expect(h.built()).toBe(1);
    const adoption = readAdoption(configDir, id);
    expect(adoption.kind === "bound" && adoption.project.key).toBe(P.key);
    expect(h.audit).toContain(`legacy-device-adopted ${id.slice(0, 8)} ${P.key}`);
    expect(authority(configDir, Q).authorize(publicKeyOf(key(2)))).toBe(false);
    const again = p.authorize(publicKeyOf(key(2)));
    expect(again !== false && again.kind === "device" && again.adopt).toBeUndefined();
    expect(p.wantsReachability()).toBe(true);
  });

  test("the same legacy key resolving on P and Q at once: ONE adoption, the loser closed before any frame (F11)", async () => {
    // Mutation: a plain overwrite instead of the exclusive create → both build.
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    const id = deviceIdOf(publicKeyOf(key(2)));
    const onP = acceptOn(authority(configDir, P));
    const onQ = acceptOn(authority(configDir, Q));
    const computer = computerKey(configDir);
    await Promise.all([
      handshake(onP.phone, key(2), computer),
      handshake(onQ.phone, key(2), computer),
    ]);
    await until(
      () => onP.built() + onQ.built() === 1 && (onP.closedByDaemon() || onQ.closedByDaemon()),
    );
    expect(onP.built() + onQ.built()).toBe(1);
    const loser = onP.built() === 1 ? onQ : onP;
    const winner = onP.built() === 1 ? P : Q;
    expect(loser.built()).toBe(0); // no `Connection`: no frame was ever dispatched
    expect(loser.closedByDaemon()).toBe(true);
    expect(loser.audit).toContain(`legacy-device-bound-elsewhere ${id.slice(0, 8)} ${winner.key}`);
    const adoption = readAdoption(configDir, id);
    expect(adoption.kind === "bound" && adoption.project.key).toBe(winner.key);
  });

  test("an unreadable adoption record denies everywhere and is never rewritten (F16)", () => {
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    const id = deviceIdOf(publicKeyOf(key(2)));
    mkdirSync(join(devicesDir(configDir), ADOPTED_DIR), { recursive: true });
    const path = join(devicesDir(configDir), ADOPTED_DIR, `${id}.json`);
    writeFileSync(path, "{garbage");
    expect(authority(configDir, P).authorize(publicKeyOf(key(2)))).toBe(false);
    expect(authority(configDir, Q).authorize(publicKeyOf(key(2)))).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{garbage");
  });

  test("`revoke` removes the adoption with the device", async () => {
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    const id = deviceIdOf(publicKeyOf(key(2)));
    const h = acceptOn(authority(configDir, P));
    await handshake(h.phone, key(2), computerKey(configDir));
    await until(() => readAdoption(configDir, id).kind === "bound");
    expect(removeDevices(configDir, [id]).ok).toBe(true);
    expect(readAdoption(configDir, id).kind).toBe("none");
  });
});

describe("registry v2 on disk (P3)", () => {
  test("round-trips `project`; a legacy entry stays legacy across a v2 rewrite", () => {
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    expect(
      addDevice(configDir, { publicKey: publicKeyOf(key(3)), name: "iPhone", project: P }).ok,
    ).toBe(true);
    const raw = JSON.parse(readFileSync(join(devicesDir(configDir), REGISTRY_FILENAME), "utf8"));
    expect(raw.v).toBe(2);
    // An older build reads with `DEVICE_STORE_VERSION` (1) and refuses `v: 2`:
    // it then denies every device — fail closed (F9).
    expect(raw.v).not.toBe(DEVICE_STORE_VERSION);
    expect(Object.hasOwn(raw.devices[0], "project")).toBe(false);
    expect(raw.devices[1].project).toEqual(P);
    const read = readRegistry(configDir);
    expect(read.ok && read.registry.devices.map((d) => d.project)).toEqual([undefined, P]);
  });

  test("a v1 file carrying a `project` is malformed (refused, not trusted)", () => {
    const configDir = store();
    writeV1Registry(configDir, [publicKeyOf(key(2))]);
    const path = join(devicesDir(configDir), REGISTRY_FILENAME);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.devices[0].project = P;
    writeFileSync(path, JSON.stringify(raw));
    expect(readRegistry(configDir).ok).toBe(false);
  });

  test("one entry = one key = one serve: the same key for another project is refused", () => {
    const configDir = store();
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: P });
    expect(
      addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: Q }).ok,
    ).toBe(false);
    // The same project again is idempotent.
    expect(
      addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: P }).ok,
    ).toBe(true);
  });

  test("names dedupe WITHIN a project: the same phone is 'iPhone' in every project", () => {
    const configDir = store();
    const a = addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: P });
    const b = addDevice(configDir, { publicKey: publicKeyOf(key(3)), name: "iPhone", project: Q });
    const c = addDevice(configDir, { publicKey: publicKeyOf(key(4)), name: "iPhone", project: P });
    expect([a, b, c].map((r) => (r.ok ? r.device.name : r.reason))).toEqual([
      "iPhone",
      "iPhone",
      "iPhone (2)",
    ]);
  });
});

describe("a window is spent only by its own project (F12)", () => {
  test("`findPairing` / `claimPairing` from another project see nothing", () => {
    const configDir = store();
    const opened = openPairing(configDir, { code: CODE, project: P });
    if (!opened.ok) throw new Error(opened.reason);
    expect(findPairing(configDir, { code: CODE, project: Q.key })).toBeUndefined();
    const claim = claimPairing(configDir, {
      sid: opened.session.sid,
      deviceKey: publicKeyOf(key(9)),
      name: "iPhone",
      project: Q.key,
    });
    expect(claim.ok ? "claimed" : claim.reason).toBe("gone");
    expect(findPairing(configDir, { code: CODE, project: P.key })?.sid).toBe(opened.session.sid);
  });

  test("Q's PairHandler answers `invalid_code` for P's right code, and claims nothing", async () => {
    const configDir = store();
    openPairing(configDir, { code: CODE, project: P });
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const handler = new PairHandler({
      configDir,
      project: Q,
      identity: identity.identity,
      remoteStatic: publicKeyOf(key(9)),
    });
    const outcome = await handler.pair({ code: CODE, name: "iPhone", perProject: true });
    expect(outcome.ok ? "paired" : outcome.reason).toBe("invalid_code");
    expect(findPairing(configDir, { code: CODE, project: P.key })).toBeDefined();
  });

  test("a pair WITHOUT `perProject` (an older app) is `update_app`, spending nothing (F10)", async () => {
    // Mutation: drop the gate → the older app's claim is written.
    const configDir = store();
    const opened = openPairing(configDir, { code: CODE, project: P });
    if (!opened.ok) throw new Error(opened.reason);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const handler = new PairHandler({
      configDir,
      project: P,
      identity: identity.identity,
      remoteStatic: publicKeyOf(key(9)),
    });
    const outcome = await handler.pair({ code: CODE, name: "iPhone" });
    expect(outcome.ok ? "paired" : outcome.reason).toBe("update_app");
    expect(handler.attemptCount).toBe(0);
    expect(
      existsSync(join(devicesDir(configDir), "pairing", `${opened.session.sid}.claim.json`)),
    ).toBe(false);
  });
});

describe("the device route names its serve (§5, Owner Q5)", () => {
  test("`deviceRouteOf`: `/e2e` and `/s/<mine>/e2e` are mine; `/s/<other>/e2e` is elsewhere", () => {
    // Mutation: accept any `/s/*` → `elsewhere` reads `device`.
    expect(deviceRouteOf("/e2e", "MINE")).toBe("device");
    expect(deviceRouteOf("/s/MINE/e2e", "MINE")).toBe("device");
    expect(deviceRouteOf("/s/OTHER/e2e", "MINE")).toBe("elsewhere");
    expect(deviceRouteOf("/s/MINE/e2e", undefined)).toBe("elsewhere");
    expect(deviceRouteOf("/s/a/b/e2e", "MINE")).toBe("none");
    expect(deviceRouteOf("/sessions", "MINE")).toBe("none");
  });

  test("over a real socket: `/s/<other>/e2e` is a 404 before upgrade; `/s/<mine>/e2e` and `/e2e` handshake", async () => {
    const configDir = store();
    addDevice(configDir, { publicKey: publicKeyOf(key(2)), name: "iPhone", project: P });
    const audit: string[] = [];
    const server = startWsServer({
      host: "127.0.0.1",
      port: 0,
      sessionHost: dummyHost,
      devices: { authority: authority(configDir, P, audit), serveId: "MINE" },
      onAudit: (line) => audit.push(line),
    });
    stops.push(server);
    const http = server.url.replace(/^ws/, "http");
    const other = await fetch(`${http}/s/OTHER/e2e`);
    expect(other.status).toBe(404);
    expect(
      audit.some((line) => line.startsWith("e2e-rate-limited") || line.startsWith("auth-failure")),
    ).toBe(false);
    for (const path of ["/s/MINE/e2e", "/e2e"]) {
      const raw = await new Promise<DuplexChannel>((resolve, reject) => {
        const ws = new WebSocket(`${server.url}${path}`);
        let onMessage: ((d: string) => void) | undefined;
        let onClose: (() => void) | undefined;
        ws.addEventListener("message", (e) => onMessage?.(String(e.data)));
        ws.addEventListener("close", () => onClose?.());
        ws.addEventListener("error", () => reject(new Error(`dial ${path}`)));
        ws.addEventListener("open", () =>
          resolve({
            send: (d) => ws.send(d),
            close: () => ws.close(),
            setOnMessage: (h) => {
              onMessage = h;
            },
            setOnClose: (h) => {
              onClose = h;
            },
          }),
        );
      });
      const peer = await handshake(raw, key(2), computerKey(configDir));
      const init = (await initialize(peer)) as { protocolVersion: number };
      expect(init.protocolVersion).toBeGreaterThanOrEqual(24);
      peer.close();
    }
  });
});

describe("`daemon/discover` to a phone is self-only (§4, Owner Q4)", () => {
  const snapshot: DaemonDiscovery = {
    rev: 3,
    daemons: [
      { cwd: P.cwd, addresses: ["ws://192.168.1.20:4000/s/A/e2e"], startedAt: 1, self: true },
      { cwd: Q.cwd, addresses: ["ws://192.168.1.20:4001/s/B/e2e"], startedAt: 2 },
    ],
  };
  const source: DiscoverySource = { current: () => snapshot, subscribe: () => () => {} };

  async function discoverAs(principal: "device" | "token"): Promise<DaemonDiscovery> {
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => {
        throw new Error("unused");
      },
      discovery: source,
    });
    const [daemon, client] = createChannelPair();
    const connection = new Connection(daemon, host, undefined, {
      principal:
        principal === "device" ? { kind: "device", id: "0123456789abcdef" } : { kind: "token" },
    });
    const peer = new RpcPeer(client, {
      onRequest: async () => {
        throw new Error("unused");
      },
      onNotification: () => {},
    });
    try {
      await initialize(peer);
      return (await peer.request("daemon/discover", {})) as DaemonDiscovery;
    } finally {
      peer.close();
      connection.close();
    }
  }

  test("a device principal gets only `self`; a token client gets every sibling", async () => {
    // Mutation: no principal filter → the phone learns Q's address.
    const device = await discoverAs("device");
    expect(device.daemons.map((d) => d.cwd)).toEqual([P.cwd]);
    expect(device.rev).toBe(3);
    const token = await discoverAs("token");
    expect(token.daemons.map((d) => d.cwd)).toEqual([P.cwd, Q.cwd]);
  });
});

describe("a revoke in P closes P's sockets only (F13)", () => {
  test("P's poll closes the revoked key; Q's live key is untouched", async () => {
    const configDir = store();
    const onP = addDevice(configDir, {
      publicKey: publicKeyOf(key(2)),
      name: "iPhone",
      project: P,
    });
    const onQ = addDevice(configDir, {
      publicKey: publicKeyOf(key(3)),
      name: "iPhone",
      project: Q,
    });
    if (!onP.ok || !onQ.ok) throw new Error("add");
    const p = authority(configDir, P);
    const q = authority(configDir, Q);
    let closedP = 0;
    let closedQ = 0;
    p.register(onP.device.id, { close: () => closedP++ });
    q.register(onQ.device.id, { close: () => closedQ++ });
    expect(removeDevices(configDir, [onP.device.id]).ok).toBe(true);
    await until(() => closedP === 1);
    await new Promise((r) => setTimeout(r, 40)); // several more polls of Q
    expect(closedP).toBe(1);
    expect(closedQ).toBe(0);
    expect(q.liveCount()).toBe(1);
  });
});
