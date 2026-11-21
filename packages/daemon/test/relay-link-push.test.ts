/**
 * The relay link's PUSH half (docs/feat/mobile-push.md Design 5, slice P8):
 * `relayLink.push` against R2's REAL relay + P4's APNs path with a fake APNs.
 *
 * What each block pins, and the mutation that turns it red:
 * - `features` gate: a relay that did not announce `"push"` gets NO `push`
 *   frame. Mutation: ignore `features` → R2 closes the control socket on the
 *   unknown frame (C1), the link goes down, and the follow-up assertion fails.
 * - correlation: two pushes whose answers arrive OUT OF ORDER each resolve with
 *   its OWN status (R2 answers `5eed` late, on purpose). Mutation: resolve the
 *   oldest pending entry instead of the `n` one → the statuses swap.
 * - `gone` reaches the caller unchanged (the notifier's compare-and-delete needs
 *   it).
 * - a hold while connecting, then a drop, with an audit line (F2).
 * - a control teardown settles every pending push (`unavailable`): nothing leaks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { PermissionBroker, type PermissionRequest, type PermissionResponse } from "@tentacle/core";
import { type PushPayload, RELAY_PROTOCOL_VERSION, encodeBase64Url } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { type ByteCarrier, type CarrierFrame, RpcPeer, carrierFrameOf } from "@tentacle/transport";
import { noiseInitiator, systemRandom } from "@tentacle/transport/noise";
import { publicKeyOf } from "@tentacle/transport/noise";
import { sealPush } from "@tentacle/transport/push";
import { relayIdOf } from "@tentacle/transport/relay-id";
import { type ApnsClient, createApnsClient } from "../../../apps/relay/src/apns-client.ts";
import type { ApnsJwtSource } from "../../../apps/relay/src/apns.ts";
import { startRelay } from "../../../apps/relay/src/server.ts";
import { DeviceAuthority } from "../src/device-authority.ts";
import { addDevice, loadOrCreateIdentity, readIdentity } from "../src/device-store.ts";
import { HandshakeLimiter } from "../src/handshake-limit.ts";
import {
  type RelayLinkTimers,
  type RunningRelayLink,
  bunRelayDialer,
  startRelayLink,
} from "../src/relay-link.ts";
import { SessionHost } from "../src/session-host.ts";

/** This serve's project (docs/feat/mobile-projects.md §2). */
const TEST_PROJECT = { key: "proj-0123456789ab", cwd: "/u/proj" };

const dirs: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const key = (fill: number) => new Uint8Array(32).fill(fill);
const SECRET = new Uint8Array(32).fill(7);
const ID = relayIdOf(SECRET);

const dummyHost = new SessionHost({
  defaultCwd: "/tmp",
  createAgent: () => {
    throw new Error("unused");
  },
});

function store(): string {
  const configDir = mkdtempSync(join(tmpdir(), "relay-push-"));
  dirs.push(configDir);
  const created = loadOrCreateIdentity(configDir, {
    name: "mac",
    now: 1_000,
    random: () => key(1),
  });
  if (!created.ok) throw new Error(created.reason);
  return configDir;
}

function pairPhone(configDir: string): void {
  const added = addDevice(configDir, {
    project: TEST_PROJECT,
    publicKey: publicKeyOf(key(2)),
    name: "iPhone",
    now: 2_000,
  });
  if (!added.ok) throw new Error(added.reason);
}

const fakeJwt: ApnsJwtSource = {
  jwt: () => Promise.resolve("header.claims.signature"),
  invalidate: () => {},
};

/** A local h2c APNs: 200, `410` for a token ending `dead`, and a LATE 200 for `5eed`. */
function fakeApns() {
  const seen: { path: string; body: string }[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    const path = String(headers[":path"]);
    let body = "";
    stream.on("data", (chunk) => {
      body += chunk;
    });
    stream.on("end", () => {
      seen.push({ path, body });
      if (path.endsWith("dead")) {
        stream.respond({ ":status": 410, "content-type": "application/json" });
        stream.end(JSON.stringify({ reason: "Unregistered" }));
        return;
      }
      if (path.endsWith("5eed")) {
        // Answers AFTER the immediate one, so the two `push-result`s are out of order.
        setTimeout(() => {
          stream.respond({ ":status": 200 });
          stream.end("");
        }, 60);
        return;
      }
      stream.respond({ ":status": 200 });
      stream.end("");
    });
  });
  server.listen(0, "127.0.0.1");
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    stop: () => server.close(),
  };
}

