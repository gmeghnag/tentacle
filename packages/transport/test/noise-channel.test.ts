/**
 * The Noise `DuplexChannel` decorator (docs/feat/e2e-channel.md): the IK
 * handshake's three flights, the authenticated deny, and every channel row of
 * the plan's Failure modes — each failure closes, reports and delivers nothing
 * unauthenticated. All in memory (`createByteCarrierPair`, injected timers, fixed
 * keys) except one real loopback WebSocket. E2E v2: binary frames only, flights
 * 1–2 versioned (docs/feat/noise-binary-carrier.md).
 */
import { describe, expect, test } from "bun:test";
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { type ByteCarrier, type CarrierFrame, createByteCarrierPair } from "../src/channel.ts";
import {
  type AuthorizeVerdict,
  E2E_CHANNEL_VERSION,
  type HandshakeTimer,
  PROLOGUE,
  type SecureChannel,
  generateStaticKeypair,
  noiseInitiator,
  noiseResponder,
  publicKeyOf,
} from "../src/noise-channel.ts";
import { withVersion } from "../src/noise-frame.ts";
import {
  CipherState,
  IkInitiator,
  IkResponder,
  MAX_NOISE_MESSAGE,
  NoiseError,
} from "../src/noise.ts";

/** A test end may also inject a TEXT frame (a v1 peer, garbage): what a socket can deliver. */
interface RawEnd extends Omit<ByteCarrier, "send"> {
  send(frame: CarrierFrame): void;
}
/** The in-memory carrier pair delivers whatever is sent, so a test end can send text too. */
const pair = (): [RawEnd, RawEnd] => createByteCarrierPair() as unknown as [RawEnd, RawEnd];
/** A v2 handshake flight: `[2] ‖ message`. */
const v2 = (message: Uint8Array): Uint8Array => withVersion(2, message);
const bytesOf = (frame: CarrierFrame | undefined): Uint8Array => {
  if (!(frame instanceof Uint8Array))
    throw new Error(`expected a binary frame, got ${typeof frame}`);
  return frame;
};

const key = (n: number): Uint8Array => new Uint8Array(32).fill(n);
const DAEMON = key(1);
const DAEMON_PUB = publicKeyOf(DAEMON);
const DEVICE = key(2);
const DEVICE_PUB = publicKeyOf(DEVICE);
const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Deterministic, distinct per call: never reuse an ephemeral across handshakes. */
function rng(seed = 100): (n: number) => Uint8Array {
  let next = seed;
  return (n) => new Uint8Array(n).fill(next++ & 0xff);
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));
async function ticks(n = 5): Promise<void> {
  for (let i = 0; i < n; i++) await tick();
}

function fakeTimer(): HandshakeTimer & { fire(): void; readonly size: number } {
  const pending = new Map<number, () => void>();
  let id = 0;
  return {
    setTimeout(fn) {
      pending.set(++id, fn);
      return id;
    },
    clearTimeout(handle) {
      pending.delete(handle as number);
    },
    fire() {
      for (const [k, fn] of [...pending]) {
        pending.delete(k);
        fn();
      }
    },
    get size() {
      return pending.size;
    },
  };
}

interface Tracked<T> {
  state: "pending" | "resolved" | "rejected";
  value?: T;
  error?: unknown;
}
function track<T>(p: Promise<T>): Tracked<T> {
  const s: Tracked<T> = { state: "pending" };
  p.then(
    (v) => {
      s.state = "resolved";
      s.value = v;
    },
    (e: unknown) => {
      s.state = "rejected";
      s.error = e;
    },
  );
  return s;
}
const kindOf = (t: Tracked<unknown>): string | undefined =>
  t.error instanceof NoiseError ? t.error.kind : undefined;

/** A raw end that counts what it sends and whether it was closed. */
function counted(raw: RawEnd) {
  let sent = 0;
  let closed = false;
  let failSends = false;
  const ch: RawEnd = {
    send(d) {
      if (failSends) throw new Error("socket write failed");
      sent += 1;
      raw.send(d);
    },
    close() {
      closed = true;
      raw.close();
    },
    setOnMessage: (h) => raw.setOnMessage(h),
    setOnClose: (h) => raw.setOnClose(h),
  };
  return {
    ch,
    sent: () => sent,
    closed: () => closed,
    breakSends: () => {
      failSends = true;
    },
  };
}

type Hook = (
  frame: CarrierFrame,
  forward: (t: CarrierFrame) => void,
  back: (t: CarrierFrame) => void,
) => void;

/** client ↔ relay ↔ daemon: the relay sees (and may rewrite) every frame. */
function relayed() {
  const [client, relayC] = pair();
  const [relayD, daemon] = pair();
  const ctl: { up?: Hook; down?: Hook } = {};
  const up: CarrierFrame[] = [];
  const down: CarrierFrame[] = [];
  const pass: Hook = (t, f) => f(t);
  relayC.setOnMessage((t) => {
    up.push(t);
    (ctl.up ?? pass)(
      t,
      (x) => relayD.send(x),
      (x) => relayC.send(x),
    );
  });
  relayD.setOnMessage((t) => {
    down.push(t);
    (ctl.down ?? pass)(
      t,
      (x) => relayC.send(x),
      (x) => relayD.send(x),
    );
  });
  relayC.setOnClose(() => relayD.close());
  relayD.setOnClose(() => relayC.close());
  return { client, daemon, ctl, up, down, cut: () => relayC.close() };
}

