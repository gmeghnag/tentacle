/**
 * `tentacle devices`, `devices revoke`, `devices reset`
 * (docs/feat/device-pairing.md 9d).
 *
 * One property per block, each naming its mutation:
 * - the table has name, id, paired, last seen (mutation: drop `readSeen` → a
 *   revoked-but-stale device looks as alive as a paired one);
 * - a peer-chosen name is SANITIZED before it reaches the terminal (mutation:
 *   raw print → `\x1b[2J` in a device name clears the user's screen);
 * - `revoke` resolves a name and an id prefix, and an AMBIGUOUS word is refused
 *   (mutation: first-match → the wrong phone is revoked);
 * - `revoke`'s write goes through the store's lock (so a live `pair` cannot
 *   interleave), and an unreadable registry is refused, never emptied;
 * - `reset` needs a `y` (or `--yes`) and, when it runs, gives a NEW key and an
 *   EMPTY list (mutation: replace the identity but keep the devices).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addDevice,
  deviceIdOf,
  loadOrCreateIdentity,
  readLiveRegistrations,
  readPushRegistrations,
  readRegistry,
  readSeen,
  replaceIdentity,
  touchSeen,
  writeLiveRegistration,
  writePushRegistration,
  writeRegistry,
} from "@tentacle/daemon";
import {
  type DevicesDeps,
  devicesCommand,
  formatSeen,
  renderDevices,
  resetCommand,
  resolveDevice,
  revokeCommand,
} from "../src/devices-cmd.ts";

const dirs: string[] = [];
const newDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "devices-cmd-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number): Uint8Array => new Uint8Array(32).fill(fill);

interface Run {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

const run = async (
  configDir: string,
  op: (deps: DevicesDeps) => number | Promise<number>,
  options: { readonly answer?: string; readonly yes?: boolean } = {},
): Promise<Run> => {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DevicesDeps = {
    configDir,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    now: () => 1_700_000_000_000,
    hostname: "gabriel-laptop",
    ...(options.answer !== undefined ? { ask: async () => options.answer ?? "" } : {}),
  };
  const code = await (op === resetCommand
    ? resetCommand({ ...deps, yes: options.yes === true })
    : op(deps));
  return { code, out, err };
};

/** A computer with `names.length` paired devices (keys 1…n). */
const pairDevices = (configDir: string, names: readonly string[]): void => {
  loadOrCreateIdentity(configDir, { name: "gabriel-laptop" });
  for (const [index, name] of names.entries()) {
    const added = addDevice(configDir, { publicKey: key(index + 1), name, now: 1 });
    if (!added.ok) throw new Error(added.reason);
  }
};

describe("the table", () => {
  test("has every column, aligned, and one row per device", () => {
    const lines = renderDevices(
      [
        { id: "a".repeat(16), name: "iPhone", publicKey: key(1), pairedAt: 0 },
        { id: "b".repeat(16), name: "iPad di Gabriel", publicKey: key(2), pairedAt: 0 },
      ],
      new Map([["a".repeat(16), Date.now()]]),
      Date.now(),
    );
    expect(lines[0]).toStartWith("NAME");
    expect(lines[0]).toContain("ID");
    expect(lines[0]).toContain("PAIRED");
    expect(lines[0]).toContain("LAST SEEN");
    expect(lines).toHaveLength(3);
    // The widest name sets the column, so the second row's id lines up with the header.
    expect(lines[1]?.indexOf("a".repeat(16))).toBe(lines[2]?.indexOf("b".repeat(16)) ?? -1);
  });

  test("a device no daemon has seen says so (not a fake timestamp)", () => {
    expect(formatSeen(Date.now(), undefined)).toBe("never");
    const now = 1_700_000_000_000;
    expect(formatSeen(now + 5_000, now)).toBe("now");
    expect(formatSeen(now + 2 * 60_000, now)).toBe("2m ago");
    expect(formatSeen(now + 3 * 3_600_000, now)).toBe("3h ago");
    expect(formatSeen(now + 5 * 86_400_000, now)).toBe("5d ago");
  });

  test("a control character in a device name cannot reach the terminal (mutation: raw print)", () => {
    const lines = renderDevices(
      [{ id: "c".repeat(16), name: "evil\x1b[2Jname", publicKey: key(1), pairedAt: 0 }],
      new Map(),
      0,
    );
    const row = lines[1] ?? "";
    expect(row).not.toContain("\x1b");
    expect(row).toContain("evil");
  });
});

