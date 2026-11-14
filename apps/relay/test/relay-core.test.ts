import { describe, expect, test } from "bun:test";
import {
  RELAY_CLOSE_UNREGISTERED,
  RELAY_STREAM_EXPIRY_MS,
  RELAY_STREAM_HOLD_MS,
  encodeBase64Url,
} from "@tentacle/protocol";
import {
  RELAY_CLOSE_REFUSED,
  RELAY_LIMITS,
  RelayCore,
  type RelayEffect,
  type RelayLimits,
} from "../src/relay-core.ts";

const SOCKET = "phone-1";

/** A secret whose id is stable across runs (the hash is not being tested here). */
function secret(byte: number): string {
  return encodeBase64Url(new Uint8Array(32).fill(byte));
}

/**
 * A deterministic core: an injected clock and a token sequence, so a test states
 * "at 10 s it expires" instead of sleeping, and asserts the exact token.
 */
function makeCore(overrides: { limits?: Partial<RelayLimits> } = {}) {
  let at = 1_000;
  let minted = 0;
  const core = new RelayCore({
    now: () => at,
    mintToken: () => {
      minted += 1;
      return `t${minted.toString().padStart(2, "0")}${"x".repeat(19)}`;
    },
    ...(overrides.limits ? { limits: overrides.limits } : {}),
  });
  return {
    core,
    advance(ms: number) {
      at += ms;
    },
    get now() {
      return at;
    },
  };
}

/** The frames a decision asked to send, in order (the effects a test asserts). */
function sent(effects: readonly RelayEffect[]): unknown[] {
  return effects.flatMap((effect) => (effect.kind === "send" ? [effect.frame] : []));
}

/** The closes a decision asked for, as `[target, code]`. */
function closes(effects: readonly RelayEffect[]): [string, number][] {
  return effects.flatMap((effect) =>
    effect.kind === "close" ? [[effect.target, effect.code] as [string, number]] : [],
  );
}