function listen(ch: SecureChannel) {
  const got: string[] = [];
  let closes = 0;
  ch.setOnMessage((m) => got.push(m));
  ch.setOnClose(() => {
    closes += 1;
  });
  return { got, closes: () => closes };
}

async function connected(opts: { daemonMax?: number; seed?: number } = {}) {
  const r = relayed();
  const cViol: NoiseError[] = [];
  const dViol: NoiseError[] = [];
  const seed = opts.seed ?? 10;
  const [c, d] = await Promise.all([
    noiseInitiator(r.client, {
      staticKey: DEVICE,
      remoteStatic: DAEMON_PUB,
      random: rng(seed),
      onViolation: (e) => cViol.push(e),
    }),
    noiseResponder(r.daemon, {
      staticKey: DAEMON,
      authorize: (k) => same(k, DEVICE_PUB),
      random: rng(seed + 40),
      onViolation: (e) => dViol.push(e),
      ...(opts.daemonMax !== undefined ? { maxMessageBytes: opts.daemonMax } : {}),
    }),
  ]);
  return { r, c, d, cIn: listen(c), dIn: listen(d), cViol, dViol };
}

/** Rewrite one byte of a binary frame (a transport frame is the bare Noise message). */
function flip(frame: CarrierFrame, at: number): Uint8Array {
  const m = Uint8Array.from(bytesOf(frame));
  const i = at < 0 ? m.length + at : at;
  m[i] = (m[i] ?? 0) ^ 0x01;
  return m;
}

describe("handshake", () => {
  test("three flights, both ends learn the other's static key, frames flow both ways in order", async () => {
    const { r, c, d, cIn, dIn, cViol, dViol } = await connected();
    expect(same(c.remoteStatic, DAEMON_PUB)).toBe(true);
    expect(same(d.remoteStatic, DEVICE_PUB)).toBe(true);
    // msg1, confirm up; msg2 down — nothing else before data.
    expect(r.up.length).toBe(2);
    expect(r.down.length).toBe(1);
    const big = `${"€".repeat(70_000)}end`;
    c.send("one");
    c.send("");
    c.send(big);
    d.send("back");
    await ticks();
    expect(dIn.got).toEqual(["one", "", big]);
    expect(cIn.got).toEqual(["back"]);
    expect(cViol).toEqual([]);
    expect(dViol).toEqual([]);
    // T-N2: the e2e channel's own version, bound in the prologue.
    expect(E2E_CHANNEL_VERSION).toBe(2);
    expect(new TextDecoder().decode(PROLOGUE)).toBe("tentacle-e2e/2");
  });

  test("T-N1: every raw frame is binary, ≤ the Noise maximum; only flights 1–2 carry the version byte", async () => {
    const { r, c, d, cIn, dIn } = await connected();
    const sizes = [0, 65_518, 65_519, 200_000];
    // Multi-byte UTF-8 straddling the 65 518-byte chunk boundary.
    const payloads = sizes.map((n, i) =>
      n === 200_000 ? "é€😀".repeat(25_000) : "x".repeat(n) + String(i),
    );
    for (const p of payloads) c.send(p);
    for (const p of payloads) d.send(p);
    await ticks(10);
    expect(dIn.got).toEqual(payloads);
    expect(cIn.got).toEqual(payloads);
    const all = [...r.up, ...r.down];
    for (const f of all) {
      expect(f instanceof Uint8Array).toBe(true);
    }
    const [msg1, confirm, ...upData] = r.up.map(bytesOf);
    const [msg2, ...downData] = r.down.map(bytesOf);
    if (!msg1 || !confirm || !msg2) throw new Error("missing handshake flights");
    // Flight 1: [2] ‖ IK message 1 (96 B, empty payload); flight 2: [2] ‖ message 2 (49 B).
    expect(msg1.length).toBe(97);
    expect(msg1[0]).toBe(0x02);
    expect(msg2.length).toBe(50);
    expect(msg2[0]).toBe(0x02);
    // The confirm and transport messages are the raw Noise message: tag + type byte, no header.
    expect(confirm.length).toBe(17);
    for (const f of [...upData, ...downData]) {
      expect(f.length).toBeLessThanOrEqual(MAX_NOISE_MESSAGE);
    }
    expect(Math.max(...upData.map((f) => f.length))).toBe(MAX_NOISE_MESSAGE);
  });

  test("T-N3: a text frame after open is a bad-frame violation: closed, nothing delivered", async () => {
    const { r, c, dIn, dViol } = await connected();
    r.ctl.up = (_t, f) => f("t1:AAAA");
    c.send("hello");
    await ticks();
    expect(dIn.got).toEqual([]);
    expect(dViol.map((e) => e.kind)).toEqual(["bad-frame"]);
    expect(dViol[0]?.message).toContain("text frame");
    expect(dIn.closes()).toBe(1);
  });

  test("T-N4: an over-cap binary frame after open is refused before any decrypt", async () => {
    const { r, c, dIn, dViol } = await connected();
    const decrypt = CipherState.prototype.decryptWithAd;
    let decrypts = 0;
    CipherState.prototype.decryptWithAd = function (this: CipherState, ad, ct) {
      decrypts += 1;
      return decrypt.call(this, ad, ct);
    };
    try {
      r.ctl.up = (_t, f) => f(new Uint8Array(MAX_NOISE_MESSAGE + 1));
      c.send("hello");
      await ticks();
    } finally {
      CipherState.prototype.decryptWithAd = decrypt;
    }
    expect(decrypts).toBe(0);
    expect(dIn.got).toEqual([]);
    expect(dViol.map((e) => e.kind)).toEqual(["bad-frame"]);
    expect(dViol[0]?.message).toContain("too long");
  });

  test("F11: an empty binary frame after open is bad-frame", async () => {
    const { r, c, dIn, dViol } = await connected();
    r.ctl.up = (_t, f) => f(new Uint8Array(0));
    c.send("hello");
    await ticks();
    expect(dIn.got).toEqual([]);
    expect(dViol.map((e) => e.kind)).toEqual(["bad-frame"]);
  });
});