describe("devices", () => {
  test("prints the table from the registry, with last seen", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const added = readRegistry(configDir);
    const id = added.ok ? (added.registry.devices[0]?.id ?? "") : "";
    touchSeen(configDir, id, 1_700_000_000_000);
    expect(readSeen(configDir).get(id)).toBeDefined();
    const result = await run(configDir, devicesCommand);
    expect(result.code).toBe(0);
    expect(result.out.join("")).toContain("iPhone");
    expect(result.out.join("")).toContain(id);
    expect(result.out.join("")).toContain("now");
  });

  test("an empty registry says how to pair, on stderr, and exits 0", async () => {
    const configDir = newDir();
    loadOrCreateIdentity(configDir, { name: "gabriel-laptop" });
    const result = await run(configDir, devicesCommand);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("")).toContain("tentacle pair");
  });

  test("an unreadable registry is named, never repaired (F14)", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "devices"), { recursive: true });
    writeFileSync(join(configDir, "devices", "registry.json"), "{ nope");
    const result = await run(configDir, devicesCommand);
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("registry.json");
    expect(readFileSync(join(configDir, "devices", "registry.json"), "utf8")).toBe("{ nope");
  });
});

/**
 * The push column (docs/feat/mobile-push.md Design 6, P5): `on` for a device
 * whose registration is usable, `off` otherwise. Read from `devices/push/`, so
 * it says what the DAEMON will do, not what the phone believes.
 *
 * Mutation: print `on` from the registry alone (drop the push read) → a phone
 * that never registered notifications looks like one that did, which is exactly
 * the support question this column answers.
 */
describe("the push column", () => {
  const pushKey = (fill: number): string => Buffer.from(key(fill)).toString("base64url");

  const register = (configDir: string, deviceId: string, token = "a".repeat(64)): void => {
    const written = writePushRegistration(configDir, {
      deviceId,
      token,
      env: "sandbox",
      key: pushKey(1),
      registeredAt: 5,
    });
    if (!written.ok) throw new Error(written.reason);
  };

  test("renders `off` for a device that never registered, and `on` for one that did", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone", "iPad"]);
    const [iphone, ipad] = ["iPhone", "iPad"].map((name) => {
      const registry = readRegistry(configDir);
      return registry.ok ? registry.registry.devices.find((d) => d.name === name)?.id : undefined;
    });
    if (iphone === undefined || ipad === undefined) throw new Error("fixture");
    register(configDir, iphone);
    const lines = renderDevices(
      (() => {
        const registry = readRegistry(configDir);
        return registry.ok ? registry.registry.devices : [];
      })(),
      new Map(),
      Date.now(),
      readPushRegistrations(configDir).registrations,
    );
    expect(lines[0]).toContain("PUSH");
    const rowOf = (name: string) => lines.find((line) => line.startsWith(name)) ?? "";
    // `PUSH` then `LIVE` (task 18 added the second), read as the last TWO cells
    // so the column padding is not what the assertion depends on.
    expect(columnsOf(rowOf("iPhone")).slice(-2)).toEqual(["on", "off"]);
    expect(columnsOf(rowOf("iPad")).slice(-2)).toEqual(["off", "off"]);
  });

  test("an unreadable registration reads `off`, never `on` (fail closed)", () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "devices", "push"), { recursive: true });
    writeFileSync(
      join(configDir, "devices", "push", `${"a".repeat(16)}.json`),
      JSON.stringify({ v: 9 }),
    );
    const lines = renderDevices(
      [{ id: "a".repeat(16), name: "iPhone", publicKey: key(1), pairedAt: 0 }],
      new Map(),
      0,
      readPushRegistrations(configDir).registrations,
    );
    expect(lines[1]).toEndWith("off");
  });

  test("`devices` prints the column for a real store", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const id = deviceIdOf(key(1));
    register(configDir, id);
    const result = await run(configDir, devicesCommand);
    expect(result.code).toBe(0);
    expect(result.out.join("")).toContain("PUSH");
    expect(result.out.join("")).toContain("LIVE");
    // `on` for the registered device's PUSH, then `off` for LIVE (no record).
    const row = result.out.join("").trimEnd().split("\n")[1] ?? "";
    expect(columnsOf(row).slice(-2)).toEqual(["on", "off"]);
  });
});

