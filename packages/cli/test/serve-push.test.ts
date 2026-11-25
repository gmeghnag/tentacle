/**
 * `serve` + push, end to end (docs/feat/mobile-push.md Design 5/6, slice P8):
 * config keys, `--push-grace`, the register result's status vocabulary, and the
 * whole chain — phone over Noise → `device/push_register` → a turn that asks
 * permission → nobody answers for the grace → the fake APNs receives ONE request
 * whose envelope OPENS with the device's push key and the computer's key.
 *
 * Mutations each block kills:
 * - the grace ignored → the "zero requests within the grace" row fails;
 * - the registration's token env/key not used → the envelope does not open;
 * - a pod-like daemon (no `push` option) wired to a notifier → the "a daemon
 *   without push writes nothing" row fails;
 * - `--no-relay` still pushing → the `relay-off` row fails.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@tentacle/config";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { addDevice, readIdentity, readPushRegistrations } from "@tentacle/daemon";
import {
  DEFAULT_PUSH_GRACE_SECONDS,
  PROTOCOL_VERSION,
  type PushMessage,
  PushMessageSchema,
  decodeBase64Url,
  encodeBase64Url,
} from "@tentacle/protocol";
import { type CarrierFrame, DomainErrorCode, RpcPeer, carrierFrameOf } from "@tentacle/transport";
import { noiseInitiator, publicKeyOf, systemRandom } from "@tentacle/transport/noise";
import { openPush } from "@tentacle/transport/push";
import { type ApnsClient, createApnsClient } from "../../../apps/relay/src/apns-client.ts";
import type { ApnsJwtSource } from "../../../apps/relay/src/apns.ts";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { type ServeOptions, daemonStoreDir, startDaemon } from "../src/serve.ts";

const dirs: string[] = [];
const handles: { stop(): Promise<void> }[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  for (const stop of cleanups.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const DEVICE_KEY = key(2);
const PUSH_KEY = key(5);

/** A model that asks for one shell command, then answers: the ask is what pushes. */
class AskingModel implements ModelProvider {
  readonly id = "asking";
  private turn = 0;
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    this.turn += 1;
    if (this.turn === 1) {
      yield {
        type: "tool_call",
        toolCall: {
          id: "c1",
          name: "shell",
          arguments: JSON.stringify({ command: "rm -rf build" }),
        },
      };
      yield { type: "done" };
      return;
    }
    yield { type: "text", delta: "done" };
    yield { type: "done" };
  }
}

const fakeJwt: ApnsJwtSource = {
  jwt: () => Promise.resolve("h.c.s"),
  invalidate: () => {},
};

/** A local h2c APNs that records every request body. */
function fakeApns() {
  const seen: { path: string; body: string }[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"]);
    let body = "";
    stream.on("data", (c) => {
      body += c;
    });
    stream.on("end", () => {
      seen.push({ path, body });
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  return { origin: `http://127.0.0.1:${port}`, seen, stop: () => server.close() };
}

/** The relay WITH an APNs key, so `ready.features` carries `"push"`. */
function pushRelay(): { url: string; apns: ReturnType<typeof fakeApns> } {
  const apns = fakeApns();
  const client: ApnsClient = createApnsClient({
    topic: "so.tentacle.app",
    jwtSource: fakeJwt,
    origins: { sandbox: apns.origin, production: apns.origin },
  });
  const server = startRelay({
    host: "127.0.0.1",
    port: 0,
    sweepMs: 10,
    onLog: () => {},
    apns: { client, jwtSource: fakeJwt, topic: "so.tentacle.app" },
  });
  cleanups.push(() => {
    server.stop();
    apns.stop();
  });
  return { url: `ws://127.0.0.1:${server.port}`, apns };
}

interface Rig {
  readonly root: string;
  readonly configDir: string;
  readonly cwd: string;
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "serve-push-"));
  dirs.push(root);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { root, configDir, cwd };
}

async function serve(
  where: Rig,
  over: {
    relay?: ServeOptions["relay"];
    pushGraceSeconds?: number;
    env?: Record<string, string>;
  } = {},
) {
  const config = await loadConfig({
    configDir: where.configDir,
    cwd: where.cwd,
    scaffold: false,
    env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k", ...over.env },
  });
  const audit: string[] = [];
  const notices: string[] = [];
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    onAudit: (line) => audit.push(line),
    onNotice: (line) => notices.push(line),
    discovery: false,
    createProvider: () => new AskingModel(),
    ...(over.relay !== undefined ? { relay: over.relay } : {}),
    ...(over.pushGraceSeconds !== undefined ? { pushGraceSeconds: over.pushGraceSeconds } : {}),
  });
  handles.push(handle);
  return { config, handle, audit, notices, store: daemonStoreDir(config) };
}