describe("version skew (E2E v2)", () => {
  function message1(): Uint8Array {
    const hs = new IkInitiator({
      staticKey: DEVICE,
      ephemeralKey: key(9),
      remoteStatic: DAEMON_PUB,
      prologue: PROLOGUE,
    });
    return hs.writeMessage1(new Uint8Array(0));
  }

  function responderUnderTest() {
    const [attacker, b] = pair();
    const replies: CarrierFrame[] = [];
    let attackerClosed = false;
    attacker.setOnMessage((f) => replies.push(f));
    attacker.setOnClose(() => {
      attackerClosed = true;
    });
    let authorized = 0;
    const viol: NoiseError[] = [];
    const timer = fakeTimer();
    const res = track(
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: () => {
          authorized += 1;
          return true;
        },
        random: rng(60),
        timer,
        onViolation: (e) => viol.push(e),
      }),
    );
    return {
      attacker,
      replies,
      res,
      viol,
      timer,
      authorized: () => authorized,
      attackerClosed: () => attackerClosed,
    };
  }

  for (const v of [1, 3]) {
    test(`T-V1: responder, message 1 with header 0x0${v} → one refusal [2], authorize never runs`, async () => {
      const t = responderUnderTest();
      t.attacker.send(withVersion(v, message1()));
      await ticks();
      expect(t.authorized()).toBe(0);
      expect(t.replies.map((f) => Array.from(bytesOf(f)))).toEqual([[2]]);
      // Reported at once (the audit line); rejected when the initiator closes on reading it.
      expect(t.viol.map((e) => [e.kind, e.remoteVersion])).toEqual([["version-mismatch", v]]);
      expect(t.res.state).toBe("pending");
      t.attacker.close();
      await ticks();
      expect(t.res.state).toBe("rejected");
      expect(kindOf(t.res)).toBe("version-mismatch");
      expect((t.res.error as NoiseError).remoteVersion).toBe(v);
      expect(t.viol.length).toBe(1);
    });
  }

  test("T-V1: a refusing responder closes on its own timer if the initiator never does", async () => {
    const t = responderUnderTest();
    t.attacker.send(withVersion(3, message1()));
    await ticks();
    t.timer.fire();
    await ticks();
    expect(kindOf(t.res)).toBe("version-mismatch");
    expect(t.attackerClosed()).toBe(true);
    expect(t.viol.map((e) => e.kind)).toEqual(["version-mismatch"]);
  });

  test("T-V1: a v1 `t1:` text message 1 → version-mismatch 1, nothing sent, closed", async () => {
    const t = responderUnderTest();
    t.attacker.send("t1:AAAA");
    await ticks();
    expect(t.replies).toEqual([]);
    expect(t.authorized()).toBe(0);
    expect(kindOf(t.res)).toBe("version-mismatch");
    expect((t.res.error as NoiseError).remoteVersion).toBe(1);
    expect(t.viol.map((e) => e.kind)).toEqual(["version-mismatch"]);
    expect(t.attackerClosed()).toBe(true);
  });

  test("T-V1: a plaintext JSON text frame → bad-frame, nothing sent", async () => {
    const t = responderUnderTest();
    t.attacker.send('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    await ticks();
    expect(t.replies).toEqual([]);
    expect(kindOf(t.res)).toBe("bad-frame");
  });

  function initiatorAgainst(answer: CarrierFrame) {
    const [a, daemon] = pair();
    daemon.setOnMessage(() => daemon.send(answer));
    return track(noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }));
  }

  test("T-V2: initiator reads a refusal [3] → version-mismatch 3 (this side is older)", async () => {
    const ini = initiatorAgainst(Uint8Array.of(3));
    await ticks();
    expect(kindOf(ini)).toBe("version-mismatch");
    expect((ini.error as NoiseError).remoteVersion).toBe(3);
    expect((ini.error as Error).message).toContain("this side is older");
  });

  test("T-V2: initiator reads a lone [2] → bad-frame", async () => {
    const ini = initiatorAgainst(Uint8Array.of(2));
    await ticks();
    expect(kindOf(ini)).toBe("bad-frame");
  });

  test("T-V2: initiator reads a `t1:` text answer → version-mismatch 1 (the other side is older)", async () => {
    const ini = initiatorAgainst("t1:AAAA");
    await ticks();
    expect(kindOf(ini)).toBe("version-mismatch");
    expect((ini.error as NoiseError).remoteVersion).toBe(1);
    expect((ini.error as Error).message).toContain("other side is older");
  });

  test("T-V2: initiator reads a message 2 with header 0x01 → version-mismatch 1", async () => {
    const ini = initiatorAgainst(withVersion(1, new Uint8Array(49)));
    await ticks();
    expect(kindOf(ini)).toBe("version-mismatch");
    expect((ini.error as NoiseError).remoteVersion).toBe(1);
  });

  test("close: both ends observe onClose once; send after close is a no-op", async () => {
    const { r, c, cIn, dIn } = await connected();
    c.close();
    await ticks();
    expect(cIn.closes()).toBe(1);
    expect(dIn.closes()).toBe(1);
    const before = r.up.length;
    c.send("late");
    await ticks();
    expect(r.up.length).toBe(before);
  });

  test("authorize may be async; the handshake timer is cleared on success", async () => {
    const [a, b] = pair();
    const ta = fakeTimer();
    const tb = fakeTimer();
    const [c, d] = await Promise.all([
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng(), timer: ta }),
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: async (k) => {
          await tick();
          return same(k, DEVICE_PUB);
        },
        random: rng(70),
        timer: tb,
      }),
    ]);
    expect(ta.size).toBe(0);
    expect(tb.size).toBe(0);
    c.close();
    d.close();
  });

  test("generateStaticKeypair draws 32 bytes and derives the public key", () => {
    const kp = generateStaticKeypair(rng(5));
    expect(same(kp.privateKey, key(5))).toBe(true);
    expect(same(kp.publicKey, publicKeyOf(key(5)))).toBe(true);
    expect(() => generateStaticKeypair(() => new Uint8Array(31))).toThrow(NoiseError);
  });
});