describe("reset and push registrations", () => {
  test("`devices reset` empties `push/` too, including a file whose device is GONE (F13)", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const id = deviceIdOf(key(1));
    const pushKey = (fill: number): string => Buffer.from(key(fill)).toString("base64url");
    for (const [deviceId, token] of [
      [id, "a".repeat(64)],
      // A registration left behind by a device revoked by hand (no registry
      // entry), so `removeDevices` cannot reach it: this is the file that only a
      // directory-wide clear takes. Mutation: drop `clearPushRegistrations` from
      // `reset` → this one survives the reset and a reset machine keeps a token.
      ["9".repeat(16), "b".repeat(64)],
    ] as const) {
      const written = writePushRegistration(configDir, {
        deviceId,
        token,
        env: "production",
        key: pushKey(2),
        registeredAt: 7,
      });
      if (!written.ok) throw new Error(written.reason);
    }
    expect(readPushRegistrations(configDir).registrations.size).toBe(2);
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(0);
    expect(readPushRegistrations(configDir).registrations.size).toBe(0);
  });
});

describe("resolveDevice", () => {
  const devices = [
    { id: "aaaaaaaaaaaaaaaa", name: "iPhone", publicKey: key(1), pairedAt: 0 },
    { id: "bbbbbbbbbbbbbbbb", name: "iPhone (2)", publicKey: key(2), pairedAt: 0 },
  ];

  test("an exact name wins over a prefix of another name", () => {
    const resolved = resolveDevice(devices, "iPhone");
    expect(resolved.ok ? resolved.device.id : "none").toBe("aaaaaaaaaaaaaaaa");
  });

  test("an id prefix resolves, case-insensitively", () => {
    const resolved = resolveDevice(devices, "BBBB");
    expect(resolved.ok ? resolved.device.name : "none").toBe("iPhone (2)");
  });

  test("a prefix matching two devices is AMBIGUOUS, never first-match (mutation: first-match)", () => {
    const resolved = resolveDevice(
      [
        { id: "aaaabbbbaaaaaaaa", name: "one", publicKey: key(1), pairedAt: 0 },
        { id: "aaaaccccaaaaaaaa", name: "two", publicKey: key(2), pairedAt: 0 },
      ],
      "aaaa",
    );
    expect(resolved.ok).toBe(false);
    expect(resolved.ok ? [] : resolved.matches).toHaveLength(2);
  });

  test("an unknown word matches nothing", () => {
    expect(resolveDevice(devices, "android").ok).toBe(false);
    expect(resolveDevice(devices, "zz").ok).toBe(false);
    // Not hex, so it cannot be an id prefix at all.
    expect(resolveDevice(devices, "not-hex!").ok).toBe(false);
  });
});

describe("revoke", () => {
  test("removes the entry by name, prints the name (STDOUT), and says what it closed", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone", "iPad"]);
    const result = await run(configDir, (deps) => revokeCommand("iPhone", deps));
    expect(result.code).toBe(0);
    expect(result.out.join("")).toBe("iPhone\n");
    expect(result.err.join("")).toContain("within a second");
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices.map((d) => d.name) : []).toEqual(["iPad"]);
  });

  test("removes the entry by id prefix", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const id = deviceIdOf(key(1));
    const result = await run(configDir, (deps) => revokeCommand(id.slice(0, 6), deps));
    expect(result.code).toBe(0);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toHaveLength(0);
  });

  test("an unknown name exits 1 and changes nothing", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const result = await run(configDir, (deps) => revokeCommand("android", deps));
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("no paired device matches");
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toHaveLength(1);
  });

  test("an unreadable registry is refused, untouched (mutation: fail open)", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "devices"), { recursive: true });
    writeFileSync(join(configDir, "devices", "registry.json"), "{ nope");
    const result = await run(configDir, (deps) => revokeCommand("iPhone", deps));
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("unreadable");
    expect(readFileSync(join(configDir, "devices", "registry.json"), "utf8")).toBe("{ nope");
  });

  test("a lock held by a live process is reported, not ignored (F13)", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    // A live holder: this very process. The store's lock must refuse, and the
    // CLI must say so rather than revoking behind its back.
    writeFileSync(join(configDir, "devices", "registry.lock"), String(process.pid), {
      flag: "wx",
    });
    const result = await run(configDir, (deps) => revokeCommand("iPhone", deps));
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain(String(process.pid));
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toHaveLength(1);
  });
});

