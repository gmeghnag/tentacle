/**
 * `serve` and sibling discovery (docs/feat/sibling-discovery.md): `--address`
 * lands in the daemon's record, the driver starts with the listener and stops
 * with it, and a REAL client on one `serve` learns its siblings over the wire.
 *
 * Red before the feature: `daemon/discover` did not exist, so `discover()`
 * resolved `undefined` and no address was ever announced.
 *
 * The one hard limit of an end-to-end test here: a `serve` binds loopback with
 * no token only for a loopback bind, and two daemons can share one config dir
 * only because each project gets its own store (AGENTS §7) — which is exactly
 * the sibling case, so the rig is the real thing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, webSocketChannelFactory } from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import {
  type DaemonRecord,
  readDaemonRecords,
  removeDaemonRecord,
  writeDaemonRecord,
} from "@tentacle/daemon";
import { Connection, SessionHost } from "@tentacle/daemon";
import type { DaemonDiscovery } from "@tentacle/protocol";
import { createChannelPair } from "@tentacle/transport";
import { startDaemon } from "../src/serve.ts";

const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];
const clients: RemoteClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of handles.splice(0)) await h.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Over = {
  readonly addresses?: readonly string[];
  readonly discovery?: boolean;
};

/**
 * One `serve` on loopback in its own project, sharing `configDir`.
 *
 * A SIBLING has to be another PROCESS: the record's file name is the pid
 * (`<pid>.json`), so two `startDaemon` calls in one process collide on it —
 * i.e. one process can only ever BE one daemon, which is the production truth
 * too. So a sibling here is a live child process with a record written for its
 * pid, exactly what another `serve` leaves on disk.
 */