describe("authorization", () => {
  test("an unknown device gets an authenticated deny: the initiator rejects `denied`", async () => {
    const [a, b] = pair();
    const dViol: NoiseError[] = [];
    const ini = track(
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
    );
    const res = track(
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: () => false,
        random: rng(60),
        onViolation: (e) => dViol.push(e),
      }),
    );
    await ticks();
    expect(ini.state).toBe("rejected");
    expect(kindOf(ini)).toBe("denied");
    // The initiator closed on reading it; the responder never built a channel.
    expect(res.state).toBe("rejected");
    expect(kindOf(res)).toBe("denied");
    expect(dViol).toEqual([]);
  });

  test("a responder that denied closes on its own timer if the initiator never does", async () => {
    const [attacker, b] = pair();
    const timer = fakeTimer();
    const replies: CarrierFrame[] = [];
    attacker.setOnMessage((t) => replies.push(t));
    let closed = false;
    attacker.setOnClose(() => {
      closed = true;
    });
    const res = track(
      noiseResponder(b, { staticKey: DAEMON, authorize: () => false, random: rng(60), timer }),
    );
    const hs = new IkInitiator({
      staticKey: DEVICE,
      ephemeralKey: key(9),
      remoteStatic: DAEMON_PUB,
      prologue: PROLOGUE,
    });
    attacker.send(v2(hs.writeMessage1(new Uint8Array(0))));
    await ticks();
    expect(replies.length).toBe(1);
    expect(res.state).toBe("pending");
    timer.fire();
    await ticks();
    expect(res.state).toBe("rejected");
    expect(kindOf(res)).toBe("denied");
    expect(closed).toBe(true);
  });

  for (const how of ["throws", "rejects"] as const) {
    test(`authorize ${how}: fail closed — no message 2, the responder closes and reports`, async () => {
      const r = relayed();
      const dViol: NoiseError[] = [];
      const ini = track(
        noiseInitiator(r.client, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      );
      const res = track(
        noiseResponder(r.daemon, {
          staticKey: DAEMON,
          authorize:
            how === "throws"
              ? () => {
                  throw new Error("registry down");
                }
              : () => Promise.reject(new Error("registry down")),
          random: rng(60),
          onViolation: (e) => dViol.push(e),
        }),
      );
      await ticks();
      expect(r.down).toEqual([]);
      expect(res.state).toBe("rejected");
      expect(kindOf(res)).toBe("handshake-failed");
      expect(dViol.length).toBe(1);
      expect(ini.state).toBe("rejected");
      expect(kindOf(ini)).toBe("closed");
    });
  }

  test("the socket closes during authorize: the verdict is ignored, nothing is sent or built", async () => {
    const r = relayed();
    const daemonRaw = counted(r.daemon);
    let allow: (ok: boolean) => void = () => {};
    const res = track(
      noiseResponder(daemonRaw.ch, {
        staticKey: DAEMON,
        authorize: () =>
          new Promise<boolean>((resolve) => {
            allow = resolve;
          }),
        random: rng(60),
      }),
    );
    track(noiseInitiator(r.client, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }));
    await ticks();
    r.cut();
    await ticks();
    allow(true);
    await ticks();
    // Not even attempted (a closed pair would swallow it silently).
    expect(daemonRaw.sent()).toBe(0);
    expect(r.down).toEqual([]);
    expect(res.state).toBe("rejected");
    expect(kindOf(res)).toBe("closed");
  });

  test("a replayed message 1 gets a message 2 but never resolves the responder", async () => {
    // Capture a live message 1 through a relay.
    const live = await connected();
    const captured = live.r.up[0];
    if (captured === undefined) throw new Error("no message 1 captured");
    live.c.close();

    const [attacker, b] = pair();
    const replies: CarrierFrame[] = [];
    attacker.setOnMessage((t) => replies.push(t));
    const timer = fakeTimer();
    const seen: Uint8Array[] = [];
    const dViol: NoiseError[] = [];
    const res = track(
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: (k) => {
          seen.push(k);
          return true;
        },
        random: rng(80),
        timer,
        onViolation: (e) => dViol.push(e),
      }),
    );
    attacker.send(captured);
    await ticks();
    // It passes authorize and gets an answer: the responder cannot tell a replay.
    expect(seen.length).toBe(1);
    expect(replies.length).toBe(1);
    // ...but without the confirm nothing is built.
    expect(res.state).toBe("pending");
    timer.fire();
    await ticks();
    expect(res.state).toBe("rejected");
    expect(kindOf(res)).toBe("timeout");
    expect(dViol.map((e) => e.kind)).toEqual(["timeout"]);
  });

  test("a forged confirm (the replayer cannot produce one) fails the responder", async () => {
    const live = await connected();
    const captured = live.r.up[0];
    const otherConfirm = live.r.up[1];
    if (captured === undefined || otherConfirm === undefined) throw new Error("no capture");
    live.c.close();
    const [attacker, b] = pair();
    const viol: NoiseError[] = [];
    const res = track(
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: () => true,
        random: rng(81),
        onViolation: (e) => viol.push(e),
      }),
    );
    attacker.send(captured);
    await ticks();
    attacker.send(otherConfirm); // the old connection's confirm: other keys
    await ticks();
    expect(res.state).toBe("rejected");
    // A well-formed frame that fails to decrypt is a failed handshake, not a malformed frame.
    expect(kindOf(res)).toBe("handshake-failed");
    expect(viol.map((e) => e.kind)).toEqual(["handshake-failed"]);
  });

  test("a message 1 with a payload is refused (IK's first payload is replayable)", async () => {
    const [attacker, b] = pair();
    const res = track(
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    );
    const hs = new IkInitiator({
      staticKey: DEVICE,
      ephemeralKey: key(9),
      remoteStatic: DAEMON_PUB,
      prologue: PROLOGUE,
    });
    attacker.send(v2(hs.writeMessage1(Uint8Array.of(1, 2, 3))));
    await ticks();
    expect(res.state).toBe("rejected");
    expect(kindOf(res)).toBe("handshake-failed");
  });

  test("a frame during authorize is a violation", async () => {
    const [attacker, b] = pair();
    const res = track(
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: () => new Promise<boolean>(() => {}),
        random: rng(60),
      }),
    );
    const hs = new IkInitiator({
      staticKey: DEVICE,
      ephemeralKey: key(9),
      remoteStatic: DAEMON_PUB,
      prologue: PROLOGUE,
    });
    attacker.send(v2(hs.writeMessage1(new Uint8Array(0))));
    await ticks();
    attacker.send(new Uint8Array(40));
    await ticks();
    expect(res.state).toBe("rejected");
    expect(kindOf(res)).toBe("handshake-failed");
  });
});

