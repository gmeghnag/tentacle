/**
 * Project hooks in a `serve` session (docs/feat/serve-mcp.md S4, owner Q2=a).
 *
 * Today a phone turn silently never runs project hooks: the daemon asks the
 * prompting CLIENT, the phone has no `hooksTrust`, so the answer is
 * `{trusted:false}` with no message anywhere. S4 puts the decision where the
 * folder is: the serve host's OWN trust file (`<configDir>/hooks-trust.json`,
 * the file this machine's TUI writes) is checked FIRST, read-only, and only an
 * untrusted folder is asked about — of the prompting client, through the single
 * broker, never stored from there.
 *
 * Mutation: a precheck that answers "trusted" for an unknown hash → the ask test
 * records no request at all, and a phone turn would run hooks nobody trusted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { addDevice, readIdentity } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import type { HooksTrustParams, HooksTrustResult } from "@tentacle/protocol";
import { type CarrierFrame, RpcPeer, carrierFrameOf } from "@tentacle/transport";
import { noiseInitiator, publicKeyOf, systemRandom } from "@tentacle/transport/noise";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { loadConfig } from "../src/config.ts";
import { fileTrustStore } from "../src/hooks-trust.ts";
import { hooksTrustPrecheck, serveHooksTrustPrecheck } from "../src/serve-hooks-trust.ts";
import { daemonStoreDir, startDaemon } from "../src/serve.ts";

/** The paired phone's Noise key (a fixed one: pairing is the registry, not the test). */
const DEVICE_KEY = new Uint8Array(32).fill(2);

const roots: string[] = [];
const stops: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) {
    try {
      await stop();
    } catch {
      // A test that already stopped the daemon must not fail teardown.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "serve-hooks-"));
  roots.push(root);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { root, cwd, configDir };
}

const params = (folder: string, hash: string): HooksTrustParams => ({
  sessionId: "s-1",
  folder,
  hash,
  hooks: [],
  files: [],
  canAllow: false,
});

/** A model that answers one short text, no tools. */
class QuietModel implements ModelProvider {
  readonly id = "quiet";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "hi" };
    yield { type: "done" };
  }
}

/**
 * A `serve` WITH the device route and a REAL local relay: the usual remote path
 * (S4 review 1, finding 1). Only this route proves the precheck reaches the
 * relay's accept legs — the direct route would pass with it wired to ws-server
 * alone.
 */
async function serveOverRelay(where: ReturnType<typeof rig>) {
  const relay = startRelay({ host: "127.0.0.1", port: 0, sweepMs: 10, onLog: () => {} });
  stops.push(() => relay.stop());
  const added = addDevice(where.configDir, {
    publicKey: publicKeyOf(DEVICE_KEY),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) throw new Error(added.reason);
  const config = await loadConfig({
    configDir: where.configDir,
    cwd: where.cwd,
    scaffold: false,
    env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    discovery: false,
    relay: { noRelay: false, flagUrl: `ws://127.0.0.1:${relay.port}` },
    createProvider: () => new QuietModel(),
  });
  stops.push(() => handle.stop());
  const address = handle.relay?.address ?? "";
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && handle.relay?.isConnected() !== true) await Bun.sleep(5);
  if (handle.relay?.isConnected() !== true) throw new Error("the relay link never registered");
  return { config, handle, address };
}