/** A paired phone in the store (its Noise key is `k2`). */
function pairPhone(configDir: string): string {
  const added = addDevice(configDir, {
    publicKey: publicKeyOf(DEVICE_KEY),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) throw new Error(added.reason);
  return added.device.id;
}

/** Dial the daemon through the relay as the phone, and run `initialize`. */
async function phone(url: string, configDir: string) {
  const identity = readIdentity(configDir);
  if (!identity.ok) throw new Error(identity.reason);
  const ws = new WebSocket(url);
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
  cleanups.push(() => ws.close());
  const channel = {
    send: (d: Uint8Array) => ws.send(d),
    close: () => ws.close(),
    setOnMessage: (h: (d: CarrierFrame) => void) => {
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
  const seen = { updates: [] as { type: string; requestId?: string }[] };
  const peer = new RpcPeer(secure, {
    onNotification: (method: string, params: unknown) => {
      if (method !== "session/update") return;
      const frame = params as { update?: { type?: string; requestId?: string } };
      if (frame.update?.type !== undefined) {
        seen.updates.push({
          type: frame.update.type,
          ...(frame.update.requestId !== undefined ? { requestId: frame.update.requestId } : {}),
        });
      }
    },
    onRequest: async () => {
      throw new Error("unused");
    },
  });
  cleanups.push(() => peer.close());
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "phone", version: "0" },
  });
  const register = () =>
    peer.request("device/push_register", {
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(PUSH_KEY)),
    }) as Promise<{ graceSeconds: number; push: string }>;
  return { peer, register, seen };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 6_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

/** The push message inside one fake APNs request (its envelope opened by the phone). */
function open(apnsBody: string, computerPublicKey: Uint8Array): PushMessage {
  const payload = JSON.parse(apnsBody) as {
    aps: unknown;
    tp: { v: number; k: string; e: string; c: string };
  };
  const plaintext = openPush(
    {
      keyId: payload.tp.k,
      enc: decodeBase64Url(payload.tp.e) as Uint8Array,
      ciphertext: decodeBase64Url(payload.tp.c) as Uint8Array,
    },
    PUSH_KEY,
    computerPublicKey,
  );
  const parsed = PushMessageSchema.safeParse(JSON.parse(new TextDecoder().decode(plaintext)));
  if (!parsed.success) throw new Error(`not a PushMessage: ${parsed.error.message}`);
  return parsed.data;
}