describe("handshake failures", () => {
  test("a wrong pinned daemon key: the responder cannot decrypt message 1, closes, reports", async () => {
    const r = relayed();
    const dViol: NoiseError[] = [];
    const ini = track(
      noiseInitiator(r.client, {
        staticKey: DEVICE,
        remoteStatic: publicKeyOf(key(77)),
        random: rng(),
      }),
    );
    const res = track(
      noiseResponder(r.daemon, {
        staticKey: DAEMON,
        authorize: () => true,
        random: rng(60),
        onViolation: (e) => dViol.push(e),
      }),
    );
    await ticks();
    expect(kindOf(res)).toBe("handshake-failed");
    expect(dViol.length).toBe(1);
    expect(kindOf(ini)).toBe("closed");
    expect((ini.error as Error).message).toContain("key");
    expect(r.down).toEqual([]);
  });

  test("a garbled message 2 fails the initiator (transient, never `denied`)", async () => {
    const r = relayed();
    r.ctl.down = (t, f) => f(flip(t, 40));
    const ini = track(
      noiseInitiator(r.client, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
    );
    track(noiseResponder(r.daemon, { staticKey: DAEMON, authorize: () => false, random: rng(60) }));
    await ticks();
    expect(kindOf(ini)).toBe("handshake-failed");
  });

  for (const status of [[7], [0, 0], []] as const) {
    test(`a message 2 status of [${status.join(",")}] is a violation`, async () => {
      const [a, daemon] = pair();
      daemon.setOnMessage((t) => {
        const hs = new IkResponder({ staticKey: DAEMON, ephemeralKey: key(9), prologue: PROLOGUE });
        hs.readMessage1(bytesOf(t).subarray(1));
        daemon.send(v2(hs.writeMessage2(Uint8Array.from(status))));
      });
      const ini = track(
        noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      );
      await ticks();
      expect(kindOf(ini)).toBe("handshake-failed");
    });
  }

  test("a low-order daemon key fails before anything is sent", async () => {
    const [a] = pair();
    const raw = counted(a);
    const ini = track(
      noiseInitiator(raw.ch, {
        staticKey: DEVICE,
        remoteStatic: new Uint8Array(32),
        random: rng(),
      }),
    );
    await ticks();
    expect(kindOf(ini)).toBe("handshake-failed");
    expect(raw.sent()).toBe(0);
    expect(raw.closed()).toBe(true);
  });

  test("a low-order ephemeral in message 1 fails the responder on the DH, not later", async () => {
    const [attacker, b] = pair();
    const dViol: NoiseError[] = [];
    const res = track(
      noiseResponder(b, {
        staticKey: DAEMON,
        authorize: () => true,
        random: rng(60),
        onViolation: (e) => dViol.push(e),
      }),
    );
    const m = new Uint8Array(32 + 48 + 16); // e = 0 (a low-order point), then junk
    m.fill(0xaa, 32);
    attacker.send(v2(m));
    await ticks();
    expect(kindOf(res)).toBe("handshake-failed");
    expect((res.error as Error).message).toContain("DH");
  });

  test("a plaintext peer (an old daemon answering JSON) fails with `bad-frame`, no decrypt", async () => {
    const [a, daemon] = pair();
    daemon.setOnMessage(() => daemon.send('{"jsonrpc":"2.0","id":1,"result":{}}'));
    const ini = track(
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
    );
    await ticks();
    expect(kindOf(ini)).toBe("bad-frame");
    expect((ini.error as Error).message).toContain("text frame");
  });

  test("a text frame with another tag is refused by the responder as bad-frame", async () => {
    const [attacker, b] = pair();
    const res = track(
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    );
    attacker.send("t2:AAAA");
    await ticks();
    expect(kindOf(res)).toBe("bad-frame");
  });

  test("an oversized handshake frame is refused before decoding", async () => {
    const [attacker, b] = pair();
    const res = track(
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    );
    attacker.send(new Uint8Array(MAX_NOISE_MESSAGE + 2).fill(2));
    await ticks();
    expect(kindOf(res)).toBe("bad-frame");
    expect((res.error as Error).message).toContain("too long");
  });

  test("a silent peer: the timer closes raw on both roles", async () => {
    for (const role of ["initiator", "responder"] as const) {
      const [a, other] = pair();
      let otherClosed = false;
      other.setOnClose(() => {
        otherClosed = true;
      });
      other.setOnMessage(() => {});
      const timer = fakeTimer();
      const p = track<SecureChannel>(
        role === "initiator"
          ? noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng(), timer })
          : noiseResponder(a, { staticKey: DAEMON, authorize: () => true, random: rng(), timer }),
      );
      await ticks();
      expect(p.state).toBe("pending");
      timer.fire();
      await ticks();
      expect(kindOf(p)).toBe("timeout");
      expect(otherClosed).toBe(true);
    }
  });

  test("the caller closing raw during the handshake rejects `closed`", async () => {
    const [a] = pair();
    const ini = track(
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
    );
    a.close();
    await ticks();
    expect(kindOf(ini)).toBe("closed");
  });

  test("randomness missing or of the wrong length fails before any send", async () => {
    for (const random of [() => new Uint8Array(31), undefined]) {
      const [a] = pair();
      const raw = counted(a);
      const ini = track(
        noiseInitiator(raw.ch, {
          staticKey: DEVICE,
          remoteStatic: DAEMON_PUB,
          random: random as (n: number) => Uint8Array,
        }),
      );
      const [, b] = pair();
      const rawB = counted(b);
      const res = track(
        noiseResponder(rawB.ch, {
          staticKey: DAEMON,
          authorize: () => true,
          random: random as (n: number) => Uint8Array,
        }),
      );
      await ticks();
      expect(kindOf(ini)).toBe("handshake-failed");
      expect(kindOf(res)).toBe("handshake-failed");
      expect(raw.sent()).toBe(0);
      expect(rawB.sent()).toBe(0);
    }
  });
});