/** A relay WITH an APNs key (announces `"push"`), or without. */
function relay(options: { push: boolean }): {
  url: string;
  stop(): void;
  apns?: ReturnType<typeof fakeApns>;
} {
  if (!options.push) {
    const server = startRelay({ host: "127.0.0.1", port: 0, sweepMs: 10, onLog: () => {} });
    const stopped = { url: server.url, stop: () => server.stop() };
    cleanups.push(() => stopped.stop());
    return stopped;
  }
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
  const stopped = { url: server.url, stop: () => server.stop(), apns };
  cleanups.push(() => {
    stopped.stop();
    apns.stop();
  });
  return stopped;
}

interface Harness {
  readonly link: RunningRelayLink;
  readonly audit: string[];
}

function harness(over: {
  url: string;
  timers?: RelayLinkTimers;
  holdMs?: number;
  timeoutMs?: number;
}): Harness {
  const configDir = store();
  pairPhone(configDir);
  const audit: string[] = [];
  const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
  cleanups.push(() => authority.stop());
  const link = startRelayLink({
    url: over.url,
    secret: SECRET,
    authority,
    sessionHost: dummyHost,
    limiter: new HandshakeLimiter({ burst: 100 }),
    dial: bunRelayDialer(),
    onAudit: (line) => audit.push(line),
    ...(over.timers ? { timers: over.timers } : {}),
    ...(over.holdMs !== undefined ? { pushHoldMs: over.holdMs } : {}),
    ...(over.timeoutMs !== undefined ? { pushTimeoutMs: over.timeoutMs } : {}),
  });
  cleanups.push(() => link.stop());
  return { link, audit };
}

/**
 * A REAL envelope for `token`: `sealPush` with fixed keys, so its shape (the key
 * id, the 43-char `enc`, one of the three ciphertext lengths) is the one the
 * relay accepts — a hand-built one would only prove the schema's regex.
 */
function envelope(token: string): PushPayload {
  const sealed = sealPush(
    new TextEncoder().encode(JSON.stringify({ token: token.slice(0, 4) })),
    new Uint8Array(32).fill(9),
    publicKeyOf(new Uint8Array(32).fill(2)),
    (length) => new Uint8Array(length).fill(3),
  );
  return {
    tp: {
      v: 1,
      k: sealed.keyId,
      e: encodeBase64Url(sealed.enc),
      c: encodeBase64Url(sealed.ciphertext),
    },
  };
}

const delivery = (token: string) => ({
  token,
  env: "sandbox" as const,
  collapse: "collapse-1",
  ttl: 3_600,
  payload: envelope(token),
});

async function waitFor(check: () => boolean, what: string, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await Bun.sleep(5);
  }
  if (!check()) throw new Error(`timed out waiting for ${what}`);
}

describe("relayLink.push against the real relay + a fake APNs", () => {
  test("`sent`, and Apple received exactly one request for that token", async () => {
    const r = relay({ push: true });
    const h = harness({ url: r.url });
    await waitFor(() => h.link.pushStatus() === "on", "the relay to announce push");
    const status = await h.link.push(delivery("a".repeat(64)));
    expect(status).toBe("sent");
    await waitFor(() => (r.apns?.seen.length ?? 0) === 1, "APNs to receive the push");
    expect(r.apns?.seen[0]?.path).toContain("a".repeat(8));
    // The envelope (and ONLY it) is what the relay templated into the payload.
    expect(r.apns?.seen[0]?.body).toContain('"tp"');
  });

  test("`gone` reaches the caller unchanged (the notifier's compare-and-delete)", async () => {
    const r = relay({ push: true });
    const h = harness({ url: r.url });
    await waitFor(() => h.link.pushStatus() === "on", "the relay to announce push");
    expect(await h.link.push(delivery(`${"b".repeat(60)}dead`))).toBe("gone");
  });

  test("two pushes answer OUT OF ORDER, each with its OWN status (the `n` correlation)", async () => {
    // Mutation: resolve the OLDEST pending entry (ignore `n`) → the slow 200's
    // status lands on the 410, and `gone` is never seen.
    const r = relay({ push: true });
    const h = harness({ url: r.url });
    await waitFor(() => h.link.pushStatus() === "on", "the relay to announce push");
    const slow = h.link.push(delivery(`${"c".repeat(60)}5eed`));
    const gone = h.link.push(delivery(`${"d".repeat(60)}dead`));
    expect(await gone).toBe("gone");
    expect(await slow).toBe("sent");
  });
});