/** The phone, over the relay: Noise against the computer key, then RPC. Asks recorded. */
async function phoneOverRelay(address: string, configDir: string, answer: boolean) {
  const identity = readIdentity(configDir);
  if (!identity.ok) throw new Error(identity.reason);
  const ws = new WebSocket(address);
  let onMessage: ((data: CarrierFrame) => void) | undefined;
  ws.binaryType = "arraybuffer";
  let onClose: (() => void) | undefined;
  ws.addEventListener("message", (e) => {
    const frame = carrierFrameOf(e.data);
    if (frame !== null) onMessage?.(frame);
  });
  ws.addEventListener("close", () => onClose?.());
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("phone socket error")));
  });
  stops.push(() => ws.close());
  const channel = {
    send: (data: Uint8Array) => ws.send(data),
    close: () => ws.close(),
    setOnMessage: (h: (data: CarrierFrame) => void) => {
      onMessage = h;
    },
    setOnClose: (h: () => void) => {
      onClose = h;
    },
  };
  const secure = await noiseInitiator(channel, {
    staticKey: DEVICE_KEY,
    remoteStatic: identity.identity.publicKey,
    random: systemRandom,
  });
  const asked: unknown[] = [];
  let turnEnded: () => void = () => {};
  const ended = new Promise<void>((resolve) => {
    turnEnded = resolve;
  });
  const peer = new RpcPeer(secure, {
    onNotification: (method: string, params: unknown) => {
      if (method !== "session/update") return;
      const frame = params as { update?: { type?: string } };
      if (frame.update?.type === "turn_end") turnEnded();
    },
    onRequest: async (method, params) => {
      if (method !== "hooks/trust") {
        throw new Error(`unexpected request ${method}`);
      }
      asked.push(params);
      return { trusted: answer };
    },
  });
  stops.push(() => peer.close());
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "phone", version: "0" },
  });
  return { peer, asked, ended };
}

async function serveAt(where: ReturnType<typeof rig>) {
  const config = await loadConfig({
    configDir: where.configDir,
    cwd: where.cwd,
    scaffold: false,
    env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    devices: false,
    discovery: false,
    relay: { noRelay: true },
    createProvider: () => new QuietModel(),
  });
  stops.push(() => handle.stop());
  return { config, handle };
}

describe("hooksTrustPrecheck (pure)", () => {
  test("a trusted entry with the SAME hash answers trusted", () => {
    const entry = { hash: "abc", decision: "trusted" as const };
    expect(hooksTrustPrecheck(() => entry, "/p", "abc")).toBe("trusted");
  });

  test("a different hash or no entry is NOT trusted (the client is asked)", () => {
    const trusted = { hash: "abc", decision: "trusted" as const };
    const never = { hash: "abc", decision: "never" as const };
    const get = (f: string) => (f === "/p" ? trusted : f === "/n" ? never : undefined);
    // Mutation: `hash` ignored → "trusted" for a changed hooks file.
    expect(hooksTrustPrecheck(get, "/p", "different")).toBe("ask");
    expect(hooksTrustPrecheck(get, "/unknown", "abc")).toBe("ask");
  });

  test("a `never` decision DECLINES for any hash, so no client is asked (finding 2)", () => {
    const never = { hash: "abc", decision: "never" as const };
    // The host was told "never" once; it is a decision about the FOLDER, like the
    // TUI's own `trustPrecheck` (hooks-trust.ts:34). Mutation: `never` mapped to
    // "ask" → the phone re-asks a refusal this machine already made.
    expect(hooksTrustPrecheck(() => never, "/n", "abc")).toBe("declined");
    expect(hooksTrustPrecheck(() => never, "/n", "a-DIFFERENT-hash")).toBe("declined");
  });
});

describe("the serve host's own hooks trust", () => {
  test("T13a: trusted in the host's store → the client is never asked", async () => {
    const where = rig();
    const hash = "h-1";
    fileTrustStore(where.configDir).set(where.cwd, { hash, decision: "trusted" });
    const { handle } = await serveAt(where);
    const precheck = serveHooksTrustPrecheck(where.configDir);
    // Exactly what the daemon wraps `askHooksTrust` with.
    expect(precheck(params(where.cwd, hash))).toBe("trusted");

    // And the RPC itself: a client whose resolver records every ask is never
    // reached, because the precheck answers first.
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: false };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    expect(asked).toEqual([]);
  }, 30_000);

  test("T13b: an untrusted folder is asked of the prompting client (and never stored here)", async () => {
    const where = rig();
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    const { handle } = await serveAt(where);
    const precheck = serveHooksTrustPrecheck(where.configDir);
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: true };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    const session = client.newSession();
    for await (const _event of session.send("hello")) {
      // drain the turn
    }
    // Nothing is trusted on this host, so the daemon ASKED the client (never a
    // silent decline); the client said yes and the hook ran.
    expect(asked).toHaveLength(1);
    expect(precheck(asked[0] ?? params("", ""))).toBe("ask");
    expect(existsSync(marker)).toBe(true);
    // The serve host stores NOTHING from a client's answer: the next turn asks again.
    expect(fileTrustStore(where.configDir).get(where.cwd)).toBeUndefined();
  }, 30_000);
});