async function serve(root: string, configDir: string, cwd: string, over: Over = {}) {
  const config = await loadConfig({
    configDir,
    cwd,
    scaffold: false,
    env: { HOME: root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    ...(over.addresses ? { addresses: over.addresses } : {}),
    // A sibling poll is 2 s in production; a test cannot wait for it.
    pollMs: 20,
    heartbeatMs: 20,
    // Discovery OFF: the `serve`-writes-the-record half only.
    ...(over.discovery === false ? { discovery: false } : {}),
  });
  handles.push(handle);
  return { config, handle };
}

const rig = () => {
  const root = mkdtempSync(join(tmpdir(), "serve-discovery-"));
  dirs.push(root);
  return {
    root,
    configDir: join(root, "config"),
    a: join(root, "proj-a"),
    b: join(root, "proj-b"),
  };
};

/**
 * A live sibling process: a real `sleep` child, plus the record a `serve` in it
 * would have written for its pid. A dead one is the same record with the child
 * gone (F1), which is the case a stop produces.
 */
function sibling(root: string, configDir: string, cwd: string, addresses: readonly string[]) {
  const child = Bun.spawn({ cmd: ["sleep", "60"], stdout: "ignore", stderr: "ignore" });
  writeDaemonRecord(configDir, {
    pid: child.pid,
    host: "127.0.0.1",
    port: 4555,
    tls: false,
    cwd,
    startedAt: Date.now(),
    addresses,
  });
  return {
    pid: child.pid,
    /** The sibling stopping: its record is removed and its pid dies (F1). */
    async stop() {
      removeDaemonRecord(configDir, child.pid);
      child.kill();
      await child.exited;
    },
  };
}

describe("serve writes --address into its record", () => {
  test("the record carries the addresses, on disk and through the reader", async () => {
    const { root, configDir, a } = rig();
    const address = "wss://mac.tailnet.ts.net/e2e";
    const { config } = await serve(root, configDir, a, { addresses: [address] });
    const records = readDaemonRecords(config.configDir);
    expect(records).toHaveLength(1);
    expect(records[0]?.addresses).toEqual([address]);
    const raw = JSON.parse(
      readFileSync(join(config.configDir, "daemons", `${process.pid}.json`), "utf8"),
    ) as DaemonRecord;
    expect(raw.addresses).toEqual([address]);
  });

  test("without --address the record has no `addresses` member at all (an older build's file)", async () => {
    const { root, configDir, a } = await rig();
    const { config } = await serve(root, configDir, a);
    const raw = JSON.parse(
      readFileSync(join(config.configDir, "daemons", `${process.pid}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect("addresses" in raw).toBe(false);
  });
});

describe("a real client on A learns A and B", () => {
  test("SELF announces this machine's address for a `0.0.0.0` bind (production default, F6)", async () => {
    // `serve` passes NO `interfaces`, so a `--host 0.0.0.0` daemon — the setup
    // REACHABLE_HINT recommends — must announce the machine's LAN address, not
    // `[]`: otherwise a DHCP or Wi-Fi change is never announced (decision 3).
    // Mutation: default the driver's `interfaces` to `[]` → this is empty.
    const v4 = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal)
      .map((entry) => entry?.address ?? "");
    if (v4.length === 0) {
      return; // a machine with no LAN address has nothing to expand
    }
    const { root, configDir, a } = rig();
    const config = await loadConfig({
      configDir,
      cwd: a,
      scaffold: false,
      env: { HOME: root, TENTACLE_MODEL_API_KEY: "k" },
    });
    const handle = await startDaemon(config, {
      host: "0.0.0.0",
      port: 0,
      pollMs: 20,
      heartbeatMs: 20,
    });
    handles.push(handle);
    const driver = handle.discovery;
    expect(driver).toBeDefined();
    if (!driver) return;
    driver.subscribe(() => {});
    const self = driver.current().daemons.find((d) => d.self === true);
    expect(self?.addresses.some((address) => v4.some((ip) => address.includes(ip)))).toBe(true);
  });

  test("discover() returns both, self first, and a stop is announced", async () => {
    const { root, configDir, a, b } = rig();
    const aAddr = "wss://a.tailnet.ts.net/e2e";
    const bAddr = "wss://b.tailnet.ts.net/e2e";
    const one = await serve(root, configDir, a, { addresses: [aAddr] });
    const two = sibling(root, configDir, b, [bAddr]);
    // The serve handle exposes the driver it started (its own process's).
    const driver = one.handle.discovery;
    expect(driver).toBeDefined();
    if (!driver) return;

    const seen: DaemonDiscovery[] = [];
    driver.subscribe((d) => seen.push(d));
    // A subscription polls at once, so the sibling is in from the start.
    expect(driver.current().daemons.map((d) => d.cwd)).toEqual([a, b]);
    expect(driver.current().daemons[0]).toMatchObject({ cwd: a, self: true, addresses: [aAddr] });
    expect(driver.current().daemons[1]).toMatchObject({ cwd: b, addresses: [bAddr] });

    await two.stop();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && driver.current().daemons.some((d) => d.cwd === b)) {
      await Bun.sleep(20);
    }
    // A dead pid is definitive: dropped on the next poll, and announced (F1/F6).
    expect(driver.current().daemons.map((d) => d.cwd)).toEqual([a]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)?.daemons.map((d) => d.cwd)).toEqual([a]);
  });

  test("OVER THE WIRE: a RemoteClient's discover() gets the snapshot and a change", async () => {
    const { root, configDir, a, b } = rig();
    const aAddr = "wss://a.tailnet.ts.net/e2e";
    const bAddr = "wss://b.tailnet.ts.net/e2e";
    const one = await serve(root, configDir, a, { addresses: [aAddr] });
    const two = sibling(root, configDir, b, [bAddr]);
    const client = new RemoteClient(
      await webSocketChannelFactory(one.handle.url)(),
      new PermissionBroker(),
      undefined,
      // A reconnecting client, so a later change still arrives (F7).
      { channelFactory: webSocketChannelFactory(one.handle.url), random: () => 0 },
    );
    clients.push(client);
    await client.initialize();
    const seen: DaemonDiscovery[] = [];
    const snapshot = await client.discover((d) => seen.push(d));
    expect(snapshot?.daemons.map((d) => d.cwd)).toEqual([a, b]);
    expect(snapshot?.daemons[1]?.addresses).toEqual([bAddr]);
    await two.stop();
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !seen.some((d) => d.daemons.every((x) => x.cwd === a))) {
      await Bun.sleep(20);
    }
    // A later notification says the sibling is gone (the subscribing snapshot
    // still carried it, which is why this waits for the CHANGED one).
    expect(seen.at(-1)?.daemons.map((d) => d.cwd)).toEqual([a]);
  });

  test("a serve with discovery OFF answers MethodNotFound → discover() is undefined (F9)", async () => {
    const { root, configDir, a } = rig();
    const { handle } = await serve(root, configDir, a, { discovery: false });
    const client = new RemoteClient(
      await webSocketChannelFactory(handle.url)(),
      new PermissionBroker(),
    );
    clients.push(client);
    await client.initialize();
    expect(await client.discover(() => {})).toBeUndefined();
  });
});

describe("a pod daemon never discovers (F9)", () => {
  test("a host without the seam answers MethodNotFound", async () => {
    // The seam's absence is the whole rule: `podSessionHost` never sets it.
    const host = new SessionHost({
      defaultCwd: "/tmp/pod",
      createAgent: () => {
        throw new Error("no session here");
      },
    });
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RemoteClient(c, new PermissionBroker());
    clients.push(client);
    await client.initialize();
    expect(await client.discover(() => {})).toBeUndefined();
  });
});