describe("the `features` gate (C1: an older relay must never see a `push`)", () => {
  test('a relay without `"push"` sends no frame, answers `unavailable`, and stays up', async () => {
    // Mutation: send anyway → R2 closes the control socket (`control-unexpected`),
    // `isConnected` goes false, and this fails.
    const r = relay({ push: false });
    const h = harness({ url: r.url, holdMs: 50 });
    await waitFor(() => h.link.isConnected(), "the link to register");
    expect(h.link.pushStatus()).toBe("relay-no-push");
    expect(await h.link.push(delivery("a".repeat(64)))).toBe("unavailable");
    // The link is UNTOUCHED: no close, no backoff, no lost reachability.
    expect(h.link.isConnected()).toBe(true);
    expect(h.audit).toContain("relay-no-push");
    // And a SECOND push is refused the same way, without ever reaching the wire:
    // the gate is on the link's own `features`, checked before any frame.
    expect(await h.link.push(delivery("a".repeat(64)))).toBe("unavailable");
    expect(h.link.isConnected()).toBe(true);
  });

  test("a HELD push is refused, not flushed, when the reconnect announces no `push`", async () => {
    // The bug this pins (Review round 1, finding 1): a push decided while the
    // link is CONNECTING is held, and the hold survives a control blip by design
    // (F2). `ready` then flushes it — so a relay that re-registers WITHOUT
    // `"push"` used to get the frame anyway, and an older relay closes the
    // control socket on it (`control-unexpected`): the exact loss of
    // reachability C1 exists to prevent, on every push.
    //
    // The push must be decided BEFORE the link registers, because that is the
    // ONLY shape that reaches `flushHeldPushes` (Review round 2, finding 1): a
    // push against an already-registered no-push relay is refused by `push()`
    // itself and never enters the hold queue, so pushing after `isConnected()`
    // left this test green under the very mutation it names (A: flush without
    // re-reading `features`).
    let hellos = 0;
    const frames: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string };
          if (frame.t === "hello") {
            hellos++;
            // NEVER a `features` list: an older relay that carries no push at all.
            ws.send(JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION, id: ID }));
            // One drop, so the push below is HELD and then meets a fresh `ready`.
            if (hellos === 1) setTimeout(() => ws.close(), 150);
            return;
          }
          if (frame.t === "push") frames.push(String(raw));
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const h = harness({ url: `ws://127.0.0.1:${server.port}`, holdMs: 3_000 });
    // BEFORE the first `ready`: the link is CONNECTING, so the frame is held
    // (this is the hold queue mutation A unguards). The hold outlives the blip.
    const pending = h.link.push(delivery("a".repeat(64)));
    // The reconnect lands (a second `hello`), and the hold's deadline is still
    // ahead: whatever happens to the frame happens through `flushHeldPushes`.
    await waitFor(() => hellos >= 2, "the relay to be re-registered");
    await Bun.sleep(200);
    // The frame is what must not exist. (Asserted BEFORE the promise, so a
    // mutation fails here — on the property — instead of on a test timeout.)
    expect(frames).toEqual([]);
    expect(h.link.isConnected()).toBe(true);
    const race = await Promise.race([pending, Bun.sleep(1_000).then(() => "still-held" as const)]);
    expect(race).toBe("unavailable");
  });

  test("a registered no-push relay refuses a push AT ONCE, never by holding it out", async () => {
    // The other half of the gate (Review round 2, finding 1; mutation B: `push()`
    // holds instead of refusing). A hold here would resolve only when
    // `pushHoldMs` expires, as `push-dropped link-down` — the wrong audit word,
    // and every device waits out the whole hold. The 30 s hold makes that
    // unmistakable: the answer must arrive long before it.
    let hellos = 0;
    const frames: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string };
          if (frame.t === "hello") {
            hellos++;
            ws.send(JSON.stringify({ t: "ready", v: RELAY_PROTOCOL_VERSION, id: ID }));
            return;
          }
          if (frame.t === "push") frames.push(String(raw));
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const h = harness({ url: `ws://127.0.0.1:${server.port}`, holdMs: 30_000 });
    await waitFor(() => hellos >= 1, "the link to register");
    const started = Date.now();
    const race = await Promise.race([
      h.link.push(delivery("a".repeat(64))),
      Bun.sleep(2_000).then(() => "waited-out" as const),
    ]);
    expect(race).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(frames).toEqual([]);
    // And it is NOT the drop's own word: nothing timed out.
    expect(h.audit).not.toContain("push-dropped link-down");
  });
});

