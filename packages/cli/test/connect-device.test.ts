/**
 * `connect <name>`: the device dial, pairing, the address refresh and routing
 * (docs/feat/connect-via-relay.md). The e2e tests run a real `startDaemon` on
 * loopback (and a real in-process relay); no Keychain is ever touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelError,
  type DialTimer,
  type RemoteClient,
  webSocketCarrierFactory,
} from "@tentacle/client";
import { loadConfig } from "@tentacle/config";
import { addDevice, readIdentity } from "@tentacle/daemon";
import { type DaemonDiscovery, encodeBase64Url } from "@tentacle/protocol";
import type { ByteCarrier } from "@tentacle/transport";
import { generateStaticKeypair, systemRandom } from "@tentacle/transport/noise";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { deviceConnectError, deviceDial, pairLaptop } from "../src/connect-device.ts";
import { defaultKeyStores, loadKey } from "../src/connect-keys.ts";
import { type ComputerRecord, readRecord } from "../src/connect-store.ts";
import { connectTui } from "../src/connect.ts";
import { main } from "../src/main.ts";
import { startDaemon } from "../src/serve.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "connect-device-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const KEYS = generateStaticKeypair(systemRandom);

function record(over: Partial<ComputerRecord> = {}): ComputerRecord {
  return {
    v: 1,
    name: "app",
    id: "ab".repeat(16),
    computer: "workstation",
    computerKey: encodeBase64Url(new Uint8Array(32).fill(7)),
    deviceId: "0123456789abcdef",
    project: { cwd: "/srv/app", label: "app" },
    addresses: ["ws://127.0.0.1:1/e2e"],
    keyStore: "file",
    ...over,
  };
}

/** A real serve (loopback) with the laptop's key registered as a device. */
async function serve(relayUrl?: string) {
  const dir = tempDir();
  const config = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
  const added = addDevice(config.configDir, {
    publicKey: KEYS.publicKey,
    name: "laptop",
    now: 2_000,
  });
  if (!added.ok) throw new Error("device not added");
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    ...(relayUrl === undefined ? {} : { relay: { flagUrl: relayUrl } }),
  });
  cleanups.push(() => handle.stop());
  const identity = readIdentity(config.configDir);
  if (!identity.ok) throw new Error(identity.reason);
  return { dir, handle, computerKey: encodeBase64Url(identity.identity.publicKey) };
}

/** Run `connectTui` over the device dial; the fake TUI lists sessions and discovers. */
async function drive(target: ComputerRecord, key: Uint8Array) {
  const lines: string[] = [];
  const seen: { listed?: number; discovery?: DaemonDiscovery | undefined } = {};
  let client: RemoteClient | undefined;
  await connectTui({ url: target.name, configDir: tempDir() }, (line) => lines.push(line), {
    dial: () => deviceDial(target, key),
    onClient: (c) => {
      client = c;
    },
    startTui: async (_session, options) => {
      const view = await options?.sessions?.list();
      seen.listed = view?.sessions.length;
      seen.discovery = await client?.discover(() => {});
    },
  });
  return { lines, seen };
}

