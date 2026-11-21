/**
 * The 9d flow, end to end through `main`: `tentacle pair` → a phone claims the
 * window (real 9a crypto, the key taken as the daemon takes it) → `y` → the
 * device is in the registry → `tentacle devices revoke <id>` → it is gone and
 * its `seen/` record with it.
 *
 * **What this deliberately cannot cover, and why.** The plan's last 9d test is a
 * REAL `startDaemon` on loopback with `--address ws://127.0.0.1:<port>/e2e`,
 * `pairDevice` (9c) and a live connection dropped by `revoke` (9b). None of the
 * three exists on this branch — 9b's `/e2e` route + `DeviceAuthority` +
 * `daemons/<pid>.json` written by `serve`, and 9c's `device/pair` +
 * `packages/client/src/pairing.ts`, are unmerged siblings, and the plan itself
 * says 9d merges AFTER 9c for exactly this reason. So this file drives every
 * 9d-owned seam for real (argv → dispatch → store → terminal text) and fakes
 * only the two 9b/9c calls: the daemon record (written with 9a's
 * `writeDaemonRecord`, which is what 9b will call) and the phone's claim
 * (`claimPairing`, which is what 9c's handler calls, with the key the channel
 * authenticated). The missing assertion — a revoke closing a LIVE socket — is
 * 9b's `ws-device-route` test, and it is named in the task doc's Execution as
 * the one thing left to verify after 9c merges.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectKey } from "@tentacle/agent";
import {
  claimPairing,
  deviceIdOf,
  findPairing,
  readRegistry,
  readSeen,
  touchSeen,
  writeDaemonRecord,
} from "@tentacle/daemon";
import { main } from "../src/index.ts";

const NO_TERMINAL = { stdin: false, stdout: false };

const dirs: string[] = [];
const ENV_KEY = "TENTACLE_CONFIG_DIR";
const savedConfigDir = process.env[ENV_KEY];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pair-e2e-"));
  dirs.push(dir);
  process.env[ENV_KEY] = dir;
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (savedConfigDir === undefined)
    delete process.env[ENV_KEY]; // computed (§6)
  else process.env[ENV_KEY] = savedConfigDir;
});

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
}

/**
 * `tentacle pair`, with a "phone": every time `out` receives the payload, the
 * window it names is claimed — exactly the shape a real daemon has (a `pair`
 * in one process, the claim written by whoever completed the Noise handshake),
 * so the poll, the prompt and the writes below are the production ones.
 */
async function pairWithPhone(
  configDir: string,
  deviceName: string,
  deviceKey: Uint8Array,
  answer: string,
  extraArgs: readonly string[] = [],
): Promise<Run & { readonly deviceId: string }> {
  const out: string[] = [];
  const err: string[] = [];
  let deviceId = "";
  const code = await main(["bun", "cli", "pair", "--project", "/elsewhere", ...extraArgs], {
    out: (text) => {
      out.push(text);
      // The payload line is the phone's cue (see above).
      const pairingCode = /[?&]c=([A-Z0-9]{10})/.exec(text)?.[1];
      if (pairingCode === undefined || deviceId !== "") return;
      const session = findPairing(configDir, {
        project: projectKey("/elsewhere"),
        code: pairingCode,
      });
      if (session === undefined) return;
      const claimed = claimPairing(configDir, {
        project: projectKey("/elsewhere"),
        sid: session.sid,
        deviceKey,
        name: deviceName,
      });
      if (claimed.ok) deviceId = deviceIdOf(deviceKey);
    },
    err: (text) => err.push(text),
    terminal: NO_TERMINAL,
    // The human at the terminal (a seam: no TTY in the suite).
    ask: async () => answer,
  });
  return { code, out, err, deviceId };
}

const recordServing = (configDir: string, port = 4000): void => {
  // 9b writes this at `serve`'s listen (`cli/src/serve.ts`); 9a owns the format.
  const written = writeDaemonRecord(configDir, {
    pid: process.pid,
    host: "0.0.0.0",
    port,
    tls: false,
    cwd: "/elsewhere",
    startedAt: 1,
  });
  if (!written.ok) throw new Error(written.reason);
};

const deviceKey = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

describe("pair → devices → revoke, through main", () => {
  test("a real --address is published, the claim is accepted, and the device lists", async () => {
    const configDir = newDir();
    recordServing(configDir, 4000);
    const paired = await pairWithPhone(configDir, "iPhone di Gabriel", deviceKey(11), "y", [
      "--address",
      "ws://192.168.1.8:4000/e2e",
    ]);
    expect(paired.code).toBe(0);
    // The payload carried the `--address`. The daemon's own `0.0.0.0` record
    // ALSO contributes this machine's interfaces (the default when none are
    // injected — the CLI's real path, `pair-dispatch.test.ts` pins it), but a
    // test cannot know them, so assert only what it does know: the given one.
    expect(paired.out[0]).toContain(encodeURIComponent("ws://192.168.1.8:4000/e2e"));

    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices.map((d) => d.name) : []).toEqual([
      "iPhone di Gabriel",
    ]);
    expect(paired.deviceId).toBe(deviceIdOf(deviceKey(11)));

    // `tentacle devices` shows it.
    const listed: Run = { code: 0, out: [], err: [] };
    const code = await main(["bun", "cli", "devices"], {
      out: (text) => listed.out.push(text),
      err: (text) => listed.err.push(text),
      terminal: NO_TERMINAL,
    });
    expect(code).toBe(0);
    expect(listed.out.join("")).toContain("iPhone di Gabriel");
    expect(listed.out.join("")).toContain(paired.deviceId);
  });

  test("then a revoke by the id `pair` printed removes it, and its last-seen with it", async () => {
    const configDir = newDir();
    recordServing(configDir, 5000);
    const paired = await pairWithPhone(configDir, "iPhone", deviceKey(12), "y", [
      "--address",
      "ws://192.168.1.8:5000/e2e",
    ]);
    expect(paired.code).toBe(0);
    // A daemon has seen it (9b touches `seen/<id>` on the resolve).
    touchSeen(configDir, paired.deviceId, Date.now());
    expect(readSeen(configDir).get(paired.deviceId)).toBeDefined();

    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["bun", "cli", "devices", "revoke", paired.deviceId.slice(0, 6)], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      terminal: NO_TERMINAL,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("· iPhone ·");
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
    // The stale "last seen" must not outlive the entry (it would list a device
    // nobody can revoke).
    expect(readSeen(configDir).get(paired.deviceId)).toBeUndefined();
  });

  test("a declined claim leaves no device and closes the window's files", async () => {
    const configDir = newDir();
    recordServing(configDir, 6000);
    const paired = await pairWithPhone(configDir, "stranger", deviceKey(13), "n", [
      "--address",
      "ws://192.168.1.8:6000/e2e",
    ]);
    expect(paired.code).toBe(1);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
    let left: string[] = [];
    try {
      left = readdirSync(join(configDir, "devices", "pairing"));
    } catch {
      left = [];
    }
    expect(left).toEqual([]);
  });
});