describe("a push decided during a reconnect is held, then dropped (F2)", () => {
  test("held while connecting, delivered on `ready`", async () => {
    const r = relay({ push: true });
    // Hold it BEFORE the link registers: the frame waits, and lands on `ready`.
    const h = harness({ url: r.url, holdMs: 5_000 });
    const pending = h.link.push(delivery("a".repeat(64)));
    await waitFor(() => h.link.pushStatus() === "on", "the relay to announce push");
    expect(await pending).toBe("sent");
  });

  test("dropped after the hold, with ONE audit line, and the caller learns `unavailable`", async () => {
    // A URL the link cannot reach at all: the push is held and then dropped.
    const configDir = store();
    pairPhone(configDir);
    const audit: string[] = [];
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: "ws://127.0.0.1:1",
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      onAudit: (line) => audit.push(line),
      pushHoldMs: 40,
    });
    cleanups.push(() => link.stop());
    expect(await link.push(delivery("a".repeat(64)))).toBe("unavailable");
    expect(audit).toContain("push-dropped link-down");
  });
});

describe("stop() settles everything still waiting", () => {
  test("a control teardown settles a pending push `unavailable` (nothing is left dangling)", async () => {
    // A fake relay that accepts the `push` and NEVER answers it, then drops the
    // control socket. Mutation: `dropControl` without `dropPendingPushes` → the
    // caller waits out the whole timeout (5 s here), and this fails on the race.
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string };
          if (frame.t === "hello") {
            ws.send(
              JSON.stringify({
                t: "ready",
                v: RELAY_PROTOCOL_VERSION,
                id: ID,
                features: ["push"],
              }),
            );
            return;
          }
          if (frame.t === "push") {
            // No answer, and the socket goes: the entry must settle on its own.
            ws.close();
          }
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const configDir = store();
    pairPhone(configDir);
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: `ws://127.0.0.1:${server.port}`,
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      pushTimeoutMs: 5_000,
    });
    cleanups.push(() => link.stop());
    await waitFor(() => link.pushStatus() === "on", "the fake relay to announce push");
    const race = await Promise.race([
      link.push(delivery("a".repeat(64))),
      Bun.sleep(1_000).then(() => "timed-out" as const),
    ]);
    expect(race).toBe("unavailable");
  });

  test("a held push resolves `unavailable`; no promise is left dangling", async () => {
    const configDir = store();
    pairPhone(configDir);
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: "ws://127.0.0.1:1",
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
      pushHoldMs: 60_000,
    });
    const pending = link.push(delivery("a".repeat(64)));
    link.stop();
    expect(await pending).toBe("unavailable");
    // A push after stop is refused at once, never queued.
    expect(await link.push(delivery("a".repeat(64)))).toBe("unavailable");
  });
});

describe("a phone that goes away DETACHES its session (the relay path, F17)", () => {
  test("closing the relay leg drops the connection, so the session counts 0 attachments", async () => {
    // The bug this pins: `acceptDevice`'s `release` (what the relay leg calls on
    // its socket close) unregistered the authority handle but never closed the
    // `Connection`, so its session kept counting an attachment that was gone.
    // A phone locked mid-grace then still looked "attached" and was never pushed
    // to — F17 inverted, on the ONLY path push uses. Mutation: drop
    // `built?.connection.close()` from `teardown` → still 1, and this fails.
    const configDir = store();
    pairPhone(configDir);
    const identity = readIdentity(configDir);
    if (!identity.ok) throw new Error(identity.reason);
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => {
        // A real agent: `session/open` builds one (the dummy host would refuse).
        const permissions = new PermissionBroker();
        const agent = new Agent({
          model: {
            id: "noop",
            async *stream() {
              yield { type: "done" as const };
            },
          },
          tools: new ToolRegistry(),
          env: {
            id: "rec",
            async exec() {
              return { stdout: "", stderr: "", exitCode: 0 };
            },
            async readFile() {
              return "";
            },
            async writeFile() {},
          },
          requestPermission: (req: PermissionRequest, opts): Promise<PermissionResponse> =>
            permissions.request(req, opts),
        });
        return { agent, permissions };
      },
    });
    const relay = startRelay({ host: "127.0.0.1", port: 0, sweepMs: 10, onLog: () => {} });
    cleanups.push(() => relay.stop());
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: relay.url,
      secret: SECRET,
      authority,
      sessionHost: host,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
    });
    cleanups.push(() => link.stop());
    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        if (link.isConnected()) {
          clearInterval(poll);
          resolve();
        }
      }, 10);
    });
    const phone = await dialPhone(link.address);
    cleanups.push(() => phone.ws.close());
    const secure = await noiseInitiator(phone.channel, {
      staticKey: key(2),
      remoteStatic: identity.identity.publicKey,
      random: systemRandom,
    });
    const peer = new RpcPeer(secure, {
      onRequest: async () => ({}),
      onNotification: () => {},
    });
    await peer.request("initialize", {
      protocolVersion: 24,
      clientCapabilities: {},
      clientInfo: { name: "phone", version: "0" },
    });
    await peer.request("session/open", { sessionId: "S", create: true });
    const hosted = host.get("S");
    expect(hosted?.attachedCount).toBe(1);
    // The foreground gate closing: the phone's socket goes away.
    phone.ws.close();
    await waitFor(() => host.get("S")?.attachedCount === 0, "the session to drop the attachment");
    expect(authority.liveCount()).toBe(0);
    peer.close();
  });
});

