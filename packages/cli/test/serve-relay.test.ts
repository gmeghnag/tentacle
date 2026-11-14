/**
 * `serve` + the mobile relay (docs/feat/mobile-relay.md R5a): the decision
 * (`relayChoice`, pure), the identity file, the address in the daemon's record,
 * `--no-relay`/`--relay`/`relay.enabled`, the URL refusal, and the pod-like case
 * that must never dial (F20).
 *
 * Each block names the mutation it kills:
 * - `--no-relay` off → a user who opted out is dialled anyway by a config
 *   default (and "a user who never pairs never contacts the relay" breaks);
 * - a non-loopback `ws://` URL silently downgraded to "off" → a user who asked
 *   for a relay loses it with no word said (and accepting it sends the secret in
 *   the clear);
 * - the record's `addresses` with the relay address FIRST → the phone tries the
 *   relay before the LAN, which is the wrong order for every user at home, and
 *   R6's stagger then has nothing to prefer;
 * - `--no-relay` still creating `relay.json` → an opted-out user gets an id, an
 *   address in their QR and a dial;
 * - a daemon WITHOUT the device route (a pod's options) wired to the link → a pod
 *   registers an id and holds a relay identity, AGENTS §7.
 *
 * The relay the integration part runs against is R2's REAL service on
 * `127.0.0.1:0` (never the hosted one), so "is it registered?" is a real read of
 * its registry.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import { type DaemonRecord, addDevice, readDaemonRecords } from "@tentacle/daemon";
import { DEFAULT_RELAY_URL } from "@tentacle/protocol";
import { publicKeyOf } from "@tentacle/transport/noise";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { relaySecretPath } from "../src/relay-secret.ts";
import { relayChoice } from "../src/serve-relay.ts";
import { type ServeOptions, daemonStoreDir, startDaemon } from "../src/serve.ts";

const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];
const relays: { stop(): void }[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const r of relays.splice(0)) r.stop();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The decision (pure): precedence and the URL rule.
// ---------------------------------------------------------------------------

type Options = Parameters<typeof relayChoice>[0];

const kind = (options: Options): string => {
  const result = relayChoice(options);
  return result.kind === "on" ? `on ${result.url}` : result.kind === "off" ? "off" : "refused";
};
const refusedReason = (options: Options): string => {
  const result = relayChoice(options);
  return result.kind === "refused" ? result.reason : "";
};

describe("relayChoice: on by default, at the ONE hosted URL", () => {
  test("no flag and no config section → the hosted relay", () => {
    expect(relayChoice({})).toEqual({ kind: "on", url: DEFAULT_RELAY_URL });
    expect(DEFAULT_RELAY_URL).toBe("wss://relay.tentacle.so");
  });

  test("a config URL replaces it; `enabled: true` alone keeps the default", () => {
    expect(kind({ config: { url: "wss://relay.example" } })).toBe("on wss://relay.example");
    expect(kind({ config: { enabled: true } })).toBe(`on ${DEFAULT_RELAY_URL}`);
  });

  test("`relay.enabled: false` → off", () => {
    expect(relayChoice({ config: { enabled: false } })).toEqual({ kind: "off" });
  });
});

describe("relayChoice: --no-relay beats everything, --relay beats the config", () => {
  test("--no-relay is off whatever the config says", () => {
    expect(relayChoice({ noRelay: true })).toEqual({ kind: "off" });
    expect(relayChoice({ noRelay: true, config: { url: "wss://relay.example" } })).toEqual({
      kind: "off",
    });
    // The CLI refuses `--relay` with `--no-relay` (a conflict), so this shape
    // cannot come from a command line — pinned anyway so the rule lives here too.
    expect(relayChoice({ noRelay: true, flagUrl: "wss://relay.example" })).toEqual({ kind: "off" });
  });

  test("--relay turns it on even when the config disabled it", () => {
    expect(kind({ flagUrl: "wss://relay.example", config: { enabled: false } })).toBe(
      "on wss://relay.example",
    );
  });

  test("--relay URL beats relay.url, and a URL nobody reads cannot refuse the start", () => {
    expect(kind({ flagUrl: "wss://a.example", config: { url: "wss://b.example" } })).toBe(
      "on wss://a.example",
    );
    expect(kind({ flagUrl: "wss://good.example", config: { url: "ws://example.com" } })).toBe(
      "on wss://good.example",
    );
  });
});

describe("relayChoice: an unusable URL is REFUSED with the reason (F19)", () => {
  test("a non-loopback ws:// is refused — the secret must not cross a clear network", () => {
    const reason = refusedReason({ flagUrl: "ws://example.com:4100" });
    expect(reason).toContain("--relay");
    expect(reason).toContain("wss://");
  });

  test('an http(s) URL is refused, and an empty one is not read as "unset"', () => {
    expect(refusedReason({ flagUrl: "https://relay.example" })).toContain("wss://");
    expect(refusedReason({ config: { url: "http://relay.example" } })).toContain("relay.url");
    expect(refusedReason({ flagUrl: "" })).toContain("--relay");
  });

  test("a loopback ws:// is allowed (dev and tests run the relay locally)", () => {
    expect(kind({ flagUrl: "ws://127.0.0.1:4100" })).toBe("on ws://127.0.0.1:4100");
    expect(kind({ config: { url: "ws://localhost:4100" } })).toBe("on ws://localhost:4100");
    expect(kind({ flagUrl: "ws://[::1]:4100" })).toBe("on ws://[::1]:4100");
  });
});

// ---------------------------------------------------------------------------
// `serve` with a REAL local relay.
// ---------------------------------------------------------------------------

/** A local relay: the real service, on a loopback ephemeral port (never the hosted one). */
function localRelay(): { url: string; registeredCount(): number } {
  const relay = startRelay({ port: 0 });
  relays.push(relay);
  return {
    url: `ws://127.0.0.1:${relay.port}`,
    registeredCount: () => relay.core.registeredCount,
  };
}