describe("deviceDial against a real serve (the load-bearing property)", () => {
  test("connectTui runs over /e2e as a DEVICE: it sees only its own daemon", async () => {
    const { handle, computerKey } = await serve();
    const target = record({ computerKey, addresses: [`${handle.url}/e2e`] });
    const { seen } = await drive(target, KEYS.privateKey);
    expect(seen.listed).toBe(0);
    expect(seen.discovery?.daemons).toHaveLength(1);
    expect(seen.discovery?.daemons[0]?.self).toBe(true);
  }, 20_000);

  test("a key that is not registered is refused as unauthorized", async () => {
    const { handle, computerKey } = await serve();
    const target = record({ computerKey, addresses: [`${handle.url}/e2e`] });
    const wrong = generateStaticKeypair(systemRandom).privateKey;
    const error = await drive(target, wrong).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).kind).toBe("unauthorized");
  }, 20_000);

  test("a wrong pinned computer key fails the handshake (F8)", async () => {
    const { handle } = await serve();
    const pinned = encodeBase64Url(generateStaticKeypair(systemRandom).publicKey);
    const target = record({ computerKey: pinned, addresses: [`${handle.url}/e2e`] });
    const error = await drive(target, KEYS.privateKey).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).kind).not.toBe("unauthorized");
    expect(deviceConnectError(error, target).message).toContain("computer key changed?");
  }, 20_000);

  test("the relay's /d/<id>/e2e is just one more address", async () => {
    const relay = startRelay({ host: "127.0.0.1", port: 0, sweepMs: 10, onLog: () => {} });
    cleanups.push(() => relay.stop());
    const { handle, computerKey } = await serve(relay.url);
    const address = handle.relay?.address;
    expect(address).toContain("/d/");
    const target = record({
      computerKey,
      addresses: ["ws://127.0.0.1:1/e2e", address ?? ""],
    });
    const { seen } = await drive(target, KEYS.privateKey);
    expect(seen.listed).toBe(0);
    expect(seen.discovery?.daemons[0]?.self).toBe(true);
  }, 20_000);
});

describe("pairing against a real serve", () => {
  test("tentacle pair + `y` on the host, pairLaptop here, then connect by that record", async () => {
    const { dir, handle } = await serve();
    const configDir = join(dir, "config");
    const laptop = tempDir();
    const keys = defaultKeyStores(laptop, "linux");
    const envKey = "TENTACLE_CONFIG_DIR";
    const saved = process.env[envKey];
    process.env[envKey] = configDir;
    cleanups.push(() => {
      if (saved === undefined) delete process.env[envKey];
      else process.env[envKey] = saved;
    });
    const written: string[] = [];
    let pairing: Promise<ComputerRecord> | undefined;
    const code = await main(
      ["bun", "tentacle", "pair", "--project", dir, "--address", `${handle.url}/e2e`],
      {
        out: (text) => {
          const line = /tentacle:\/\/pair\?\S+/.exec(text)?.[0];
          if (line === undefined || pairing !== undefined) return;
          pairing = pairLaptop(line, {
            configDir: laptop,
            keys,
            write: (l) => written.push(l),
          });
        },
        err: () => {},
        terminal: { stdin: false, stdout: false },
        ask: async () => "y",
      },
    );
    expect(code).toBe(0);
    if (pairing === undefined) throw new Error("no pairing line printed");
    const paired = await pairing;
    expect(written.join("")).toContain("compare code");
    expect(readRecord(laptop, paired.name)).toEqual({ ok: true, record: paired });
    const { seen } = await drive(paired, await loadKey(keys, paired));
    expect(seen.discovery?.daemons[0]?.self).toBe(true);
    // `foldDiscovery` accepts what a real daemon announces for this record.
    expect(seen.discovery?.daemons[0]?.cwd).toBe(paired.project?.cwd);
  }, 30_000);
});

/** A carrier that records its first send, then closes: a handshake that fails. */
function deadCarrier(onSend: () => void): ByteCarrier {
  let onClose: (() => void) | undefined;
  return {
    send: () => {
      onSend();
      queueMicrotask(() => onClose?.());
    },
    close: () => {},
    setOnMessage: () => {},
    setOnClose: (handler) => {
      onClose = handler as () => void;
    },
  } as ByteCarrier;
}

function manualTimer() {
  const pending: (() => void)[] = [];
  const timer: DialTimer = {
    schedule: (fn) => {
      pending.push(fn);
      return {
        cancel: () => {
          const at = pending.indexOf(fn);
          if (at >= 0) pending.splice(at, 1);
        },
      };
    },
  };
  return { timer, pending };
}