/** A phone's `ByteCarrier` over a real WebSocket at the relay address. */
function dialPhone(url: string): Promise<{ channel: ByteCarrier; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let onMessage: ((d: CarrierFrame) => void) | undefined;
    ws.binaryType = "arraybuffer";
    let onClose: (() => void) | undefined;
    ws.addEventListener("message", (e) => {
      const frame = carrierFrameOf(e.data);
      if (frame !== null) onMessage?.(frame);
    });
    ws.addEventListener("close", () => onClose?.());
    ws.addEventListener("error", () => reject(new Error(`phone socket error ${url}`)));
    ws.addEventListener("open", () =>
      resolve({
        ws,
        channel: {
          send: (d) => ws.send(d),
          close: () => ws.close(),
          setOnMessage: (h) => {
            onMessage = h;
          },
          setOnClose: (h) => {
            onClose = h;
          },
        },
      }),
    );
  });
}

describe("the relay's own `push-result` vocabulary is not trusted blindly", () => {
  test("an unknown status resolves `unavailable` rather than closing the link", async () => {
    // A fake relay that answers a status this build does not know: a newer relay
    // must not cost the daemon its reachability (the `error.code` rule).
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        message(ws, raw) {
          const frame = JSON.parse(String(raw)) as { t?: string; n?: number };
          if (frame.t === "hello") {
            ws.send(
              JSON.stringify({
                t: "ready",
                v: RELAY_PROTOCOL_VERSION,
                id: ID,
                features: ["push"],
              }),
            );
            return;
          }
          if (frame.t === "push") {
            ws.send(JSON.stringify({ t: "push-result", n: frame.n, status: "teleported" }));
          }
        },
      },
    });
    cleanups.push(() => server.stop(true));
    const configDir = store();
    pairPhone(configDir);
    const authority = new DeviceAuthority({ project: TEST_PROJECT, configDir, pollIntervalMs: 10 });
    cleanups.push(() => authority.stop());
    const link = startRelayLink({
      url: `ws://127.0.0.1:${server.port}`,
      secret: SECRET,
      authority,
      sessionHost: dummyHost,
      limiter: new HandshakeLimiter({ burst: 100 }),
      dial: bunRelayDialer(),
    });
    cleanups.push(() => link.stop());
    await waitFor(() => link.pushStatus() === "on", "the fake relay to announce push");
    expect(await link.push(delivery("a".repeat(64)))).toBe("unavailable");
    expect(link.isConnected()).toBe(true);
  });
});

// --- the link's LIVE ACTIVITY half (docs/feat/mobile-live-activity.md L8) ----
/**
 * `relayLink.liveActivity` is the SAME machinery as `push` (one `n` correlation,
 * one answer vocabulary, one hold while reconnecting), with one difference that
 * is the whole point: a relay that has not announced `"liveactivity"` must get NO
 * frame, because an older relay closes the control socket on an unknown one and
 * that costs every phone its reachability (F4/C1).
 *
 * This block pins the gate and the topic/type Apple requires. Mutation: ignore
 * `features` in `liveActivity()` → the R2 relay closes the socket, the link goes
 * down, and the follow-up `liveActivityStatus()` assertion fails.
 */