describe("reset", () => {
  /**
   * The mobile relay's ids rotate with the identity (docs/feat/mobile-relay.md
   * Q5): ONE recovery verb for a leaked laptop, and the phones must re-pair
   * after a reset anyway — so a new relay address costs nothing extra.
   *
   * Mutation: skip `removeRelaySecrets` → every `relay.json` survives, and a
   * leaked relay address keeps routing phones at the machine it was leaked for.
   */
  test("deletes every project's relay.json, and says so", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const storeA = join(configDir, "daemon", "proj-a");
    const storeB = join(configDir, "daemon", "proj-b");
    mkdirSync(storeA, { recursive: true });
    mkdirSync(storeB, { recursive: true });
    writeFileSync(join(storeA, "relay.json"), `{ "v": 1, "secret": "a" }\n`);
    writeFileSync(join(storeB, "relay.json"), `{ "v": 1, "secret": "b" }\n`);
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(0);
    expect(existsSync(join(storeA, "relay.json"))).toBe(false);
    expect(existsSync(join(storeB, "relay.json"))).toBe(false);
    expect(result.err.join("")).toContain("relay address rotated for 2 projects");
    expect(result.err.join("")).toContain("Restart every");
  });

  test("a declined or unconfirmed reset rotates NOTHING", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const store = join(configDir, "daemon", "proj-a");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "relay.json"), `{ "v": 1, "secret": "a" }\n`);
    const result = await run(configDir, resetCommand, { answer: "n" });
    expect(result.code).toBe(1);
    expect(existsSync(join(store, "relay.json"))).toBe(true);
  });

  test("a machine whose daemons never ran needs no relay line", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(0);
    expect(result.err.join("")).not.toContain("relay address rotated");
  });

  test("a store with sessions but NO relay.json counts as nothing rotated", async () => {
    // A project store exists from the moment a daemon ran — but a daemon that
    // never had the relay on wrote no `relay.json`. Counting it would tell the
    // user an address changed when none did (mutation: no `existsSync` guard →
    // `rmSync` on a missing file is a silent success, so it is counted).
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const store = join(configDir, "daemon", "proj-a");
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, "some-session.jsonl"), "{}\n");
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(0);
    expect(result.err.join("")).not.toContain("relay address rotated");
    // And the store's own files are untouched: a reset rotates identities, it
    // does not delete sessions.
    expect(existsSync(join(store, "some-session.jsonl"))).toBe(true);
  });

  test("needs a y: 'n' changes nothing", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const before = loadOrCreateIdentity(configDir, { name: "x" });
    const result = await run(configDir, resetCommand, { answer: "n" });
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("Not reset");
    const after = loadOrCreateIdentity(configDir, { name: "x" });
    expect(after.ok && before.ok ? after.identity.publicKey : []).toEqual(
      before.ok ? before.identity.publicKey : [],
    );
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toHaveLength(1);
  });

  test("with no terminal and no --yes it refuses (never a silent destructive default)", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const result = await run(configDir, resetCommand);
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("--yes");
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toHaveLength(1);
  });

  test("y gives a NEW key and an EMPTY registry (mutation: keep the devices)", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone", "iPad"]);
    const before = loadOrCreateIdentity(configDir, { name: "x" });
    const result = await run(configDir, resetCommand, { answer: "y" });
    expect(result.code).toBe(0);
    expect(result.out.join("")).toContain("Reset");
    const after = loadOrCreateIdentity(configDir, { name: "x" });
    expect(after.ok && before.ok ? deviceIdOf(after.identity.publicKey) : "x").not.toBe(
      before.ok ? deviceIdOf(before.identity.publicKey) : "y",
    );
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toHaveLength(0);
  });

  test("--yes skips the question", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(0);
    const registry = readRegistry(configDir);
    expect(registry.ok ? registry.registry.devices : []).toEqual([]);
  });

  test("an unreadable registry is NOT wiped by a reset (F14)", async () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "devices"), { recursive: true });
    writeFileSync(join(configDir, "devices", "registry.json"), "{ nope");
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(1);
    expect(result.err.join("")).toContain("unreadable");
    expect(readFileSync(join(configDir, "devices", "registry.json"), "utf8")).toBe("{ nope");
  });

  test("the reset identity carries this computer's name", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    await run(configDir, resetCommand, { yes: true });
    const identity = loadOrCreateIdentity(configDir, { name: "ignored" });
    expect(identity.ok ? identity.identity.name : "?").toBe("gabriel-laptop");
  });
});

describe("the store's own guarantees still hold here", () => {
  test("writeRegistry is the only writer: a revoke and an add cannot interleave", () => {
    // Not a concurrency test (9a has those): this pins that 9d's commands go
    // through the locked API rather than writing the file themselves.
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const current = readRegistry(configDir);
    const kept = current.ok ? current.registry.devices : [];
    expect(writeRegistry(configDir, { devices: kept }).ok).toBe(true);
    // A hand-written entry whose id does not match its key is refused at write
    // time too, so no CLI path can produce one.
    expect(
      writeRegistry(configDir, {
        devices: [{ id: "0".repeat(16), name: "forged", publicKey: key(1), pairedAt: 0 }],
      }).ok,
    ).toBe(false);
    expect(replaceIdentity(configDir, { name: "n" }).ok).toBe(true);
  });
});