interface Rig {
  readonly root: string;
  readonly configDir: string;
  readonly cwd: string;
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "serve-relay-"));
  dirs.push(root);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { root, configDir, cwd };
}

async function serve(
  where: Rig,
  over: { relay?: ServeOptions["relay"]; addresses?: readonly string[]; devices?: boolean } = {},
) {
  const config = await loadConfig({
    configDir: where.configDir,
    cwd: where.cwd,
    scaffold: false,
    env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const notices: string[] = [];
  const audit: string[] = [];
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    onNotice: (line) => notices.push(line),
    onAudit: (line) => audit.push(line),
    // Discovery OFF: this file is about the relay, not sibling announcements
    // (which would also re-read the record every 10 ms).
    discovery: false,
    ...(over.relay !== undefined ? { relay: over.relay } : {}),
    ...(over.addresses !== undefined ? { addresses: over.addresses } : {}),
    ...(over.devices !== undefined ? { devices: over.devices } : {}),
  });
  handles.push(handle);
  return { config, handle, notices, audit, store: daemonStoreDir(config) };
}

const recordOf = (configDir: string): DaemonRecord | undefined => readDaemonRecords(configDir)[0];

async function waitFor(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/** A paired phone in the store — what makes the daemon actually dial (Owner Q1). */
function pairPhone(configDir: string): void {
  const added = addDevice(configDir, {
    publicKey: publicKeyOf(new Uint8Array(32).fill(2)),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) throw new Error(added.reason);
}

describe("serve: the relay identity is created once and reused", () => {
  test("<store>/relay.json exists, and a second start reuses the SAME id (F15)", async () => {
    const where = rig();
    const relay = localRelay();
    const first = await serve(where, { relay: { flagUrl: relay.url } });
    const path = relaySecretPath(first.store);
    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).v).toBe(1);
    const before = readFileSync(path, "utf8");
    const id = first.handle.relay?.id ?? "";
    expect(id).not.toBe("");
    await handles.pop()?.stop();

    const second = await serve(where, { relay: { flagUrl: relay.url } });
    expect(second.handle.relay?.id).toBe(id);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("the id is relayIdOf(the file's secret), and the address is built from it", async () => {
    const where = rig();
    const relay = localRelay();
    const started = await serve(where, { relay: { flagUrl: relay.url } });
    const file = JSON.parse(readFileSync(relaySecretPath(started.store), "utf8"));
    const id = relayIdOf(new Uint8Array(Buffer.from(file.secret, "base64url")));
    expect(started.handle.relay?.id).toBe(id);
    expect(started.handle.relay?.address).toBe(`${relay.url}/d/${id}/e2e`);
  });

  test("two projects on one computer get different relay ids (one address per daemon)", async () => {
    const root = mkdtempSync(join(tmpdir(), "serve-relay-2proj-"));
    dirs.push(root);
    const relay = localRelay();
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    const configDir = join(root, "config");
    const one = await serve({ root, configDir, cwd: a }, { relay: { flagUrl: relay.url } });
    const two = await serve({ root, configDir, cwd: b }, { relay: { flagUrl: relay.url } });
    expect(one.handle.relay?.id).toBeString();
    expect(two.handle.relay?.id).toBeString();
    expect(one.handle.relay?.id).not.toBe(two.handle.relay?.id);
  });
});

describe("serve: the record carries the relay address, LAST (Design §5)", () => {
  test("direct addresses first, the relay's appended after them", async () => {
    const where = rig();
    const relay = localRelay();
    const started = await serve(where, {
      relay: { flagUrl: relay.url },
      addresses: ["wss://mac.tailnet.ts.net/e2e"],
    });
    const record = recordOf(where.configDir);
    const address = started.handle.relay?.address ?? "";
    expect(record?.addresses).toEqual(["wss://mac.tailnet.ts.net/e2e", address]);
    expect(record?.addresses?.at(-1)).toContain("/d/");
  });

  test("a relay-only daemon (loopback bind, no --address) still offers the relay address", async () => {
    const where = rig();
    const relay = localRelay();
    const started = await serve(where, { relay: { flagUrl: relay.url } });
    expect(recordOf(where.configDir)?.addresses).toEqual([started.handle.relay?.address ?? ""]);
  });

  test("an --address that already IS the relay address is not duplicated", async () => {
    const where = rig();
    const relay = localRelay();
    const probe = await serve(where, { relay: { flagUrl: relay.url } });
    const address = probe.handle.relay?.address ?? "";
    await handles.pop()?.stop();
    const again = await serve(where, { relay: { flagUrl: relay.url }, addresses: [address] });
    expect(recordOf(where.configDir)?.addresses).toEqual([again.handle.relay?.address ?? ""]);
  });
});

describe("serve: the relay is off when it is not wanted", () => {
  test("--no-relay: no relay.json, no link, no relay address, no dial", async () => {
    const where = rig();
    const relay = localRelay();
    pairPhone(where.configDir);
    const started = await serve(where, { relay: { flagUrl: relay.url, noRelay: true } });
    await Bun.sleep(30);
    expect(existsSync(relaySecretPath(started.store))).toBe(false);
    expect(started.handle.relay).toBeUndefined();
    expect(recordOf(where.configDir)?.addresses ?? []).toEqual([]);
    expect(relay.registeredCount()).toBe(0);
  });

  test("relay.enabled: false in the config file is the same off", async () => {
    const where = rig();
    const relay = localRelay();
    writeFileSync(
      join(where.configDir, "config.jsonc"),
      `{ "relay": { "enabled": false, "url": "${relay.url}" } }\n`,
    );
    const started = await serve(where);
    expect(existsSync(relaySecretPath(started.store))).toBe(false);
    expect(started.handle.relay).toBeUndefined();
    expect(relay.registeredCount()).toBe(0);
  });

  test("the config file's relay.url is used when no flag says otherwise", async () => {
    const where = rig();
    const relay = localRelay();
    writeFileSync(
      join(where.configDir, "config.jsonc"),
      `{ "relay": { "url": "${relay.url}" } }\n`,
    );
    const started = await serve(where);
    expect(started.handle.relay?.address).toStartWith(`${relay.url}/d/`);
  });

  test("a paired phone makes it dial and register; a store with no device does not", async () => {
    const where = rig();
    const relay = localRelay();
    const empty = await serve(where, { relay: { flagUrl: relay.url } });
    await Bun.sleep(60);
    // Owner Q1: no device and no pairing window ⇒ never contact the relay.
    expect(relay.registeredCount()).toBe(0);
    expect(empty.handle.relay?.isConnected()).toBe(false);
    await handles.pop()?.stop();

    pairPhone(where.configDir);
    const paired = await serve(where, { relay: { flagUrl: relay.url } });
    await waitFor(() => paired.handle.relay?.isConnected() === true, "the registration");
    expect(relay.registeredCount()).toBe(1);
    expect(paired.audit.some((line) => line.startsWith("relay-ready"))).toBe(true);
  });
});

describe("serve: an unusable URL refuses to start (F19)", () => {
  test("serve --relay ws://example.com throws, and nothing is bound", async () => {
    const where = rig();
    await expect(serve(where, { relay: { flagUrl: "ws://example.com:4100" } })).rejects.toThrow(
      /wss:\/\//,
    );
  });

  test("a config relay.url of http:// refuses too", async () => {
    const where = rig();
    writeFileSync(
      join(where.configDir, "config.jsonc"),
      `{ "relay": { "url": "http://relay.example" } }\n`,
    );
    await expect(serve(where)).rejects.toThrow(/relay\.url/);
  });
});

describe("serve: a pod-like daemon never dials and never writes relay.json (F20)", () => {
  test("devices: false → no link, no identity file, no relay address", async () => {
    const where = rig();
    const relay = localRelay();
    const started = await serve(where, { relay: { flagUrl: relay.url }, devices: false });
    expect(started.handle.relay).toBeUndefined();
    expect(existsSync(relaySecretPath(started.store))).toBe(false);
    // No device route ⇒ no record ⇒ no address anywhere.
    expect(recordOf(where.configDir)).toBeUndefined();
    expect(relay.registeredCount()).toBe(0);
  });
});

describe("serve: a relay.json this build cannot use turns the relay OFF, loudly", () => {
  test("an unknown v: the daemon serves, the relay is off, the file is untouched", async () => {
    const where = rig();
    const relay = localRelay();
    const config = await loadConfig({
      configDir: where.configDir,
      cwd: where.cwd,
      scaffold: false,
      env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
    });
    const store = daemonStoreDir(config);
    mkdirSync(store, { recursive: true });
    const path = relaySecretPath(store);
    const future = `{ "v": 2, "secret": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }\n`;
    writeFileSync(path, future);

    const started = await serve(where, { relay: { flagUrl: relay.url } });
    // Serving, not dead: a file only the relay needs must not cost a `serve`.
    expect(started.handle.url).toBeString();
    expect(started.handle.relay).toBeUndefined();
    expect(started.notices.join("")).toContain("mobile relay off");
    expect(started.notices.join("")).toContain("version 2");
    expect(readFileSync(path, "utf8")).toBe(future);
    // No address was published either: nothing was dialled.
    expect(recordOf(where.configDir)?.addresses ?? []).toEqual([]);
    expect(relay.registeredCount()).toBe(0);
  });
});