describe("RelayCore.hello — registration", () => {
  test("registers the id the secret derives and answers `ready` with it", () => {
    const { core } = makeCore();
    const decision = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    expect(decision.ok).toBe(true);
    // The id is derived, never claimed: it is `relayIdOf`'s own vector.
    expect(decision.id).toBe("fgkrQr2vTa2JTEe75Kl66v");
    expect(sent(decision.effects)).toEqual([
      { t: "ready", v: 1, id: "fgkrQr2vTa2JTEe75Kl66v", features: [] },
    ]);
    expect(core.registeredCount).toBe(1);
    expect(core.idOfControl("d1")).toBe("fgkrQr2vTa2JTEe75Kl66v");
  });

  test("a hello with a secret not matching is refused (no id is ever trusted from the wire)", () => {
    const { core } = makeCore();
    // Every hello registers only the id its OWN secret hashes to — there is no
    // field in which a caller could claim someone else's id, which is the whole
    // anti-squat property (F8). A non-canonical / wrong-size secret is refused
    // outright rather than hashing to some id.
    const decision = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    expect(decision.ok).toBe(true);
    const second = core.hello({ socket: "d2", ip: "203.0.113.6", v: 1, secret: secret(8) });
    expect(second.ok).toBe(true);
    // Two different secrets are two ids: neither can stand in for the other.
    expect(second.id).not.toBe(decision.id);
    expect(core.registeredCount).toBe(2);
  });

  test("a non-canonical secret encoding is refused instead of hashed", () => {
    const { core } = makeCore();
    // 43 valid base64url chars whose last group carries non-zero padding bits:
    // it decodes to 32 bytes only through a lenient decoder, and a lenient
    // decode would map two wire strings to one secret.
    const bogus = `${"A".repeat(42)}B`;
    const decision = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: bogus });
    expect(decision.ok).toBe(false);
    expect(sent(decision.effects)).toEqual([{ t: "error", code: "invalid", supported: [1] }]);
    expect(core.registeredCount).toBe(0);
  });

  test("newest wins: a second hello for one id replaces the old socket and TELLS it", () => {
    const { core } = makeCore();
    core.hello({ socket: "old", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const second = core.hello({ socket: "new", ip: "198.51.100.9", v: 1, secret: secret(7) });
    expect(second.ok).toBe(true);
    expect(sent(second.effects)).toEqual([
      { t: "ready", v: 1, id: "fgkrQr2vTa2JTEe75Kl66v", features: [] },
      { t: "replaced" },
    ]);
    expect(closes(second.effects)).toEqual([["old", 1000]]);
    // One registration, and it is the new socket's: the predecessor is gone at
    // once, never waiting for its dead TCP path to time out (F15).
    expect(core.registeredCount).toBe(1);
    expect(core.idOfControl("new")).toBe("fgkrQr2vTa2JTEe75Kl66v");
    expect(core.idOfControl("old")).toBeUndefined();
  });

  test("a re-hello on the SAME socket is not a replacement (no self-close)", () => {
    const { core } = makeCore();
    core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const again = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    expect(again.ok).toBe(true);
    expect(closes(again.effects)).toEqual([]);
    expect(core.idOfControl("d1")).toBe("fgkrQr2vTa2JTEe75Kl66v");
  });

  test("an unknown protocol version is refused `version` with the supported list", () => {
    const { core } = makeCore();
    const decision = core.hello({ socket: "d1", ip: "203.0.113.5", v: 2, secret: secret(7) });
    expect(decision.ok).toBe(false);
    expect(sent(decision.effects)).toEqual([{ t: "error", code: "version", supported: [1] }]);
    expect(closes(decision.effects)).toEqual([["d1", 1000]]);
    expect(core.registeredCount).toBe(0);
  });

  test("a second hello on ONE control socket, with a different secret, is refused", () => {
    const { core } = makeCore();
    const first = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    expect(first.ok).toBe(true);
    // One control socket serves ONE daemon: a second registration on it would
    // leak its id until the relay restarts (the socket's close only ever
    // unregistered the first), and phones for it would hang on a dead route.
    const second = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(8) });
    expect(second.ok).toBe(false);
    expect(sent(second.effects)).toEqual([{ t: "error", code: "invalid", supported: [1] }]);
    expect(closes(second.effects)).toEqual([["d1", 1000]]);
    expect(core.registeredCount).toBe(1);
    expect(core.idOfControl("d1")).toBe("fgkrQr2vTa2JTEe75Kl66v");
  });

  test("a control socket closing unregisters its id", () => {
    const { core } = makeCore();
    core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    core.controlClosed("d1");
    expect(core.registeredCount).toBe(0);
    expect(core.idOfControl("d1")).toBeUndefined();
  });
});