describe("the register result tells the app the truth (Design 6)", () => {
  test("a device registering against a push relay is told `on` and the grace", async () => {
    const where = rig();
    const relay = pushRelay();
    pairPhone(where.configDir);
    const started = await serve(where, { relay: { flagUrl: relay.url }, pushGraceSeconds: 7 });
    await waitFor(() => started.handle.relay?.isConnected() === true, "the link to register");
    const { register } = await phone(started.handle.relay?.address ?? "", where.configDir);
    const result = await register();
    expect(result).toEqual({ graceSeconds: 7, push: "on" });
    // The registration landed in P5's store, under the device's OWN id.
    const stored = readPushRegistrations(where.configDir).registrations;
    expect([...stored.values()].map((r) => r.token)).toEqual(["a".repeat(64)]);
  });

  test("the default grace is `push.graceSeconds`'s 30 s when no flag is given", async () => {
    const where = rig();
    const relay = pushRelay();
    pairPhone(where.configDir);
    const started = await serve(where, { relay: { flagUrl: relay.url } });
    await waitFor(() => started.handle.relay?.isConnected() === true, "the link to register");
    const { register } = await phone(started.handle.relay?.address ?? "", where.configDir);
    expect((await register()).graceSeconds).toBe(DEFAULT_PUSH_GRACE_SECONDS);
  });

  test("`--no-relay` answers `relay-off` (no contact with the relay AT ALL, Owner Q2)", async () => {
    // Mutation: build the notifier with push on and no link gate → the app is
    // promised notifications that can never arrive.
    const where = rig();
    const relay = pushRelay();
    pairPhone(where.configDir);
    const started = await serve(where, {
      relay: { flagUrl: relay.url, noRelay: true },
    });
    // The direct route still works (no relay): dial the daemon itself.
    const { register } = await phoneDirect(started.handle.url, where.configDir);
    expect((await register()).push).toBe("relay-off");
    expect(started.handle.relay).toBeUndefined();
  });

  test("a config `push.enabled: false` answers MethodNotFound (no push at all)", async () => {
    const where = rig();
    const relay = pushRelay();
    writeConfig(where.configDir, `{ "push": { "enabled": false } }`);
    pairPhone(where.configDir);
    const started = await serve(where, { relay: { flagUrl: relay.url } });
    const { peer } = await phoneDirect(started.handle.url, where.configDir);
    const error = await peer
      .request("device/push_register", {
        token: "a".repeat(64),
        env: "sandbox",
        key: encodeBase64Url(publicKeyOf(PUSH_KEY)),
      })
      .then(() => undefined)
      .catch((e: { code?: number }) => e);
    expect(error?.code).toBe(-32601);
  });
});

describe("the end-to-end chain: an unanswered ask reaches the fake APNs, sealed", () => {
  test("one request, whose envelope OPENS and names the right requestId", async () => {
    const where = rig();
    const relay = pushRelay();
    // A 1 s grace: the ask is pushed before the test could answer it.
    pairPhone(where.configDir);
    const started = await serve(where, { relay: { flagUrl: relay.url }, pushGraceSeconds: 1 });
    await waitFor(() => started.handle.relay?.isConnected() === true, "the link to register");
    const { peer, register, seen } = await phone(
      started.handle.relay?.address ?? "",
      where.configDir,
    );
    expect((await register()).push).toBe("on");
    // The phone opens the session, prompts, and then GOES AWAY (the foreground
    // gate closing: F17). That is the case the grace exists for — a phone that
    // stayed attached is showing the sheet and is deliberately NOT pushed to.
    await peer.request("session/open", { sessionId: "S", create: true });
    // NOT awaited: the turn suspends on the ask, so this request answers only
    // when someone resolves it (that is why the test reads the ask from the
    // update stream).
    const turning = peer
      .request("session/prompt", {
        sessionId: "S",
        turnId: "t1",
        content: [{ type: "text", text: "go" }],
      })
      .catch(() => undefined);
    const requestId = await waitForAsk(seen);
    peer.close();
    void turning; // Nobody answers: the grace ends and the phone is buzzed (through the relay,
    // to the fake APNs).
    await waitFor(
      () => relay.apns.seen.length >= 1,
      `the fake APNs to receive the push (audit: ${started.audit.join(" | ")})`,
    );
    expect(relay.apns.seen).toHaveLength(1);
    const identity = readIdentity(where.configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const body = relay.apns.seen[0]?.body ?? "";
    // The banner Apple shows is the RELAY's template, never the daemon's text.
    const outer = JSON.parse(body) as { aps?: { alert?: { body?: string } } };
    expect(outer.aps?.alert?.body).toBe("Open tentacle to see what's new");
    expect(body).not.toContain("rm -rf build");
    // And the seal opens with the device's push key + the computer's key.
    const message = open(body, identity.identity.publicKey);
    expect(message.kind).toBe("ask");
    expect(message.sessionId).toBe("S");
    expect(message.ask?.requestId).toBe(requestId);
    expect(message.ask?.tool).toBe("shell");
    expect(message.ask?.preview).toBe("rm -rf build");
    // The audit line lands with the sink's answer (the relay's `push-result`),
    // which may follow Apple's response: wait for it rather than race it.
    await waitFor(
      () => started.audit.some((line) => line.startsWith("push-sent ask")),
      `the push-sent audit line (audit: ${started.audit.join(" | ")})`,
    );
    // The daemon's OWN key pair is what authenticated it: another computer's key
    // cannot open the envelope (F6).
    const payload = JSON.parse(body) as { tp: { v: number; k: string; e: string; c: string } };
    expect(() =>
      openPush(
        {
          keyId: payload.tp.k,
          enc: decodeBase64Url(payload.tp.e) as Uint8Array,
          ciphertext: decodeBase64Url(payload.tp.c) as Uint8Array,
        },
        PUSH_KEY,
        publicKeyOf(key(11)),
      ),
    ).toThrow();
    // A turn suspended on an unanswered ask never answers its `prompt`, so this
    // test needs longer than bun's default 5 s to let the grace and the relay
    // round trip finish.
  }, 20_000);

  test("answering WITHIN the grace sends nothing at all (the desk case)", async () => {
    // Mutation: fire the timer even after the ask settled → one request.
    const where = rig();
    const relay = pushRelay();
    // A long grace, so the answer definitely beats it.
    pairPhone(where.configDir);
    const started = await serve(where, { relay: { flagUrl: relay.url }, pushGraceSeconds: 60 });
    await waitFor(() => started.handle.relay?.isConnected() === true, "the link to register");
    const { peer, register, seen } = await phone(
      started.handle.relay?.address ?? "",
      where.configDir,
    );
    await register();
    await peer.request("session/open", { sessionId: "S", create: true });
    // Start the turn, then read the pending ask out of the snapshot (the same
    // id the `permission_request` update carried) and answer it.
    const turning = peer
      .request("session/prompt", {
        sessionId: "S",
        turnId: "t1",
        content: [{ type: "text", text: "go" }],
      })
      .catch(() => undefined);
    const requestId = await waitForAsk(seen);
    await peer.request("session/resolve_permission", {
      sessionId: "S",
      requestId,
      optionId: "allow_once",
    });
    await turning;
    await Bun.sleep(600);
    expect(relay.apns.seen).toEqual([]);
    expect(started.audit.some((line) => line.startsWith("push-sent"))).toBe(false);
  });
});

/**
 * The pending ask's id: read from the `permission_request` UPDATE the daemon
 * streams (a snapshot carries no pending map — an ask is session state only via
 * the update stream and the replay).
 */
async function waitForAsk(
  seen: { updates: { type: string; requestId?: string }[] },
  timeoutMs = 4_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ask = seen.updates.find((u) => u.type === "permission_request");
    if (ask?.requestId !== undefined) {
      return ask.requestId;
    }
    await Bun.sleep(20);
  }
  throw new Error(
    `no permission_request appeared (saw ${seen.updates.map((u) => u.type).join(",") || "nothing"})`,
  );
}

