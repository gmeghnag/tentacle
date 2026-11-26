/**
 * `connect`'s pure half and pairing (docs/feat/connect-via-relay.md): routing,
 * the address refresh, the pairing order and the pre-mount hints.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChannelError, type RemoteClient } from "@tentacle/client";
import { type PairDeviceOptions, PairingRefused } from "@tentacle/client/pairing";
import {
  type DaemonDiscovery,
  type PairingPayload,
  encodeBase64Url,
  formatPairingPayload,
} from "@tentacle/protocol";
import {
  type PairLaptopDeps,
  deviceConnectError,
  deviceName,
  foldDiscovery,
  pairLaptop,
  recordKeeper,
  routeConnect,
} from "../src/connect-device.ts";
import { defaultKeyStores } from "../src/connect-keys.ts";
import {
  type ComputerRecord,
  createRecord,
  listRecordNames,
  readRecord,
  recordPath,
  removeRecord,
} from "../src/connect-store.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "connect-pair-"));
  dirs.push(dir);
  return dir;
}

const A = "ws://192.0.2.1:4000/e2e";
const B = "ws://192.0.2.2:4000/e2e";
const RELAY = "wss://relay.example/d/abc/e2e";
const DEVICE_ID = "0123456789abcdef";

const PAYLOAD: PairingPayload = {
  v: 2,
  key: new Uint8Array(32).fill(7),
  computer: "Work Station",
  code: "ABCDEFGHJK",
  addresses: [A, RELAY],
  project: "My App",
};
const LINE = formatPairingPayload(PAYLOAD);

function setup(
  over: Partial<PairLaptopDeps> = {},
  pair?: (options: PairDeviceOptions, keyFiles: () => string[]) => Promise<void>,
) {
  const configDir = tempDir();
  const keys = defaultKeyStores(configDir, "linux");
  const written: string[] = [];
  const keyFiles = (): string[] => {
    const dir = join(configDir, "connect", "keys");
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  const seen: PairDeviceOptions[] = [];
  const deps: PairLaptopDeps = {
    configDir,
    keys,
    write: (line) => written.push(line),
    hostname: () => "my-laptop",
    pair: async (options) => {
      seen.push(options);
      await pair?.(options, keyFiles);
      return {
        deviceId: DEVICE_ID,
        computer: { id: "fedcba9876543210", name: "Work Station" },
        project: { key: "app-abc", cwd: "/srv/app", label: "My App" },
      };
    },
    ...over,
  };
  return { configDir, keys, written, keyFiles, seen, deps };
}

describe("pairLaptop", () => {
  test("stores the key BEFORE pairing, then the record, and prints the name", async () => {
    let atPair: string[] = [];
    const s = setup({}, async (_options, keyFiles) => {
      atPair = keyFiles();
      expect(listRecordNames(configDirOf())).toEqual([]);
    });
    function configDirOf(): string {
      return s.configDir;
    }
    const record = await pairLaptop(LINE, s.deps);
    expect(atPair).toEqual([`${record.id}.key`]);
    expect(record).toMatchObject({
      name: "my-app",
      computer: "Work Station",
      computerKey: encodeBase64Url(PAYLOAD.key),
      deviceId: DEVICE_ID,
      project: { cwd: "/srv/app", label: "My App" },
      addresses: [A, RELAY],
      keyStore: "file",
    });
    expect(readRecord(s.configDir, "my-app")).toEqual({ ok: true, record });
    expect(s.written.join("")).toContain(
      "paired as 'my-app' — connect with: tentacle connect my-app",
    );
    // The key sent to the host is the key stored.
    const stored = await s.keys.file.get(record.id);
    expect(stored).toEqual(s.seen[0]?.deviceKey);
    expect(s.seen[0]).toMatchObject({ name: "my-laptop", perProject: true });
    expect(readFileSync(recordPath(s.configDir, "my-app"), "utf8")).not.toContain(
      encodeBase64Url(stored ?? new Uint8Array()),
    );
  });

  test("the compare code is printed before the claim resolves", async () => {
    let atClaim = "";
    const s = setup({}, async (options) => {
      await options.onCompare?.("123456", { protocolVersion: 1 });
      atClaim = s.written.join("");
    });
    await pairLaptop(LINE, s.deps);
    expect(atClaim).toContain("123");
    expect(atClaim).toContain("456");
    expect(atClaim).not.toContain("paired as");
  });

  test("each pairing makes a fresh key and a fresh id (D3)", async () => {
    const s = setup();
    const first = await pairLaptop(LINE, s.deps);
    const second = await pairLaptop(LINE, s.deps);
    expect(second.name).toBe("my-app-2");
    expect(second.id).not.toBe(first.id);
    expect(s.seen[1]?.deviceKey).not.toEqual(s.seen[0]?.deviceKey);
  });

  test("no project label: the record is named after the computer (D5)", async () => {
    const s = setup({
      pair: async () => ({
        deviceId: DEVICE_ID,
        computer: { id: "fedcba9876543210", name: "Work Station" },
      }),
    });
    expect((await pairLaptop(LINE, s.deps)).name).toBe("work-station");
  });

  test("a refused pairing removes the key and writes no record (F3)", async () => {
    const s = setup({}, async () => {
      throw new PairingRefused("declined", "the pairing was declined on the computer");
    });
    await expect(pairLaptop(LINE, s.deps)).rejects.toThrow(
      "the pairing was declined on the computer",
    );
    expect(s.keyFiles()).toEqual([]);
    expect(listRecordNames(s.configDir)).toEqual([]);
  });

  test("an unreachable host removes the key and says so", async () => {
    const s = setup({}, async () => {
      throw new ChannelError("unreachable", "no route");
    });
    await expect(pairLaptop(LINE, s.deps)).rejects.toThrow(/no route.*is `serve` running/);
    expect(s.keyFiles()).toEqual([]);
  });

  test("a record that cannot be written names the device to revoke, key removed (F4)", async () => {
    const s = setup({}, async () => {
      // A FILE where the records dir must go: the create fails after the pair.
      await Bun.write(join(s.configDir, "connect", "computers"), "in the way");
    });
    await expect(pairLaptop(LINE, s.deps)).rejects.toThrow(
      `paired on the host but not saved here — revoke it there: tentacle devices revoke ${DEVICE_ID}`,
    );
    expect(s.keyFiles()).toEqual([]);
  });

  test("a damaged pairing line stores nothing", async () => {
    const s = setup();
    await expect(pairLaptop("https://example.com", s.deps)).rejects.toThrow(/pairing line/);
    await expect(pairLaptop(LINE.replace("v=2", "v=9"), s.deps)).rejects.toThrow(/version/);
    expect(s.keyFiles()).toEqual([]);
    expect(s.seen).toEqual([]);
  });

  test("the device name is the hostname, bounded, else `laptop` (D4)", () => {
    expect(deviceName(() => "mac.local")).toBe("mac.local");
    expect(deviceName(() => "h".repeat(200))).toBe("h".repeat(64));
    expect(deviceName(() => "")).toBe("laptop");
    expect(deviceName(() => "bad\u001b[31m")).toBe("laptop");
  });
});

function record(over: Partial<ComputerRecord> = {}): ComputerRecord {
  return {
    v: 1,
    name: "app",
    id: "ab".repeat(16),
    computer: "workstation",
    computerKey: encodeBase64Url(new Uint8Array(32).fill(7)),
    deviceId: DEVICE_ID,
    project: { cwd: "/srv/app", label: "app" },
    addresses: [A],
    keyStore: "file",
    ...over,
  };
}

function announce(cwd: string, addresses: string[], self = true): DaemonDiscovery {
  return {
    rev: 1,
    daemons: [{ cwd, addresses, startedAt: 1, ...(self ? { self: true as const } : {}) }],
  };
}

describe("foldDiscovery (D9)", () => {
  test("announced addresses go first, known ones stay as fallbacks", () => {
    const next = foldDiscovery(record(), announce("/srv/app", [B, RELAY]), 1_000);
    expect(next?.addresses).toEqual([B, RELAY, A]);
    expect(next?.id).toBe(record().id);
  });

  test("only `self` counts", () => {
    expect(foldDiscovery(record(), announce("/srv/app", [B], false), 1_000)).toBeUndefined();
    expect(foldDiscovery(record(), undefined, 1_000)).toBeUndefined();
  });

  test("another project's daemon changes nothing", () => {
    expect(foldDiscovery(record(), announce("/srv/other", [B]), 1_000)).toBeUndefined();
  });

  test("nothing changed (or an empty announcement) means no write", () => {
    expect(foldDiscovery(record(), announce("/srv/app", [A]), 1_000)).toBeUndefined();
    expect(foldDiscovery(record(), announce("/srv/app", []), 1_000)).toBeUndefined();
  });

  test("a record with no project adopts the announced one", () => {
    const { project: _project, ...bare } = record();
    expect(foldDiscovery(bare, announce("/srv/app", [A]), 1_000)?.project).toEqual({
      cwd: "/srv/app",
      label: "app",
    });
  });
});

describe("recordKeeper (the refresh)", () => {
  function kept() {
    const configDir = tempDir();
    const { name: _name, v: _v, ...fields } = record();
    const created = createRecord(configDir, fields, "app");
    return { configDir, created, keeper: recordKeeper(configDir, created, () => 1_000) };
  }
  function fakeClient(discovery: DaemonDiscovery) {
    let listener: ((d: DaemonDiscovery) => void) | undefined;
    const client = {
      discover: async (l: (d: DaemonDiscovery) => void) => {
        listener = l;
        return discovery;
      },
    } as unknown as RemoteClient;
    return { client, push: (d: DaemonDiscovery) => listener?.(d) };
  }
  const stored = (configDir: string): ComputerRecord => {
    const read = readRecord(configDir, "app");
    if (!read.ok) throw new Error("no record");
    return read.record;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  test("writes the winning address and each discovery change", async () => {
    const { configDir, keeper } = kept();
    keeper.answered(A);
    expect(stored(configDir).lastAddress).toBe(A);
    const fake = fakeClient(announce("/srv/app", [B]));
    const errors: string[] = [];
    keeper.onClient(fake.client, (e) => errors.push(e.message));
    await settle();
    expect(stored(configDir).addresses).toEqual([B, A]);
    expect(stored(configDir).lastAddress).toBe(A);
    fake.push(announce("/srv/app", [RELAY]));
    expect(stored(configDir).addresses).toEqual([RELAY, B, A]);
    expect(errors).toEqual([]);
  });

  test("a failed write is REPORTED, never thrown; one before the TUI is held (F13)", async () => {
    const { configDir, keeper } = kept();
    removeRecord(configDir, "app");
    expect(() => keeper.answered(A)).not.toThrow();
    const errors: string[] = [];
    keeper.onClient(fakeClient(announce("/srv/app", [B])).client, (e) => errors.push(e.message));
    await settle();
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("could not update the saved record for 'app'");
  });

  test("a failed discovery is reported", async () => {
    const { keeper } = kept();
    const errors: string[] = [];
    const client = {
      discover: () => Promise.reject(new Error("boom")),
    } as unknown as RemoteClient;
    keeper.onClient(client, (e) => errors.push(e.message));
    await settle();
    expect(errors.join()).toContain("boom");
  });
});

describe("deviceConnectError", () => {
  const hint = (error: unknown): string => deviceConnectError(error, record()).message;

  test("unauthorized: the key was refused (F6)", () => {
    const out = deviceConnectError(new ChannelError("unauthorized", "denied"), record());
    expect(out.message).toContain("this laptop's key was refused (revoked?) — pair again");
    expect(out.message).toContain("tentacle devices");
  });

  test("unreachable or rejected: is serve running, did the key change (F7, F8)", () => {
    for (const kind of ["unreachable", "rejected"] as const) {
      const message = hint(new ChannelError(kind, "closed"));
      expect(message).toContain("no address answered — is `serve` running there?");
      expect(message).toContain("computer key changed? pair again");
      expect(message).toContain("closed");
    }
  });

  test("a channel version skew says to update, not to pair (F10)", () => {
    const message = hint(new ChannelError("rejected", "version 3", undefined, 3));
    expect(message).toContain("version 3");
    expect(message).toContain("update tentacle");
    expect(message).not.toContain("pair again");
  });

  test("any other error is passed through unchanged", () => {
    const other = new Error("no session");
    expect(deviceConnectError(other, record())).toBe(other);
  });
});

describe("routeConnect (D8)", () => {
  const route = (positional: string[], flags: [string, string][] = [], bools: string[] = []) =>
    routeConnect({ positional, flags: new Map(flags), bools: new Set(bools) });

  test("ws(s):// is the token path", () => {
    expect(route(["wss://h:1"], [["token", "t"]])).toEqual({ kind: "url", url: "wss://h:1" });
    expect(route(["WS://h:1"])).toEqual({ kind: "url", url: "WS://h:1" });
  });

  test("anything else is a record name; resume flags are allowed", () => {
    expect(route(["app"], [["resume", "x"]], ["continue"])).toEqual({
      kind: "device",
      name: "app",
    });
  });

  test("a token or TLS flag with a name is refused in one line", () => {
    for (const out of [
      route(["app"], [["token", "t"]]),
      route(["app"], [["token-command", "c"]]),
      route(["app"], [["ca-cert", "f"]]),
      route(["app"], [], ["insecure-skip-tls-verify"]),
    ]) {
      expect(out.kind).toBe("error");
      expect(out.kind === "error" && out.message).toContain("pairing key replaces it");
      expect(out.kind === "error" && out.message.includes("\n")).toBe(false);
    }
  });

  test("--pair and --forget take nothing else", () => {
    expect(route([], [["pair", "X"]])).toEqual({ kind: "pair", payload: "X" });
    expect(route([], [["forget", "app"]])).toEqual({ kind: "forget", name: "app" });
    expect(route(["app"], [["pair", "X"]]).kind).toBe("error");
    expect(
      route(
        [],
        [
          ["pair", "X"],
          ["forget", "a"],
        ],
      ).kind,
    ).toBe("error");
    expect(route([], [["forget", "a"]], ["continue"]).kind).toBe("error");
    expect(
      route(
        [],
        [
          ["pair", "X"],
          ["token", "t"],
        ],
      ).kind,
    ).toBe("error");
  });

  test("no target, or an empty one, is a usage error (F11)", () => {
    expect(route([]).kind).toBe("error");
    expect(route([""]).kind).toBe("error");
  });
});