describe("dial order (P7)", () => {
  const DIRECT = "ws://192.0.2.1:4000/e2e";
  const OTHER = "ws://192.0.2.2:4000/e2e";
  const RELAY = "wss://relay.example/d/abc/e2e";

  /** A carrier factory: `behaviour(address)` says how its open ends. */
  function carriers(behaviour: (address: string) => "open" | "dead" | "hang") {
    const opened: string[] = [];
    const handshaken: string[] = [];
    const carrier = (address: string) => (): Promise<ByteCarrier> => {
      opened.push(address);
      const how = behaviour(address);
      if (how === "hang") return new Promise(() => {});
      if (how === "dead") return Promise.reject(new ChannelError("unreachable", "no route"));
      return Promise.resolve(deadCarrier(() => handshaken.push(address)));
    };
    return { carrier, opened, handshaken };
  }

  test("a live direct address wins before the relay is opened", async () => {
    const fake = carriers(() => "open");
    const { timer } = manualTimer();
    const dial = deviceDial(record({ addresses: [DIRECT, RELAY] }), KEYS.privateKey, {
      carrier: fake.carrier,
      race: { timer },
    });
    // The fake handshake fails, so the race falls through afterwards.
    await dial().catch(() => {});
    expect(fake.opened[0]).toBe(DIRECT);
    expect(fake.handshaken[0]).toBe(DIRECT);
  });

  test("a dead direct address falls back to the relay", async () => {
    const fake = carriers((a) => (a === DIRECT ? "dead" : "open"));
    const { timer } = manualTimer();
    const dial = deviceDial(record({ addresses: [DIRECT, RELAY] }), KEYS.privateKey, {
      carrier: fake.carrier,
      race: { timer },
    });
    await dial().catch(() => {});
    expect(fake.opened).toEqual([DIRECT, RELAY]);
    expect(fake.handshaken).toEqual([RELAY]);
  });

  test("a hanging direct address holds the relay back only for the stagger", async () => {
    const fake = carriers((a) => (a === DIRECT ? "hang" : "open"));
    const { timer, pending } = manualTimer();
    const dial = deviceDial(record({ addresses: [DIRECT, RELAY] }), KEYS.privateKey, {
      carrier: fake.carrier,
      race: { timer, openDeadlineMs: undefined },
    });
    const result = dial().catch(() => {});
    expect(fake.opened).toEqual([DIRECT]);
    pending.shift()?.();
    await result;
    expect(fake.opened).toEqual([DIRECT, RELAY]);
  });

  test("a remembered DIRECT address starts the race", async () => {
    const fake = carriers(() => "open");
    const { timer } = manualTimer();
    const target = record({ addresses: [DIRECT, OTHER, RELAY], lastAddress: OTHER });
    await deviceDial(target, KEYS.privateKey, { carrier: fake.carrier, race: { timer } })().catch(
      () => {},
    );
    expect(fake.opened[0]).toBe(OTHER);
  });

  test("a remembered RELAY address never goes before the direct ones", async () => {
    const fake = carriers(() => "open");
    const { timer } = manualTimer();
    const target = record({ addresses: [DIRECT, RELAY], lastAddress: RELAY });
    await deviceDial(target, KEYS.privateKey, { carrier: fake.carrier, race: { timer } })().catch(
      () => {},
    );
    expect(fake.opened[0]).toBe(DIRECT);
  });

  test("a refused key stops the race: no second address is tried", async () => {
    const { handle, computerKey } = await serve();
    const opened: string[] = [];
    const { timer } = manualTimer();
    const target = record({ computerKey, addresses: [`${handle.url}/e2e`, RELAY] });
    const dial = deviceDial(target, generateStaticKeypair(systemRandom).privateKey, {
      carrier: (address) => {
        opened.push(address);
        return address === RELAY
          ? () => Promise.reject(new ChannelError("unreachable", "no route"))
          : webSocketCarrierFactory(address);
      },
      race: { timer },
    });
    const error = await dial().catch((e: unknown) => e);
    expect((error as ChannelError).kind).toBe("unauthorized");
    expect(opened).toEqual([`${handle.url}/e2e`]);
  }, 20_000);

  test("the winning address is reported", async () => {
    const { handle, computerKey } = await serve();
    const won: string[] = [];
    const target = record({ computerKey, addresses: [`${handle.url}/e2e`] });
    const channel = await deviceDial(target, KEYS.privateKey, {
      onAnswered: (address) => won.push(address),
    })();
    channel.close();
    expect(won).toEqual([`${handle.url}/e2e`]);
  }, 20_000);
});