// --- the `LIVE` column and a reset that clears `devices/live/` (L5) ----------
/**
 * `tentacle devices` gains a `LIVE` column (docs/feat/mobile-live-activity.md
 * Design 4), and `devices reset` clears `devices/live/` beside `devices/push/`.
 *
 * The column answers the same question as `PUSH` does for notifications — "will
 * this phone light up?" — and fails closed for the same reason: an unreadable
 * record means no. The reset's directory-wide clear is what catches a record
 * left behind by a device revoked by hand (F11/F12).
 */
/** A rendered row's cells, with the padding collapsed (the table pads columns). */
function columnsOf(row: string): string[] {
  return row.trim().split(/\s{2,}/);
}

describe("the LIVE column and live registrations", () => {
  const liveKey = () => "a".repeat(64);

  test("a device with a usable live registration reads `on`, another `off`", () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone", "iPad"]);
    const iphone = readRegistry(configDir);
    if (!iphone.ok) throw new Error("registry");
    const id = iphone.registry.devices[0]?.id;
    if (id === undefined) throw new Error("fixture");
    const written = writeLiveRegistration(configDir, {
      deviceId: id,
      startToken: liveKey(),
      env: "sandbox",
      registeredAt: 1,
    });
    if (!written.ok) throw new Error(written.reason);
    const lines = renderDevices(
      iphone.registry.devices,
      new Map(),
      Date.now(),
      readPushRegistrations(configDir).registrations,
      readLiveRegistrations(configDir).registrations,
    );
    expect(lines[0]).toContain("LIVE");
    const rowOf = (name: string) => lines.find((line) => line.startsWith(name)) ?? "";
    // `iPhone` is last (the LIVE column), and `iPad` fails closed.
    expect(rowOf("iPhone")).toEndWith("on");
    expect(rowOf("iPad")).toEndWith("off");
  });

  test("the switch OFF reads `off` even with a usable record (the person's choice)", () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const registry = readRegistry(configDir);
    if (!registry.ok) throw new Error("registry");
    const id = registry.registry.devices[0]?.id;
    if (id === undefined) throw new Error("fixture");
    const written = writeLiveRegistration(configDir, {
      deviceId: id,
      startToken: liveKey(),
      env: "sandbox",
      registeredAt: 1,
      enabled: false,
    });
    if (!written.ok) throw new Error(written.reason);
    const lines = renderDevices(
      registry.registry.devices,
      new Map(),
      0,
      new Map(),
      readLiveRegistrations(configDir).registrations,
    );
    expect(lines[1]).toEndWith("off");
  });

  test("an unreadable live record reads `off`, never `on` (fail closed, F22)", () => {
    const configDir = newDir();
    mkdirSync(join(configDir, "devices", "live"), { recursive: true });
    writeFileSync(
      join(configDir, "devices", "live", `${"a".repeat(16)}.json`),
      JSON.stringify({ v: 99 }),
    );
    const lines = renderDevices(
      [{ id: "a".repeat(16), name: "iPhone", publicKey: key(1), pairedAt: 0 }],
      new Map(),
      0,
      new Map(),
      readLiveRegistrations(configDir).registrations,
    );
    expect(lines[1]).toEndWith("off");
  });

  test("`devices reset` empties `live/` too, including a file whose device is GONE", async () => {
    const configDir = newDir();
    pairDevices(configDir, ["iPhone"]);
    const id = deviceIdOf(key(1));
    for (const deviceId of [id, "9".repeat(16)] as const) {
      const written = writeLiveRegistration(configDir, {
        deviceId,
        startToken: liveKey(),
        env: "sandbox",
        registeredAt: 7,
      });
      if (!written.ok) throw new Error(written.reason);
    }
    expect(readLiveRegistrations(configDir).registrations.size).toBe(2);
    const result = await run(configDir, resetCommand, { yes: true });
    expect(result.code).toBe(0);
    // Mutation: drop `clearLiveRegistrations` from `reset` -> one survives, and a
    // reset machine keeps a start token for a key it no longer holds.
    expect(readLiveRegistrations(configDir).registrations.size).toBe(0);
  });
});