describe("project hooks in a serve turn", () => {
  test("T13c: an untrusted folder's hook does NOT run in a phone turn", async () => {
    const where = rig();
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    const { handle } = await serveAt(where);
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: false };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    const session = client.newSession();
    for await (const _event of session.send("hello")) {
      // drain the turn
    }
    // The daemon asked (no silent decline) and the hook did not run.
    expect(asked.length).toBeGreaterThan(0);
    expect(realpathSync(asked[0]?.folder ?? "")).toBe(realpathSync(where.cwd));
    expect(existsSync(marker)).toBe(false);
    expect(
      daemonStoreDir(
        await loadConfig({
          configDir: where.configDir,
          cwd: where.cwd,
          scaffold: false,
          env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
        }),
      ),
    ).toBeTruthy();
  }, 60_000);

  test("T13d: TRUSTED in the host's store → the hook runs in a phone turn, unasked", async () => {
    const where = rig();
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    // Discover the folder+hash the way the agent does, then trust it here.
    const { discoverProjectHooks } = await import("@tentacle/config");
    const found = await discoverProjectHooks(where.cwd, where.root);
    const hooks = found.projectHooks;
    expect(hooks).toBeDefined();
    if (!hooks) return;
    fileTrustStore(where.configDir).set(hooks.folder, { hash: hooks.hash, decision: "trusted" });

    const { handle } = await serveAt(where);
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: false };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    const session = client.newSession();
    for await (const _event of session.send("hello")) {
      // drain the turn
    }
    // Mutation: no precheck → the client is asked, answers false, the hook is skipped.
    expect(asked).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  }, 60_000);
});

describe("S4 review round 1: the relay route and the host's `never`", () => {
  /** A folder whose hooks file exists, so a turn has something to decide about. */
  function withHooks(where: ReturnType<typeof rig>): string {
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    return marker;
  }

  async function trustFolderHere(where: ReturnType<typeof rig>, decision: "trusted" | "never") {
    const { discoverProjectHooks } = await import("@tentacle/config");
    const found = await discoverProjectHooks(where.cwd, where.root);
    const hooks = found.projectHooks;
    if (!hooks) throw new Error("the test's hooks file was not discovered");
    fileTrustStore(where.configDir).set(hooks.folder, { hash: hooks.hash, decision });
    return hooks;
  }

  async function turnOverRelay(peer: RpcPeer, ended: Promise<void>): Promise<void> {
    await peer.request("session/open", { sessionId: "S", create: true });
    await peer.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "hello" }],
    });
    // `session/prompt` acks at once: the DECISION (and the hook) happen during
    // the turn, so every assertion below waits for its `turn_end` — else they
    // would pass before anything was decided.
    await ended;
  }

  test("T13e: TRUSTED on this host, a phone turn THROUGH THE RELAY asks nobody (finding 1)", async () => {
    // The remote path that matters: `--relay` is how a phone reaches a `serve`
    // away from home. With the precheck wired to ws-server only, the relay's
    // accept legs built a Connection without it, so the phone was asked every
    // session about a folder this Mac had already trusted.
    const where = rig();
    const marker = withHooks(where);
    await trustFolderHere(where, "trusted");
    const { address } = await serveOverRelay(where);
    const { peer, asked, ended } = await phoneOverRelay(address, where.configDir, false);
    await turnOverRelay(peer, ended);
    // Mutation: no `hooksTrustPrecheck` in `startRelayLink` → this is 1, not 0.
    expect(asked).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  }, 60_000);

  test("T13f: `never` on this host DECLINES a phone turn over the relay, unasked (finding 2)", async () => {
    // The host said "never" for this repo. One tap on a phone prompt must not
    // run those hooks: the decision belongs where the folder is.
    const where = rig();
    const marker = withHooks(where);
    await trustFolderHere(where, "never");
    const { address } = await serveOverRelay(where);
    const { peer, asked, ended } = await phoneOverRelay(address, where.configDir, true);
    await turnOverRelay(peer, ended);
    // Mutation: `never` mapped to "ask" (serve-hooks-trust.ts) → asked is 1 and
    // the phone's `true` runs the hooks the host refused.
    expect(asked).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  }, 60_000);
});