describe("relayLink.liveActivity against the real relay + a fake APNs", () => {
  const laDelivery = (token: string) => ({
    token,
    env: "sandbox" as const,
    priority: 10 as const,
    la: {
      event: "start" as const,
      timestamp: 1_700_000_000,
      staleDate: 1_700_000_900,
      contentState: { v: 1 as const, e: "A".repeat(43), c: "B".repeat(704) },
      attributes: { v: 1 as const, k: "tzHqlSe8ME5A", slot: "00112233445566778899aabb" },
    },
  });

  test("`sent`, and Apple received it as an ACTIVITY (push type + topic suffix)", async () => {
    const r = relay({ push: true });
    const h = harness({ url: r.url });
    await waitFor(() => h.link.liveActivityStatus() === "on", "the relay to announce liveactivity");
    expect(await h.link.liveActivity(laDelivery("a".repeat(64)))).toBe("sent");
    await waitFor(() => (r.apns?.seen.length ?? 0) === 1, "APNs to receive the activity");
    const seen = r.apns?.seen[0];
    const body = JSON.parse(seen?.body ?? "{}") as {
      aps: Record<string, unknown> & { event?: string; alert?: unknown };
    };
    expect(body.aps.event).toBe("start");
    expect(body.aps["attributes-type"]).toBe("TentacleActivityAttributes");
    // An activity is not a banner: no `tp`, and an alert only on a start.
    expect(body).not.toHaveProperty("tp");
    expect(body.aps.alert).toBeDefined();
  });

  test("a relay WITHOUT the feature gets no frame, and the status says `relay-no-la` (F4)", async () => {
    // A relay with no APNs key announces no features at all.
    const r = relay({ push: false });
    const h = harness({ url: r.url });
    await waitFor(() => h.link.liveActivityStatus() === "relay-no-la", "the feature's absence");
    // Refused WITHOUT a frame: the answer is `unavailable`, and the socket lives.
    expect(await h.link.liveActivity(laDelivery("b".repeat(64)))).toBe("unavailable");
    // One audit line said why, once per start (never one per push).
    expect(h.audit.filter((line) => line === "relay-no-la")).toHaveLength(1);
    // The link is still up: a refusal is never a close. (Mutation: ignore the gate
    // in `liveActivity()` → an unknown frame reaches the R2 relay, which closes
    // the control socket, so this status check times out or flips.)
    await Bun.sleep(30);
    expect(h.link.liveActivityStatus()).toBe("relay-no-la");
    expect(h.link.isConnected()).toBe(true);
  });

  test("with no feature, NOTHING is sent to Apple — the frame never exists (F4)", async () => {
    // The gate's real property, stated directly: a relay that did not announce
    // `liveactivity` must not cause a single APNs request. Mutation: drop the
    // `features.includes("liveactivity")` check in `liveActivity()` → the frame is
    // sent anyway, the relay (which does have an APNs key here, but announced
    // only `"push"` because LA was disabled) delivers it, and `seen` is non-empty.
    const apns = fakeApns();
    cleanups.push(apns.stop);
    const client: ApnsClient = createApnsClient({
      topic: "so.tentacle.app",
      jwtSource: fakeJwt,
      origins: { sandbox: apns.origin, production: apns.origin },
    });
    // A relay with an APNs key that announces ONLY `"push"`: exactly what a
    // relay deployed before task 18's D4a says. `features` is the deploy knob a
    // two-step rollout uses, so this is the real "old relay" case (F4), not a
    // test-only backdoor.
    const server = startRelay({
      host: "127.0.0.1",
      port: 0,
      sweepMs: 10,
      onLog: () => {},
      apns: { client, jwtSource: fakeJwt, topic: "so.tentacle.app" },
      features: ["push"],
    });
    cleanups.push(() => {
      void server.stop();
      client.close();
    });
    const h = harness({ url: server.url });
    await waitFor(() => h.link.isConnected(), "the link");
    expect(await h.link.liveActivity(laDelivery("c".repeat(64)))).toBe("unavailable");
    await Bun.sleep(60);
    expect(apns.seen).toHaveLength(0);
  });

  test("`bindLiveActivityReady` fires on a `ready` that carries the feature (F3's resend)", async () => {
    const r = relay({ push: true });
    // Bind BEFORE the link can have completed `ready`: the harness returns as
    // soon as `startRelayLink` is called, and the relay's answer arrives on a
    // later tick, so this is the first ready and nothing else.
    const h = harness({ url: r.url });
    let readies = 0;
    h.link.bindLiveActivityReady(() => {
      readies += 1;
    });
    await waitFor(() => h.link.liveActivityStatus() === "on", "the first ready");
    // The hook is what a `serve` wires to `notifier.resendAll` (L8). Mutation:
    // drop the `onLaReady?.()` call in the `ready` arm → this stays 0.
    expect(readies).toBe(1);
  });
});
