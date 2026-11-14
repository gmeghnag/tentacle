/**
 * The harness's pairing actions (docs/feat/mobile-pairing-screen.md 11b.1,
 * Design 5): `e2e/pairing.ts` against a REAL daemon and a real `tentacle pair`,
 * which is what makes the Maestro flows' `_pair` trustworthy — a flow's paste is
 * the payload the computer actually printed, and the compare code it asserts is
 * the one the terminal actually shows.
 *
 * Properties pinned here and nowhere else:
 * - `start` resolves with a PAYLOAD and the computer's id — the id the row uses;
 * - `confirm` returns the terminal's code only once the phone CLAIMED the code,
 *   and the phone's own `pairDevice` computes the same one (both ends agree);
 * - `answer("y")` registers the device; `answer("n")` does not;
 * - one window at a time (F-H3), and `stop` never leaves one open.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeviceAuthority,
  SessionHost,
  addDevice,
  deviceIdOf,
  loadOrCreateIdentity,
  readRegistry,
  startWsServer,
} from "@tentacle/daemon";
import type { DuplexChannel } from "@tentacle/transport";
import { generateStaticKeypair, systemRandom } from "@tentacle/transport/noise";
import { createPairingHooks, sasOfPrompt } from "../e2e/pairing.ts";

const dirs: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) {
    close();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A real daemon on a fresh config dir, with the `/e2e` route `serve` mounts. */
function daemon(): { readonly configDir: string; readonly address: string } {
  const configDir = mkdtempSync(join(tmpdir(), "harness-pairing-"));
  dirs.push(configDir);
  const identity = loadOrCreateIdentity(configDir, {
    name: "harness-mac",
    now: 1_000,
    random: () => new Uint8Array(32).fill(5),
  });
  if (!identity.ok) {
    throw new Error(identity.reason);
  }
  const authority = new DeviceAuthority({ configDir, pollIntervalMs: 10 });
  const server = startWsServer({
    host: "127.0.0.1",
    port: 0,
    sessionHost: new SessionHost({
      defaultCwd: tmpdir(),
      createAgent: () => {
        throw new Error("unused");
      },
    }),
    devices: { authority, pairingCheckMs: 20 },
  });
  closers.push(() => {
    server.stop();
    authority.stop();
  });
  return { configDir, address: `${server.url}/e2e` };
}

/** The phone's half of the exchange, driven exactly as the app drives it. */
async function claim(
  payloadText: string,
  options: { readonly outcome: "y" | "n" },
): Promise<{ readonly sas: string; readonly deviceId: string | undefined }> {
  const { pairDevice } = await import("@tentacle/client/pairing");
  const { parsePairingPayload } = await import("@tentacle/protocol");
  const parsed = parsePairingPayload(payloadText);
  if (!parsed.ok) {
    throw new Error(`the harness printed an unparseable payload: ${parsed.reason}`);
  }
  const key = generateStaticKeypair(systemRandom);
  let sas = "";
  const dial = (address: string) => async (): Promise<DuplexChannel> => {
    const { webSocketChannelFactory } = await import("@tentacle/client");
    return webSocketChannelFactory(address, {}, {})();
  };
  const result = await pairDevice({
    payload: parsed.payload,
    deviceKey: key.privateKey,
    name: "iPhone",
    dial,
    random: systemRandom,
    onCompare: (code) => {
      sas = code;
    },
  }).catch(() => undefined);
  void options;
  return { sas, deviceId: result?.deviceId };
}

describe("sasOfPrompt", () => {
  test("reads the six digits out of `pair`'s own prompt", () => {
    expect(sasOfPrompt("Add 'iPhone'? It must show 123 456. [y/N] ")).toBe("123456");
    expect(sasOfPrompt("nothing here")).toBeUndefined();
  });
});