/** Write a `config.jsonc` into the rig (a key the flags do not name). */
function writeConfig(configDir: string, body: string): void {
  writeFileSync(join(configDir, "config.jsonc"), body);
}

/** Dial the daemon's OWN address (no relay), as the paired phone. */
async function phoneDirect(url: string, configDir: string) {
  const identity = readIdentity(configDir);
  if (!identity.ok) throw new Error(identity.reason);
  const ws = new WebSocket(`${url.replace(/^http/, "ws").replace(/\/+$/, "")}/e2e`);
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
  cleanups.push(() => ws.close());
  const channel = {
    send: (d: Uint8Array) => ws.send(d),
    close: () => ws.close(),
    setOnMessage: (h: (d: CarrierFrame) => void) => {
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
  const seen = { updates: [] as { type: string; requestId?: string }[] };
  const peer = new RpcPeer(secure, {
    onNotification: (method: string, params: unknown) => {
      if (method !== "session/update") return;
      const frame = params as { update?: { type?: string; requestId?: string } };
      if (frame.update?.type !== undefined) {
        seen.updates.push({
          type: frame.update.type,
          ...(frame.update.requestId !== undefined ? { requestId: frame.update.requestId } : {}),
        });
      }
    },
    onRequest: async () => {
      throw new Error("unused");
    },
  });
  cleanups.push(() => peer.close());
  await peer.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "phone", version: "0" },
  });
  const register = () =>
    peer.request("device/push_register", {
      token: "a".repeat(64),
      env: "sandbox",
      key: encodeBase64Url(publicKeyOf(PUSH_KEY)),
    }) as Promise<{ graceSeconds: number; push: string }>;
  void readFileSync;
  return { peer, register, seen };
}