describe("transport violations close, report, deliver nothing", () => {
  const cases: [string, Hook][] = [
    ["tamper (type byte)", (t, f) => f(flip(t, 0))],
    ["tamper (middle)", (t, f) => f(flip(t, 3))],
    ["tamper (tag)", (t, f) => f(flip(t, -1))],
    [
      "duplicate",
      (t, f) => {
        f(t);
        f(t);
      },
    ],
    ["drop", () => {}],
  ];
  for (const [name, hook] of cases) {
    test(name, async () => {
      const { r, c, dIn, dViol } = await connected();
      let first = true;
      r.ctl.up = (t, f, b) => {
        if (first) {
          first = false;
          hook(t, f, b);
        } else f(t);
      };
      c.send("first");
      c.send("second");
      await ticks();
      expect(dIn.got).toEqual(name === "duplicate" ? ["first"] : []);
      expect(dViol.length).toBe(1);
      // Refused by the AEAD itself, not by a later check that happens to trip on garbage.
      expect(dViol[0]?.message).toBe("decryption failed");
      expect(dIn.closes()).toBe(1);
    });
  }

  test("reorder", async () => {
    const { r, c, dIn, dViol } = await connected();
    let held: CarrierFrame | null = null;
    r.ctl.up = (t, f) => {
      if (held === null) {
        held = t;
        return;
      }
      f(t);
      f(held);
    };
    c.send("first");
    c.send("second");
    await ticks();
    expect(dIn.got).toEqual([]);
    expect(dViol.map((e) => e.message)).toEqual(["decryption failed"]);
  });

  test("reflect: a frame sent back to its sender fails on the other direction's key", async () => {
    const { r, c, cIn, cViol, dIn } = await connected();
    r.ctl.up = (t, _f, back) => back(t);
    c.send("mine");
    await ticks();
    expect(cIn.got).toEqual([]);
    expect(dIn.got).toEqual([]);
    expect(cViol.map((e) => e.message)).toEqual(["decryption failed"]);
    expect(cIn.closes()).toBe(1);
  });

  test("a frame replayed on a new connection fails (fresh keys)", async () => {
    const one = await connected();
    one.c.send("old");
    await ticks();
    const old = one.r.up.at(-1);
    if (old === undefined) throw new Error("nothing captured");
    one.c.close();
    // Fresh ephemerals (a real RNG never repeats them): that is what makes the keys new.
    const two = await connected({ seed: 20 });
    two.r.ctl.up = (_t, f) => f(old);
    two.c.send("new");
    await ticks();
    expect(two.dIn.got).toEqual([]);
    expect(two.dViol.map((e) => e.message)).toEqual(["decryption failed"]);
  });

  test("a connection cut mid-fragment delivers nothing and is not a violation", async () => {
    const { r, c, dIn, dViol } = await connected();
    r.ctl.up = (t, f) => {
      f(t);
      r.cut();
    };
    c.send("z".repeat(200_000));
    await ticks();
    expect(dIn.got).toEqual([]);
    expect(dIn.closes()).toBe(1);
    expect(dViol).toEqual([]);
  });

  test("over maxMessageBytes closes before buffering more", async () => {
    const { c, dIn, dViol } = await connected({ daemonMax: 1000 });
    c.send("y".repeat(1000));
    c.send("y".repeat(1001));
    await ticks();
    expect(dIn.got).toEqual(["y".repeat(1000)]);
    expect(dViol.map((e) => e.kind)).toEqual(["bad-frame"]);
    expect(dIn.closes()).toBe(1);
  });

  test("a raw send that throws: no throw to the caller, the channel closes and reports", async () => {
    const [a, b] = pair();
    const raw = counted(a);
    const cViol: NoiseError[] = [];
    const [c, d] = await Promise.all([
      noiseInitiator(raw.ch, {
        staticKey: DEVICE,
        remoteStatic: DAEMON_PUB,
        random: rng(),
        onViolation: (e) => cViol.push(e),
      }),
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    ]);
    const cIn = listen(c);
    listen(d);
    raw.breakSends();
    expect(() => c.send("x")).not.toThrow();
    expect(cViol.length).toBe(1);
    expect(raw.closed()).toBe(true);
    await ticks();
    expect(cIn.closes()).toBe(1);
    const sent = raw.sent();
    c.send("after");
    expect(raw.sent()).toBe(sent);
  });
});