describe("the pairing hooks", () => {
  test("start → confirm → answer(y): the phone pairs, and both ends showed ONE code", async () => {
    const { configDir, address } = daemon();
    const pairing = createPairingHooks({ configDir, address });
    try {
      const started = await pairing.start();
      expect(started.payload.startsWith("tentacle://pair?")).toBe(true);
      // The id names the computer the phone will pin (P3): the daemon's identity.
      const identity = loadOrCreateIdentity(configDir, { name: "", now: 0 });
      expect(identity.ok).toBe(true);
      if (identity.ok) {
        expect(started.computerId).toBe(deviceIdOf(identity.identity.publicKey));
      }
      // The phone claims the code in the background; `confirm` waits for it.
      const claiming = claim(started.payload, { outcome: "y" });
      const { sas } = await pairing.confirm();
      expect(sas).toHaveLength(6);
      // `y` registers the device (the registry is the daemon's truth). It goes
      // BEFORE awaiting the claim: `pairDevice` is still waiting for exactly this
      // answer (P1 — the phone's `device/pair` waits on the human's terminal).
      await pairing.answer("y");
      const phone = await claiming;
      // The phone's own compare code is the terminal's — the security property.
      expect(phone.sas).toBe(sas);
      await sleep(50);
      const registry = readRegistry(configDir);
      expect(registry.ok ? registry.registry.devices.length : 0).toBe(1);
    } finally {
      await pairing.stop();
    }
  }, 30_000);

  test("answer(n) registers NOTHING", async () => {
    const { configDir, address } = daemon();
    const pairing = createPairingHooks({ configDir, address });
    try {
      const started = await pairing.start();
      const claiming = claim(started.payload, { outcome: "n" });
      await pairing.confirm();
      await pairing.answer("n");
      await claiming;
      await sleep(50);
      const registry = readRegistry(configDir);
      expect(registry.ok ? registry.registry.devices : []).toEqual([]);
    } finally {
      await pairing.stop();
    }
  }, 30_000);

  test("one window at a time (F-H3), and `stop` closes it", async () => {
    const { configDir, address } = daemon();
    const pairing = createPairingHooks({ configDir, address });
    const started = await pairing.start();
    expect(started.payload).not.toBe("");
    await expect(pairing.start()).rejects.toThrow("already open");
    // `stop` answers a waiting `ask` with n, so the window closes.
    await pairing.stop();
    // And a NEW window may then open (a hook never leaves the harness unusable).
    const again = await pairing.start();
    expect(again.payload).not.toBe("");
    expect(again.payload).not.toBe(started.payload);
    await pairing.stop();
  }, 30_000);

  test("confirm without a window is an error, not a hang", async () => {
    const { configDir, address } = daemon();
    const pairing = createPairingHooks({ configDir, address });
    await expect(pairing.confirm()).rejects.toThrow("no pairing window is open");
  }, 10_000);

  test("claimed() is false until the phone dials, then true", async () => {
    const { configDir, address } = daemon();
    const pairing = createPairingHooks({ configDir, address });
    try {
      const started = await pairing.start();
      expect(pairing.claimed()).toBe(false);
      const claiming = claim(started.payload, { outcome: "y" });
      await pairing.confirm();
      expect(pairing.claimed()).toBe(true);
      await pairing.answer("y");
      await claiming;
    } finally {
      await pairing.stop();
    }
  }, 30_000);

  test("revoke and reset go through the real CLI", async () => {
    const { configDir, address } = daemon();
    const pairing = createPairingHooks({ configDir, address });
    try {
      // Register a device directly (the pairing path is covered above).
      const added = addDevice(configDir, {
        publicKey: new Uint8Array(32).fill(7),
        name: "iPhone",
        now: 2_000,
      });
      expect(added.ok).toBe(true);
      expect(await pairing.revoke("iPhone")).toBe(0);
      const registry = readRegistry(configDir);
      expect(registry.ok ? registry.registry.devices : []).toEqual([]);
      expect(await pairing.reset()).toBe(0);
    } finally {
      await pairing.stop();
    }
  }, 30_000);
});
