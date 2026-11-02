/**
 * The client's secure-channel factory decorator (docs/feat/e2e-channel.md):
 * the REAL `RemoteClient` ↔ REAL `Connection` over Noise, with no change to
 * either — a whole turn with frames over 64 KiB, a drop that redials with a
 * fresh handshake, an authenticated deny that stops the link, a transient
 * failure that retries, a concurrent request during a long prompt, a clean
 * `VersionMismatch` inside the channel — and the error mapping.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { type ModelProvider, PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import {
  DomainErrorCode,
  type DuplexChannel,
  RpcError,
  RpcPeer,
  createChannelPair,
} from "@tentacle/transport";
import {
  NoiseError,
  type NoiseErrorKind,
  noiseResponder,
  publicKeyOf,
  systemRandom,
} from "@tentacle/transport/noise";
import { ChannelError, type LinkStatus, terminalReason } from "../src/link-machine.ts";
import { RemoteClient } from "../src/remote-client.ts";
import { channelErrorFromNoise, secureChannelFactory } from "../src/secure-channel.ts";
import { GatedModel, done, t, until } from "./support/fakes.ts";

const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const DAEMON = key(1);
const DAEMON_PUB = publicKeyOf(DAEMON);
const DEVICE = key(2);
const DEVICE_PUB = publicKeyOf(DEVICE);
const STRANGER = key(3);
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** A real daemon behind a Noise responder; `Connection` is built only on a confirmed channel. */
function daemon(model: ModelProvider) {
  const host = new SessionHost({
    defaultCwd: "/tmp/secure-channel",
    createAgent: () => {
      const permissions = new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env: {
          id: "x",
          exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: async () => "",
          writeFile: async () => {},
        },
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });
  const raws: DuplexChannel[] = [];
  const ctl = { allow: true, wrongKey: 0, dials: 0, authorized: 0, maxInbound: 0 };
  const dial = async (): Promise<DuplexChannel> => {
    ctl.dials += 1;
    const [d, c] = createChannelPair();
    raws.push(d);
    let staticKey = DAEMON;
    if (ctl.wrongKey > 0) {
      ctl.wrongKey -= 1;
      staticKey = STRANGER; // the client's pinned key is not this daemon's
    }
    noiseResponder(d, {
      staticKey,
      random: systemRandom,
      authorize: (k) => {
        ctl.authorized += 1;
        return ctl.allow && same(k, DEVICE_PUB);
      },
    }).then(
      (secure) => new Connection(secure, host),
      () => {},
    );
    // What the client receives: measure the raw text frames.
    return {
      send: (data) => c.send(data),
      close: () => c.close(),
      setOnMessage: (h) =>
        c.setOnMessage((text) => {
          ctl.maxInbound = Math.max(ctl.maxInbound, text.length);
          h(text);
        }),
      setOnClose: (h) => c.setOnClose(h),
    };
  };
  return { host, raws, ctl, dial };
}

const options = { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: systemRandom };

async function client(model: ModelProvider) {
  const d = daemon(model);
  const factory = secureChannelFactory(d.dial, options);
  const c = new RemoteClient(await factory(), new PermissionBroker(), undefined, {
    channelFactory: factory,
    random: () => 0,
  });
  const statuses: LinkStatus[] = [];
  c.onLinkStatus((s) => statuses.push(s));
  await c.initialize();
  return { d, c, statuses };
}

async function turn(session: ReturnType<RemoteClient["newSession"]>, text: string) {
  let chars = 0;
  const kinds = new Set<string>();
  for await (const e of session.send(text) as AsyncIterable<{
    type?: string;
    kind?: string;
    delta?: string;
  }>) {
    kinds.add(String(e.kind ?? e.type));
    if (typeof e.delta === "string") chars += e.delta.length;
  }
  return { chars, kinds };
}

describe("RemoteClient ↔ Connection over Noise", () => {
  test("a whole turn, with an event frame over 64 KiB split into Noise chunks", async () => {
    const big = "x".repeat(150_000);
    const { d, c } = await client(new GatedModel([[t(big), done]]));
    const session = c.newSession();
    const r = await turn(session, "hi");
    expect(r.chars).toBe(big.length);
    expect(r.kinds.has("turn_end")).toBe(true);
    // A maximum-size chunk crossed the raw channel (base64 of 65 535 bytes + tag).
    expect(d.ctl.maxInbound).toBe(3 + 87_380);
    expect(d.ctl.authorized).toBe(1);
    c.close();
  });

  test("a dropped link redials with a fresh handshake and the session resumes", async () => {
    const { d, c, statuses } = await client(
      new GatedModel([
        [t("one"), done],
        [t("two"), done],
      ]),
    );
    const session = c.newSession();
    expect((await turn(session, "first")).chars).toBe(3);
    d.raws.at(-1)?.close();
    await until(() => d.ctl.authorized === 2 && statuses.at(-1)?.state === "up");
    expect(statuses.some((s) => s.state === "reconnecting")).toBe(true);
    expect((await turn(session, "second")).chars).toBe(3);
    c.close();
  });

  test("an authenticated deny stops the link: `stopped`, no further dial", async () => {
    const { d, c, statuses } = await client(new GatedModel([]));
    c.newSession();
    d.ctl.allow = false;
    d.raws.at(-1)?.close();
    await until(() => statuses.at(-1)?.state === "stopped");
    const last = statuses.at(-1);
    expect(last?.state === "stopped" && last.reason).toContain("rejected the credentials");
    const dials = d.ctl.dials;
    await Bun.sleep(50);
    expect(d.ctl.dials).toBe(dials);
    c.close();
  });

  test("a closed handshake (here: the wrong daemon key) is transient: it retries, then comes up", async () => {
    const { d, c, statuses } = await client(new GatedModel([[t("ok"), done]]));
    const session = c.newSession();
    d.ctl.wrongKey = 2;
    d.raws.at(-1)?.close();
    await until(() => statuses.at(-1)?.state === "up" && d.ctl.dials >= 4);
    const errors = statuses.flatMap((s) =>
      s.state === "reconnecting" && s.error ? [s.error] : [],
    );
    expect(errors.length).toBe(2);
    for (const e of errors) expect(e).toContain("pinned daemon key");
    expect((await turn(session, "go")).chars).toBe(2);
    c.close();
  });

  test("a long session/prompt does not block a session/enqueue over the channel", async () => {
    const model = new GatedModel([[t("a"), { kind: "gate" }, t("b"), done]]);
    const { c } = await client(model);
    const session = c.newSession();
    const running = turn(session, "go");
    await until(() => model.waiting);
    const enqueued = await Promise.race([
      session.enqueue("steer", "s1").then(() => "accepted"),
      Bun.sleep(2000).then(() => "blocked"),
    ]);
    expect(enqueued).toBe("accepted");
    model.open();
    await running;
    c.close();
  });

  test("an initialize with another protocol version gets a clean VersionMismatch inside the channel", async () => {
    const d = daemon(new GatedModel([]));
    const secure = await secureChannelFactory(d.dial, options)();
    const peer = new RpcPeer(secure, { onRequest: () => null, onNotification: () => {} });
    const error = await peer
      .request("initialize", {
        protocolVersion: PROTOCOL_VERSION + 1,
        clientCapabilities: { streaming: true },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(RpcError);
    expect((error as RpcError).code).toBe(DomainErrorCode.VersionMismatch);
    peer.close();
  });
});

describe("the error mapping", () => {
  const table: [NoiseErrorKind, ChannelError["kind"]][] = [
    ["denied", "unauthorized"],
    ["timeout", "unreachable"],
    ["closed", "unreachable"],
    ["handshake-failed", "rejected"],
    ["bad-frame", "rejected"],
  ];
  for (const [noise, channel] of table) {
    test(`${noise} → ${channel}`, () => {
      const mapped = channelErrorFromNoise(new NoiseError(noise, "why"));
      expect(mapped).toBeInstanceOf(ChannelError);
      expect(mapped.kind).toBe(channel);
      expect(mapped.message).toContain("why");
      // Only the authenticated deny is terminal: an on-path party cannot stop the client for good.
      expect(terminalReason(mapped) !== null).toBe(noise === "denied");
    });
  }

  test("the factory maps a handshake failure and passes a dial failure through untouched", async () => {
    const denied = secureChannelFactory(async () => {
      const [a, b] = createChannelPair();
      noiseResponder(b, { staticKey: DAEMON, random: systemRandom, authorize: () => false }).catch(
        () => {},
      );
      return a;
    }, options);
    const e1 = await denied().then(
      () => null,
      (e: unknown) => e,
    );
    expect(e1).toBeInstanceOf(ChannelError);
    expect((e1 as ChannelError).kind).toBe("unauthorized");

    const gone = new ChannelError("gone", "pod deleted");
    const e2 = await secureChannelFactory(() => Promise.reject(gone), options)().then(
      () => null,
      (e: unknown) => e,
    );
    expect(e2).toBe(gone);
  });
});