describe("delivery before handlers", () => {
  test("frames and a close that arrive before the handlers are queued, then flushed in order", async () => {
    const [a, b] = pair();
    const [c, d] = await Promise.all([
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    ]);
    c.send("1");
    c.send("2");
    c.send("3");
    await ticks(); // delivered to the decorator, no handler yet
    c.close();
    await ticks();
    const order: string[] = [];
    d.setOnMessage((m) => order.push(m));
    d.setOnClose(() => order.push("close"));
    await ticks();
    expect(order).toEqual(["1", "2", "3", "close"]);
  });

  test("a local close stops delivery of the queued frames; the close is still delivered once", async () => {
    const [a, b] = pair();
    const [c, d] = await Promise.all([
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    ]);
    c.send("a");
    c.send("b");
    c.send("c");
    await ticks(); // queued in the decorator, no handler yet
    const order: string[] = [];
    d.setOnMessage((m) => {
      order.push(m);
      d.close();
    });
    d.setOnClose(() => order.push("close"));
    await ticks();
    expect(order).toEqual(["a", "close"]);
  });

  test("a local close inside the handler stops queued frames even when the peer closed first", async () => {
    const [a, b] = pair();
    const [c, d] = await Promise.all([
      noiseInitiator(a, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      noiseResponder(b, { staticKey: DAEMON, authorize: () => true, random: rng(60) }),
    ]);
    c.send("a");
    c.send("b");
    c.send("c");
    await ticks();
    c.close();
    await ticks(); // frames and the peer's close are queued, no handler yet
    const order: string[] = [];
    d.setOnMessage((m) => {
      order.push(m);
      d.close();
    });
    d.setOnClose(() => order.push("close"));
    await ticks();
    expect(order).toEqual(["a", "close"]);
  });
});

describe("byte transparency", () => {
  test("a leading U+FEFF survives the channel", async () => {
    const { c, dIn } = await connected();
    c.send("﻿abc");
    c.send("﻿");
    await ticks();
    expect(dIn.got).toEqual(["﻿abc", "﻿"]);
  });
});

describe("the AEAD", () => {
  test("every flipped byte of a ciphertext is refused, and the counter does not advance", () => {
    const k = key(5);
    const ct = new CipherState(k).encryptWithAd(new Uint8Array(0), Uint8Array.of(1, 2, 3));
    const rx = new CipherState(k);
    for (let i = 0; i < ct.length; i++) {
      const bad = Uint8Array.from(ct);
      bad[i] = (bad[i] ?? 0) ^ 0x80;
      expect(() => rx.decryptWithAd(new Uint8Array(0), bad)).toThrow("decryption failed");
      expect(rx.nonce).toBe(0);
    }
    expect(Array.from(rx.decryptWithAd(new Uint8Array(0), ct))).toEqual([1, 2, 3]);
  });
});

describe("nonce limit", () => {
  test("a CipherState started near the limit stops before reuse, loudly", () => {
    const k = key(3);
    const tx = new CipherState(k, Number.MAX_SAFE_INTEGER - 1);
    const rx = new CipherState(k, Number.MAX_SAFE_INTEGER - 1);
    const ct = tx.encryptWithAd(new Uint8Array(0), Uint8Array.of(1));
    expect(Array.from(rx.decryptWithAd(new Uint8Array(0), ct))).toEqual([1]);
    expect(() => tx.encryptWithAd(new Uint8Array(0), Uint8Array.of(2))).toThrow(NoiseError);
    expect(tx.nonce).toBe(Number.MAX_SAFE_INTEGER);
    // The counter never wrapped: a later attempt still refuses.
    expect(() => tx.encryptWithAd(new Uint8Array(0), Uint8Array.of(2))).toThrow(NoiseError);
  });

  test("the 64-bit counter is little-endian above 2^32 (the high word is used)", () => {
    const k = key(4);
    const n = 0x0102 * 2 ** 32 + 0x05060708;
    const a = new CipherState(k, n).encryptWithAd(new Uint8Array(0), Uint8Array.of(9));
    // Built by hand: 4 zero bytes, then n as 8 little-endian bytes.
    const nonce = Uint8Array.of(0, 0, 0, 0, 0x08, 0x07, 0x06, 0x05, 0x02, 0x01, 0, 0);
    const b = chacha20poly1305(k, nonce, new Uint8Array(0)).encrypt(Uint8Array.of(9));
    expect(same(a, b)).toBe(true);
  });
});

describe("authorize's verdict carries the peer's cap (docs/feat/device-pairing.md P1)", () => {
  // The cap has to be decided with the verdict: `Secured` fixes it at
  // construction and the responder reads its own default BEFORE the key is
  // known (`:410` vs `:427`), so an admitted stranger would otherwise get the
  // full 32 MiB reassembly. Mutation: ignore the verdict's cap (build with
  // `max`) -> the first two tests go red.
  const PAIRING_CAP = 4096;

  async function withVerdict(verdict: AuthorizeVerdict) {
    const r = relayed();
    const dViol: NoiseError[] = [];
    const [c, d] = await Promise.all([
      noiseInitiator(r.client, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      noiseResponder(r.daemon, {
        staticKey: DAEMON,
        authorize: () => verdict,
        random: rng(50),
        onViolation: (e) => dViol.push(e),
      }),
    ]);
    return { c, d, dIn: listen(d), dViol };
  }

  test("an allowed stranger is capped at the verdict's bytes, not the 32 MiB default", async () => {
    const { c, d, dIn, dViol } = await withVerdict({
      allow: true,
      maxMessageBytes: PAIRING_CAP,
    });
    c.send("y".repeat(PAIRING_CAP));
    c.send("y".repeat(PAIRING_CAP + 1));
    await ticks();
    expect(dIn.got).toEqual(["y".repeat(PAIRING_CAP)]);
    expect(dViol.map((e) => e.kind)).toEqual(["bad-frame"]);
    expect(dIn.closes()).toBe(1);
  });

  test("`true` keeps the responder default (a paired device is not shrunk)", async () => {
    const { c, d, dIn, dViol } = await withVerdict(true);
    c.send("y".repeat(PAIRING_CAP * 8));
    await ticks();
    expect(dIn.got).toEqual(["y".repeat(PAIRING_CAP * 8)]);
    expect(dViol).toEqual([]);
  });

  test("a verdict it cannot read fails CLOSED (no channel, an authenticated deny)", async () => {
    for (const bad of [
      { allow: true, maxMessageBytes: 0 },
      { allow: true, maxMessageBytes: Number.NaN },
      { allow: false, maxMessageBytes: PAIRING_CAP },
      {},
      null,
    ] as unknown as AuthorizeVerdict[]) {
      const r = relayed();
      const ini = track(
        noiseInitiator(r.client, { staticKey: DEVICE, remoteStatic: DAEMON_PUB, random: rng() }),
      );
      const res = track(
        noiseResponder(r.daemon, {
          staticKey: DAEMON,
          authorize: () => bad,
          random: rng(51),
        }),
      );
      await ticks();
      expect(kindOf(ini)).toBe("denied");
      expect(kindOf(res)).toBe("denied");
    }
  });
});

describe("a real WebSocket", () => {
  test("a loopback socket carries a 1 MiB frame in maximum-size binary messages", async () => {
    const sizes: number[] = [];
    let onMsg: ((d: CarrierFrame) => void) | undefined;
    let onClose: (() => void) | undefined;
    let responder: Promise<SecureChannel> | undefined;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("no", { status: 400 });
      },
      websocket: {
        open(ws) {
          const raw: ByteCarrier = {
            send: (d) => {
              ws.send(d);
            },
            close: () => ws.close(),
            setOnMessage: (h) => {
              onMsg = h;
            },
            setOnClose: (h) => {
              onClose = h;
            },
          };
          responder = noiseResponder(raw, {
            staticKey: DAEMON,
            authorize: (k) => same(k, DEVICE_PUB),
            random: rng(60),
          });
        },
        message(_ws, message) {
          if (typeof message === "string") throw new Error("a text frame on the e2e socket");
          sizes.push(message.byteLength);
          onMsg?.(new Uint8Array(message.buffer, message.byteOffset, message.byteLength));
        },
        close() {
          onClose?.();
        },
      },
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("ws error"));
      });
      ws.binaryType = "arraybuffer";
      const raw: ByteCarrier = {
        send: (d) => ws.send(d),
        close: () => ws.close(),
        setOnMessage: (h) => {
          ws.onmessage = (e) => h(new Uint8Array(e.data as ArrayBuffer));
        },
        setOnClose: (h) => {
          ws.onclose = () => h();
        },
      };
      const c = await noiseInitiator(raw, {
        staticKey: DEVICE,
        remoteStatic: DAEMON_PUB,
        random: rng(),
      });
      if (!responder) throw new Error("no server connection");
      const d = await responder;
      let got = "";
      d.setOnMessage((m) => {
        got = m;
      });
      d.setOnClose(() => {});
      const payload = "q".repeat(1 << 20);
      c.send(payload);
      const start = Date.now();
      while (got.length === 0 && Date.now() - start < 5000) await tick();
      expect(got).toBe(payload);
      // msg1 + confirm + 17 data chunks, the first 16 at the maximum size.
      expect(sizes.length).toBe(2 + 17);
      expect(Math.max(...sizes)).toBe(MAX_NOISE_MESSAGE);
      c.close();
    } finally {
      server.stop(true);
    }
  });
});
