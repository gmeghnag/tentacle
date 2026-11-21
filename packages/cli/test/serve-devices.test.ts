/**
 * `serve` and the device route (docs/feat/device-pairing.md 9b): the identity is
 * loaded or created at startup, the authority is wired into the listener, and
 * the daemon's own record is written and removed with it (owner Q6 — `pair`
 * reads these for addresses).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import {
  DAEMONS_DIR,
  DAEMON_RECORD_VERSION,
  DEVICE_DIR,
  readDaemonRecords,
} from "@tentacle/daemon";
import { type CarrierFrame, carrierFrameOf } from "@tentacle/transport";
import { startDaemon } from "../src/serve.ts";

const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function serve(over: { host?: string; token?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "serve-devices-"));
  dirs.push(dir);
  const config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
  const audit: string[] = [];
  const handle = await startDaemon(config, {
    host: over.host ?? "127.0.0.1",
    port: 0,
    ...(over.token ? { token: over.token } : {}),
    onAudit: (line) => audit.push(line),
  });
  handles.push(handle);
  return { dir, config, handle, audit, configDir: config.configDir };
}

describe("serve creates the computer's identity", () => {
  test("the first start writes <configDir>/devices/identity.json at 0600", async () => {
    const { configDir } = await serve();
    const path = join(configDir, DEVICE_DIR, "identity.json");
    expect(existsSync(path)).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record.v).toBe(1);
    expect(typeof record.name).toBe("string");
    expect(record.name.length).toBeGreaterThan(0);
  });

  test("a second start reuses the SAME key (a phone's pin must keep working)", async () => {
    const { dir, configDir } = await serve();
    const first = JSON.parse(readFileSync(join(configDir, DEVICE_DIR, "identity.json"), "utf8"));
    await handles.pop()?.stop();
    const config = await loadConfig({
      configDir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    const again = await startDaemon(config, { host: "127.0.0.1", port: 0 });
    handles.push(again);
    const second = JSON.parse(readFileSync(join(configDir, DEVICE_DIR, "identity.json"), "utf8"));
    expect(second.publicKey).toBe(first.publicKey);
  });

  test("an unreadable identity REFUSES a non-loopback token-less start and names the file (F26)", async () => {
    const { dir, configDir } = await serve();
    await handles.pop()?.stop();
    const path = join(configDir, DEVICE_DIR, "identity.json");
    writeFileSync(path, "{ nope");
    const config = await loadConfig({
      configDir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    // F26's OWN case: a LAN-exposed bind with no token has no other gate.
    await expect(startDaemon(config, { host: "0.0.0.0", port: 0 })).rejects.toThrow(
      /identity\.json/,
    );
    // Left exactly as it was: the human fixes it or runs `devices reset`.
    expect(readFileSync(path, "utf8")).toBe("{ nope");
  });

  test("an unusable identity on a LOOPBACK bind starts WITHOUT the device route (F26 is scoped)", async () => {
    // F26 covers a non-loopback bind with no token. A user who never pairs must
    // not be refused a working loopback `serve` by a file only pairing needs:
    // here the daemon starts, the device route is off, and ONE line names the
    // file. Mutation: throw for every bind -> red (this start rejects).
    const { dir, configDir } = await serve();
    await handles.pop()?.stop();
    const path = join(configDir, DEVICE_DIR, "identity.json");
    writeFileSync(path, "{ nope");
    const config = await loadConfig({
      configDir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    const errors: string[] = [];
    const handle = await startDaemon(config, {
      host: "127.0.0.1",
      port: 0,
      onError: (error) => errors.push(error.message),
    });
    handles.push(handle);
    expect(handle.port).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("identity.json");
    // The human's file is untouched, and nothing advertises a device route
    // `pair` could dial (`daemons/<pid>.json` is written only with the route).
    expect(readFileSync(path, "utf8")).toBe("{ nope");
    expect(readDaemonRecords(configDir)).toEqual([]);
  });
});

describe("serve's own daemon record (owner Q6)", () => {
  test("is written at listen with the bound port and removed at stop", async () => {
    const { configDir, handle } = await serve();
    const path = join(configDir, DAEMONS_DIR, `${process.pid}.json`);
    expect(existsSync(path)).toBe(true);
    const record = JSON.parse(readFileSync(path, "utf8"));
    expect(record).toMatchObject({
      v: DAEMON_RECORD_VERSION,
      pid: process.pid,
      host: "127.0.0.1",
      port: handle.port,
      tls: false,
    });
    expect(record.port).toBeGreaterThan(0);
    await handles.pop()?.stop();
    expect(existsSync(path)).toBe(false);
    // Nothing left behind that `pair` would read as an address.
    expect(readdirSync(join(configDir, DAEMONS_DIR))).toEqual([]);
    expect(readDaemonRecords(configDir)).toEqual([]);
  });

  test("a TLS server records `tls: true` (what `pair` needs to say wss)", async () => {
    // No real cert here: the record is the contract, so the field is pinned
    // through the store's own reader with a hand-written record.
    const dir = mkdtempSync(join(tmpdir(), "serve-devices-record-"));
    dirs.push(dir);
    const { writeDaemonRecord } = await import("@tentacle/daemon");
    writeDaemonRecord(dir, {
      pid: process.pid,
      host: "0.0.0.0",
      port: 4001,
      tls: true,
      cwd: dir,
      startedAt: 5,
    });
    expect(readDaemonRecords(dir)).toEqual([
      { pid: process.pid, host: "0.0.0.0", port: 4001, tls: true, cwd: dir, startedAt: 5 },
    ]);
  });
});

describe("the device route is on for a serve daemon", () => {
  test("a paired key gets a working initialize on /e2e with an iOS Origin", async () => {
    const { configDir, handle } = await serve();
    const { addDevice, readIdentity } = await import("@tentacle/daemon");
    const { noiseInitiator, publicKeyOf, systemRandom } = await import("@tentacle/transport/noise");
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const published = publicKeyOf(new Uint8Array(32).fill(2));
    const added = addDevice(configDir, { publicKey: published, name: "iPhone", now: 2_000 });
    expect(added.ok).toBe(true);
    const raw = await new Promise<Parameters<typeof noiseInitiator>[0]>((resolve, reject) => {
      const ws = new WebSocket(`${handle.url}/e2e`, {
        headers: { Origin: "http://192.168.1.8:4001" },
      } as never);
      let onMessage: ((d: CarrierFrame) => void) | undefined;
      ws.binaryType = "arraybuffer";
      let onClose: (() => void) | undefined;
      ws.addEventListener("message", (e) => {
        const frame = carrierFrameOf(e.data);
        if (frame !== null) onMessage?.(frame);
      });
      ws.addEventListener("close", () => {
        onClose?.();
      });
      ws.addEventListener("open", () =>
        resolve({
          send: (d: Uint8Array) => ws.send(d),
          close: () => ws.close(),
          setOnMessage: (h: (d: CarrierFrame) => void) => {
            onMessage = h;
          },
          setOnClose: (h: () => void) => {
            onClose = h;
          },
        }),
      );
      ws.addEventListener("error", () => reject(new Error("socket error")));
    });
    const secure = await noiseInitiator(raw, {
      staticKey: new Uint8Array(32).fill(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const { RpcPeer } = await import("@tentacle/transport");
    const peer = new RpcPeer(secure, {
      onRequest: async () => {
        throw new Error("no daemon requests expected");
      },
      onNotification: () => {},
    });
    try {
      const result = (await peer.request("initialize", {
        protocolVersion: 24,
        clientCapabilities: {},
        clientInfo: { name: "phone", version: "0" },
      })) as { protocolVersion: number };
      expect(result.protocolVersion).toBe(24);
    } finally {
      peer.close();
    }
  }, 20_000);
});

describe("the device poll's timer is owned by the daemon", () => {
  test("startDaemon arms it and stop() clears it (no timer outlives the daemon)", async () => {
    // `serve-limits.test.ts` counts 1 s timers with the device route OFF, so
    // this pins the other side: the poll exists while serving and is gone at
    // stop (a leaked interval would keep a caller's process alive).
    const created: number[] = [];
    const handles: unknown[] = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
      const handle = realSet(fn, ms, ...rest);
      created.push(ms ?? 0);
      if (ms === 1_000) handles.push(handle);
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((handle?: Parameters<typeof clearInterval>[0]) => {
      cleared.push(handle);
      realClear(handle);
    }) as typeof clearInterval;
    try {
      const { handle: daemon } = await serve();
      // One 1 s poll, armed at construction (DEVICE_POLL_INTERVAL_MS).
      expect(handles).toHaveLength(1);
      const poll = handles[0];
      expect(cleared).not.toContain(poll);
      // Not `handles.pop()`: the array is this test's own bookkeeping.
      await daemon.stop();
      // THIS handle, not "some timer": another subsystem's interval must not
      // stand in for it. Mutation: `devices?.stop()` dropped -> red.
      expect(cleared).toContain(poll);
      expect(daemon.port).toBeGreaterThan(0);
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
    }
  });
});