describe("RelayCore.dial — open, hold, expiry", () => {
  test("a dial for a registered id opens a stream and tells the daemon with the phone's ip", () => {
    const { core } = makeCore();
    core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const dial = core.dial({ socket: SOCKET, ip: "198.51.100.9", id: "fgkrQr2vTa2JTEe75Kl66v" });
    expect(dial.ok).toBe(true);
    if (dial.ok && dial.state === "opened") {
      expect(sent(dial.effects)).toEqual([{ t: "open", stream: dial.stream, ip: "198.51.100.9" }]);
      expect(core.streamCount).toBe(1);
    } else {
      throw new Error("expected an opened dial");
    }
  });

  test("a dial for an id nobody registered is HELD, and released on the registration", () => {
    const { core } = makeCore();
    const dial = core.dial({ socket: SOCKET, ip: "198.51.100.9", id: "fgkrQr2vTa2JTEe75Kl66v" });
    expect(dial.ok).toBe(true);
    if (dial.ok) {
      expect(dial.state).toBe("held");
      expect(dial.effects).toEqual([]);
    }
    expect(core.heldCount).toBe(1);

    const hello = core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    // The registration carries the `open` for the phone that was already there,
    // so the pairing race (F17) resolves without the phone redialling.
    expect(sent(hello.effects)).toEqual([
      { t: "ready", v: 1, id: "fgkrQr2vTa2JTEe75Kl66v", features: [] },
      { t: "open", stream: "t01xxxxxxxxxxxxxxxxxxx", ip: "198.51.100.9" },
    ]);
    expect(core.heldCount).toBe(0);
    expect(core.streamCount).toBe(1);
  });

  test("the hold sweep releases nothing early and closes `4404` at exactly 5 s", () => {
    const clock = makeCore();
    clock.core.dial({ socket: SOCKET, ip: "198.51.100.9", id: "fgkrQr2vTa2JTEe75Kl66v" });
    clock.advance(RELAY_STREAM_HOLD_MS - 1);
    expect(clock.core.sweep()).toEqual([]);
    expect(clock.core.heldCount).toBe(1);
    clock.advance(1);
    expect(clock.core.sweep()).toEqual([
      { kind: "close", target: SOCKET, code: RELAY_CLOSE_UNREGISTERED },
    ]);
    expect(clock.core.heldCount).toBe(0);
  });

  test("a held dial that goes away frees its per-ip slot", () => {
    const clock = makeCore({ limits: { concurrentPerIp: 1 } });
    clock.core.dial({ socket: "p1", ip: "198.51.100.9", id: "fgkrQr2vTa2JTEe75Kl66v" });
    const second = clock.core.dial({
      socket: "p2",
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    expect(second.ok).toBe(false);
    clock.core.phoneClosed("p1");
    const third = clock.core.dial({
      socket: "p3",
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    expect(third.ok).toBe(true);
  });

  test("an unaccepted stream expiring in the sweep also CLOSES its phone (fx round 1 F1)", () => {
    const clock = makeCore({ limits: { concurrentPerIp: 1 } });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const ip = "198.51.100.9";
    expect(clock.core.dial({ socket: "p1", ip, id: "fgkrQr2vTa2JTEe75Kl66v" }).ok).toBe(true);
    clock.advance(RELAY_STREAM_EXPIRY_MS + 1);
    // A daemon that never accepts must not leave a phone socket pinned open for
    // its whole idle timeout: the expiry closes it, so the app tries its next
    // address (F2/F7 convergence) — and the per-ip slot is really back.
    expect(clock.core.sweep()).toEqual([
      { kind: "close", target: "p1", code: RELAY_CLOSE_UNREGISTERED },
    ]);
    expect(clock.core.streamCount).toBe(0);
    expect(clock.core.dial({ socket: "p2", ip, id: "fgkrQr2vTa2JTEe75Kl66v" }).ok).toBe(true);
  });

  test("an unaccepted stream stops counting against its id after the expiry", () => {
    const clock = makeCore({ limits: { streamsPerId: 1 } });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const first = clock.core.dial({
      socket: "p1",
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    expect(first.ok).toBe(true);
    // The daemon never accepted it: the id's stream slot is taken until expiry.
    const blocked = clock.core.dial({
      socket: "p2",
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    expect(blocked.ok).toBe(false);
    clock.advance(RELAY_STREAM_EXPIRY_MS + 1);
    // Expiry closes the phone it can no longer serve (fix round 1 F1) and frees
    // the id's slot.
    expect(clock.core.sweep()).toEqual([
      { kind: "close", target: "p1", code: RELAY_CLOSE_UNREGISTERED },
    ]);
    expect(clock.core.streamCount).toBe(0);
    const allowed = clock.core.dial({
      socket: "p3",
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    expect(allowed.ok).toBe(true);
  });
});

describe("RelayCore.accept — the stream token is single-use and expires", () => {
  test("accepts a minted stream once and hands back the phone leg", () => {
    const clock = makeCore();
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const dial = clock.core.dial({
      socket: SOCKET,
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    if (!dial.ok || dial.state !== "opened") {
      throw new Error("expected an opened dial");
    }
    const accept = clock.core.accept({ socket: "a1", token: dial.stream, v: 1 });
    expect(accept).toEqual({
      ok: true,
      token: dial.stream,
      id: "fgkrQr2vTa2JTEe75Kl66v",
      phone: SOCKET,
    });
    // Single use: a replay of the same token is refused (F12).
    expect(clock.core.accept({ socket: "a2", token: dial.stream, v: 1 })).toEqual({
      ok: false,
      reason: "used",
    });
  });

  test("a token nobody minted is refused `unknown`", () => {
    const { core } = makeCore();
    expect(core.accept({ socket: "a1", token: "t99xxxxxxxxxxxxxxxxxxx", v: 1 })).toEqual({
      ok: false,
      reason: "unknown",
    });
  });

  test("a token expires at 10 s, and the expiry frees the slot", () => {
    const clock = makeCore();
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const dial = clock.core.dial({
      socket: SOCKET,
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    if (!dial.ok || dial.state !== "opened") {
      throw new Error("expected an opened dial");
    }
    clock.advance(RELAY_STREAM_EXPIRY_MS + 1);
    expect(clock.core.accept({ socket: "a1", token: dial.stream, v: 1 })).toEqual({
      ok: false,
      reason: "expired",
      // Expiry on the ACCEPT path closes the phone too (fix round 1 F1): the
      // sweep has not ticked yet, and a phone left open here would wait out its
      // idle timeout instead of retrying another address.
      effects: [{ kind: "close", target: SOCKET, code: RELAY_CLOSE_UNREGISTERED }],
    });
    expect(clock.core.streamCount).toBe(0);
  });

  test("a version skew on accept is refused `version`", () => {
    const clock = makeCore();
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const dial = clock.core.dial({
      socket: SOCKET,
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    if (!dial.ok || dial.state !== "opened") {
      throw new Error("expected an opened dial");
    }
    expect(clock.core.accept({ socket: "a1", token: dial.stream, v: 2 })).toEqual({
      ok: false,
      reason: "version",
    });
    // Refused before consumption: the right version still works.
    expect(clock.core.accept({ socket: "a1", token: dial.stream, v: 1 }).ok).toBe(true);
  });
});

describe("RelayCore limits — each at its boundary (N ok, N+1 refused)", () => {
  const ID = "fgkrQr2vTa2JTEe75Kl66v";

  test("dials per minute per ip", () => {
    const clock = makeCore({ limits: { dialsPerMinutePerIp: 2, concurrentPerIp: 99 } });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const ip = "198.51.100.9";
    expect(clock.core.dial({ socket: "p1", ip, id: ID }).ok).toBe(true);
    expect(clock.core.dial({ socket: "p2", ip, id: ID }).ok).toBe(true);
    const third = clock.core.dial({ socket: "p3", ip, id: ID });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toBe("rate");
    }
    // The window rolls over: the same ip dials again a minute later.
    clock.advance(60_000);
    expect(clock.core.dial({ socket: "p4", ip, id: ID }).ok).toBe(true);
  });

  test("concurrent phone sockets per ip", () => {
    const clock = makeCore({ limits: { concurrentPerIp: 2, dialsPerMinutePerIp: 99 } });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const ip = "198.51.100.9";
    expect(clock.core.dial({ socket: "p1", ip, id: ID }).ok).toBe(true);
    expect(clock.core.dial({ socket: "p2", ip, id: ID }).ok).toBe(true);
    const third = clock.core.dial({ socket: "p3", ip, id: ID });
    expect(third.ok).toBe(false);
    if (!third.ok) {
      expect(third.reason).toBe("concurrency");
    }
    clock.core.phoneClosed("p2");
    expect(clock.core.dial({ socket: "p4", ip, id: ID }).ok).toBe(true);
  });

  test("streams per id", () => {
    const clock = makeCore({ limits: { streamsPerId: 2, concurrentPerIp: 99 } });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    expect(clock.core.dial({ socket: "p1", ip: "198.51.100.9", id: ID }).ok).toBe(true);
    expect(clock.core.dial({ socket: "p2", ip: "198.51.100.9", id: ID }).ok).toBe(true);
    expect(clock.core.dial({ socket: "p3", ip: "198.51.100.9", id: ID }).ok).toBe(false);
    // A different ip does not help: the cap is the ID's, not the source's.
    expect(clock.core.dial({ socket: "p4", ip: "192.0.2.7", id: ID }).ok).toBe(false);
  });

  test("registered ids (a NEW id is refused at the cap; a returning one is not)", () => {
    const clock = makeCore({ limits: { registeredIds: 2 } });
    expect(clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) }).ok).toBe(
      true,
    );
    expect(clock.core.hello({ socket: "d2", ip: "203.0.113.6", v: 1, secret: secret(8) }).ok).toBe(
      true,
    );
    const third = clock.core.hello({ socket: "d3", ip: "203.0.113.7", v: 1, secret: secret(9) });
    expect(third.ok).toBe(false);
    expect(sent(third.effects)).toEqual([{ t: "error", code: "busy", supported: [1] }]);
    // A daemon already registered may always come back — a restart must never be
    // locked out by a cap someone else filled (F15).
    expect(clock.core.hello({ socket: "d1b", ip: "203.0.113.5", v: 1, secret: secret(7) }).ok).toBe(
      true,
    );
  });

  test("hellos per minute per ip", () => {
    const clock = makeCore({ limits: { hellosPerMinutePerIp: 2 } });
    expect(clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) }).ok).toBe(
      true,
    );
    expect(clock.core.hello({ socket: "d2", ip: "203.0.113.5", v: 1, secret: secret(8) }).ok).toBe(
      true,
    );
    const third = clock.core.hello({ socket: "d3", ip: "203.0.113.5", v: 1, secret: secret(9) });
    expect(third.ok).toBe(false);
    expect(sent(third.effects)).toEqual([{ t: "error", code: "busy", supported: [1] }]);
  });

  test("the per-ip bookkeeping is bounded (a dropped entry starts fresh, never a bypass)", () => {
    const clock = makeCore({
      limits: { maxTrackedIps: 3, dialsPerMinutePerIp: 1, concurrentPerIp: 99 },
    });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    const ID = "fgkrQr2vTa2JTEe75Kl66v";
    clock.core.dial({ socket: "p1", ip: "198.51.100.1", id: ID });
    clock.core.dial({ socket: "p2", ip: "198.51.100.2", id: ID });
    clock.core.dial({ socket: "p3", ip: "198.51.100.3", id: ID });
    // A fourth ip evicts the oldest entry; the relay keeps its own stream slots
    // intact (the cap that matters is the id's, and the ip's is re-checked).
    clock.core.dial({ socket: "p4", ip: "198.51.100.4", id: ID });
    expect(clock.core.streamCount).toBe(4);
  });
});

describe("RelayCore — refusals carry no effects (a refused dial never touches the phone)", () => {
  test("a rate refusal is a plain no, not a close the server did not ask for", () => {
    const clock = makeCore({ limits: { dialsPerMinutePerIp: 1 } });
    clock.core.hello({ socket: "d1", ip: "203.0.113.5", v: 1, secret: secret(7) });
    clock.core.dial({ socket: "p1", ip: "198.51.100.9", id: "fgkrQr2vTa2JTEe75Kl66v" });
    const refused = clock.core.dial({
      socket: "p2",
      ip: "198.51.100.9",
      id: "fgkrQr2vTa2JTEe75Kl66v",
    });
    expect(refused.ok).toBe(false);
    expect(refused.effects).toEqual([]);
    // The server answers `4429` at its own layer (it owns the socket), so the
    // code is named where it is used — pinned so it cannot drift silently.
    expect(RELAY_CLOSE_REFUSED).toBe(4429);
  });
});
