/**
 * The mobile relay's wire (docs/feat/mobile-relay.md, R1): the control-frame
 * vocabulary a daemon and the relay speak on `/v1/daemon`, plus the two pure
 * helpers the rest of the feature is built on — `relayAddress(url, id)` (the
 * phone's `/d/<id>/e2e` address, computed locally, Owner Q4) and `isRelayUrl`.
 *
 * This wire is NOT `PROTOCOL_VERSION`: it has its own `RELAY_PROTOCOL_VERSION`,
 * because a relay's version and the RPC protocol's move independently (an
 * unknown `hello.v` owes a clean `error:"version"`, never a mid-session skew).
 *
 * Strip schemas (AGENTS §7): an unknown FIELD is dropped, never refused — a
 * newer relay may add one. An unknown `t` IS refused: the discriminator picks
 * the shape, so there is nothing to ignore.
 */
import { describe, expect, test } from "bun:test";
import { isPairingAddress } from "../src/pairing.ts";
import {
  DevicePushRegisterParamsSchema,
  PUSH_COLLAPSE_ID_MAX,
  PUSH_DELIVERY_STATUSES,
  PUSH_ENC_TEXT_LENGTH,
  PUSH_ENVELOPE_CIPHERTEXT_LENGTHS,
  PUSH_KID_LENGTH,
  type PushEnvelope,
  isPushDeliveryStatus,
  pushCollapseIdOf,
} from "../src/push.ts";
import {
  DEFAULT_RELAY_URL,
  RELAY_CLOSE_UNREGISTERED,
  RELAY_CONTROL_LIMITS,
  RELAY_ID_LENGTH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SECRET_TEXT_LENGTH,
  RELAY_STREAM_EXPIRY_MS,
  RELAY_STREAM_HOLD_MS,
  RELAY_STREAM_TEXT_LENGTH,
  RelayCollapseIdSchema,
  RelayControlFrameSchema,
  type RelayDaemonFrame,
  RelayDaemonFrameSchema,
  RelayLiveActivityFrameSchema,
  RelayPushFrameSchema,
  RelayPushResultFrameSchema,
  RelayPushTokenSchema,
  type RelayToDaemonFrame,
  RelayToDaemonFrameSchema,
  isInboundFrameTooLarge,
  isRelayDeviceAddress,
  isRelayErrorCode,
  isRelayFeature,
  isRelayId,
  isRelayPushFrame,
  isRelaySecret,
  isRelayUrl,
  knownRelayFeatures,
  relayAddress,
} from "../src/relay.ts";

describe("RELAY_PROTOCOL_VERSION", () => {
  test("is its own version, not the RPC protocol's", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
  });
});

describe("DEFAULT_RELAY_URL", () => {
  // Decision 9: ONE value, and this constant is the only place the domain
  // appears in code — the app hard-codes nothing (it learns addresses in the QR)
  // and `relay.url` overrides it.
  test("is the hosted relay, and is a valid relay URL", () => {
    expect(DEFAULT_RELAY_URL).toBe("wss://relay.tentacle.so");
    expect(isRelayUrl(DEFAULT_RELAY_URL)).toBe(true);
  });
});

describe("isRelayUrl", () => {
  test("accepts wss anywhere", () => {
    expect(isRelayUrl("wss://relay.tentacle.so")).toBe(true);
    expect(isRelayUrl("wss://relay.example:4443")).toBe(true);
    expect(isRelayUrl("wss://example.com/sub/path")).toBe(true);
  });

  test("accepts ws ONLY to a loopback host (dev and tests)", () => {
    expect(isRelayUrl("ws://127.0.0.1:4100")).toBe(true);
    expect(isRelayUrl("ws://127.0.0.1")).toBe(true);
    expect(isRelayUrl("ws://[::1]:4100")).toBe(true);
    expect(isRelayUrl("ws://localhost:4100")).toBe(true);
  });

  test("refuses ws to anything that is not loopback — the secret never crosses a network in clear", () => {
    expect(isRelayUrl("ws://relay.example")).toBe(false);
    expect(isRelayUrl("ws://192.168.1.5:4100")).toBe(false);
    expect(isRelayUrl("ws://relay.tentacle.so")).toBe(false);
    // A loopback-LOOKING name is not loopback.
    expect(isRelayUrl("ws://127.0.0.1.evil.example")).toBe(false);
    expect(isRelayUrl("ws://localhost.evil.example")).toBe(false);
  });

  test("refuses non-ws protocols, credentials, and empties", () => {
    expect(isRelayUrl("https://relay.tentacle.so")).toBe(false);
    expect(isRelayUrl("http://127.0.0.1:4100")).toBe(false);
    expect(isRelayUrl("")).toBe(false);
    expect(isRelayUrl("   ")).toBe(false);
    // A URL carrying userinfo would put a secret in an access log on the way.
    expect(isRelayUrl("wss://user:pass@relay.tentacle.so")).toBe(false);
    expect(isRelayUrl("not a url")).toBe(false);
  });

  test("refuses a query or fragment (the address is <url>/d/<id>/e2e)", () => {
    expect(isRelayUrl("wss://relay.tentacle.so?x=1")).toBe(false);
    expect(isRelayUrl("wss://relay.tentacle.so#x")).toBe(false);
  });
});

describe("relayAddress", () => {
  test("is <url>/d/<id>/e2e", () => {
    expect(relayAddress("wss://relay.tentacle.so", "WSbKVXnUw63XiNj5KDcKsU")).toBe(
      "wss://relay.tentacle.so/d/WSbKVXnUw63XiNj5KDcKsU/e2e",
    );
  });

  test("tolerates the trailing slash `relay.url` may carry", () => {
    expect(relayAddress("wss://relay.tentacle.so/", "WSbKVXnUw63XiNj5KDcKsU")).toBe(
      "wss://relay.tentacle.so/d/WSbKVXnUw63XiNj5KDcKsU/e2e",
    );
  });

  test("a base path is kept (a relay behind a prefix)", () => {
    expect(relayAddress("wss://example.com/relay", "WSbKVXnUw63XiNj5KDcKsU")).toBe(
      "wss://example.com/relay/d/WSbKVXnUw63XiNj5KDcKsU/e2e",
    );
  });

  test("the address it builds is one the app already accepts (no app update)", () => {
    // The whole reason the relay needs no app change: `isPairingAddress` takes
    // it. A `relayAddress` that drifted (a query, a trailing slash, an id with
    // padding) would silently make every relay QR undialable.
    for (const url of [
      "wss://relay.tentacle.so",
      "ws://127.0.0.1:4100",
      "wss://relay.example:4443",
    ]) {
      expect(isPairingAddress(relayAddress(url, "WSbKVXnUw63XiNj5KDcKsU"))).toBe(true);
    }
  });
});

describe("isRelayId", () => {
  test("is exactly RELAY_ID_LENGTH base64url characters", () => {
    expect(RELAY_ID_LENGTH).toBe(22);
    expect(isRelayId("WSbKVXnUw63XiNj5KDcKsU")).toBe(true);
    expect(isRelayId("WSbKVXnUw63XiNj5KDcKs")).toBe(false);
    expect(isRelayId("WSbKVXnUw63XiNj5KDcKsUU")).toBe(false);
    expect(isRelayId("")).toBe(false);
    // base64url only: a `+`/`/` or padding would break the URL path segment.
    expect(isRelayId("WSbKVXnUw63XiNj5KDcK+U")).toBe(false);
    expect(isRelayId("WSbKVXnUw63XiNj5KDcK.U")).toBe(false);
    expect(isRelayId("WSbKVXnUw63XiNj5KDcK=U")).toBe(false);
  });
});

describe("isRelayDeviceAddress", () => {
  const id = "WSbKVXnUw63XiNj5KDcKsU";

  test("tells a relay address from a DIRECT one (why it exists)", () => {
    // The whole point: `isPairingAddress` accepts both (the app dials both), so
    // only this predicate can order them "direct first, relay last".
    for (const direct of [
      "ws://192.168.1.8:4000/e2e",
      "wss://mac.tailnet.ts.net/e2e",
      "ws://[fd00::1]:4000/e2e",
    ]) {
      expect(isPairingAddress(direct)).toBe(true);
      expect(isRelayDeviceAddress(direct)).toBe(false);
    }
    expect(isRelayDeviceAddress(`wss://relay.tentacle.so/d/${id}/e2e`)).toBe(true);
  });

  test("what relayAddress builds is always one — including a base path", () => {
    for (const url of ["wss://relay.tentacle.so", "ws://127.0.0.1:4100"]) {
      expect(isRelayDeviceAddress(relayAddress(url, id))).toBe(true);
    }
    expect(isRelayDeviceAddress(`wss://example.com/relay/d/${id}/e2e`)).toBe(true);
  });

  test("a trailing slash or a query does not hide it", () => {
    expect(isRelayDeviceAddress(`wss://relay.tentacle.so/d/${id}/e2e/`)).toBe(true);
    expect(isRelayDeviceAddress(`wss://relay.tentacle.so/d/${id}/e2e?x=1`)).toBe(true);
  });

  test("a malformed id, a missing segment or a non-ws scheme is NOT one", () => {
    // `/d/notanid/e2e`, `/d/<id>/`, `/e2e` alone: a phone-shaped path is not enough.
    for (const bad of [
      "wss://relay.tentacle.so/d/short/e2e",
      `wss://relay.tentacle.so/d/${id}/`,
      `wss://relay.tentacle.so/${id}/e2e`,
      `https://relay.tentacle.so/d/${id}/e2e`,
      "",
    ]) {
      expect(isRelayDeviceAddress(bad)).toBe(false);
    }
  });
});

describe("control frames", () => {
  const hello: RelayDaemonFrame = { t: "hello", v: RELAY_PROTOCOL_VERSION, secret: "A".repeat(43) };
  const ready: RelayToDaemonFrame = {
    t: "ready",
    v: RELAY_PROTOCOL_VERSION,
    id: "WSbKVXnUw63XiNj5KDcKsU",
    features: [],
  };
  const error: RelayToDaemonFrame = { t: "error", code: "busy", supported: [1] };

  test("daemon → relay hello / accept round-trip", () => {
    expect(RelayDaemonFrameSchema.parse(hello)).toEqual(hello);
    expect(RelayDaemonFrameSchema.parse({ t: "accept", v: 1, stream: "s".repeat(22) })).toEqual({
      t: "accept",
      v: 1,
      stream: "s".repeat(22),
    });
    expect(RelayDaemonFrameSchema.parse({ t: "ping" })).toEqual({ t: "ping" });
    expect(RelayControlFrameSchema.parse(hello)).toEqual(hello);
  });

  test("relay → daemon ready / error / open / replaced / pong round-trip", () => {
    expect(RelayToDaemonFrameSchema.parse(ready)).toEqual(ready);
    expect(RelayToDaemonFrameSchema.parse(error)).toEqual(error);
    expect(
      RelayToDaemonFrameSchema.parse({ t: "open", stream: "s".repeat(22), ip: "1.2.3.4" }),
    ).toEqual({
      t: "open",
      stream: "s".repeat(22),
      ip: "1.2.3.4",
    });
    expect(RelayToDaemonFrameSchema.parse({ t: "replaced" })).toEqual({ t: "replaced" });
    expect(RelayToDaemonFrameSchema.parse({ t: "pong" })).toEqual({ t: "pong" });
  });

  test("an unknown FIELD is dropped (strip schemas: the relay may add one)", () => {
    expect(RelayToDaemonFrameSchema.parse({ t: "pong", later: 2 })).toEqual({ t: "pong" });
    expect(RelayDaemonFrameSchema.parse({ ...hello, later: true })).toEqual(hello);
  });

  test("an unknown `t` is refused: the discriminator is the shape", () => {
    // `push` used to be the example here; it is task 16's (P3, "push frames"
    // below), so the property is pinned with a tag no build knows — the point
    // is that an unmodelled frame is a close, never a guess.
    expect(RelayDaemonFrameSchema.safeParse({ t: "pushx", v: 1 }).success).toBe(false);
    expect(RelayToDaemonFrameSchema.safeParse({ t: "open_stream" }).success).toBe(false);
    expect(RelayControlFrameSchema.safeParse({ t: "nope" }).success).toBe(false);
    expect(RelayControlFrameSchema.safeParse(null).success).toBe(false);
  });

  test("every frame validates its own fields", () => {
    // A malformed frame is a close, not a guess (F19).
    expect(RelayDaemonFrameSchema.safeParse({ t: "hello", v: 1, secret: "short" }).success).toBe(
      false,
    );
    expect(
      RelayDaemonFrameSchema.safeParse({ t: "hello", v: 0, secret: "A".repeat(43) }).success,
    ).toBe(false);
    expect(RelayDaemonFrameSchema.safeParse({ t: "accept", v: 1, stream: "short" }).success).toBe(
      false,
    );
    expect(
      RelayToDaemonFrameSchema.safeParse({ t: "open", stream: "short", ip: "1.2.3.4" }).success,
    ).toBe(false);
    expect(
      RelayToDaemonFrameSchema.safeParse({ t: "ready", v: 1, id: "too-short", features: [] })
        .success,
    ).toBe(false);
    // `code` is bounded, not enumerated (review R1 finding 1): a non-string or an
    // unbounded value is refused, while an unknown NAME parses (see the dedicated
    // test above — a refusal, never "malformed frame").
    expect(RelayToDaemonFrameSchema.safeParse({ t: "error", code: "nonsense" }).success).toBe(
      false,
    );
    expect(
      RelayToDaemonFrameSchema.safeParse({ t: "error", code: "busy", supported: [0] }).success,
    ).toBe(false);
  });

  test("`ready.features` accepts a name this build does not know, and the known filter DROPS it", () => {
    // Review R1 finding 1 (HIGH). `features` exists (task 16 amendment) so a
    // later `push` frame never hits "unknown frame". A CLOSED enum defeats that:
    // a relay announcing a second feature would fail the whole `ready` parse, the
    // daemon drops the link and retries forever — every installed `serve` losing
    // relay reachability at once, with no version error and no notice. Fields are
    // free (AGENTS §7): unknown names are accepted by the parse, and a reader
    // filters them with `knownRelayFeatures`.
    const parsed = RelayToDaemonFrameSchema.parse({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
      features: ["push", "future"],
    });
    expect(parsed).toEqual({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
      features: ["push", "future"],
    });
    // An all-unknown list still parses: a newer relay must not be unreachable.
    const newer = RelayToDaemonFrameSchema.parse({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
      features: ["future", "later"],
    });
    if (newer.t !== "ready") throw new Error("expected ready");
    expect(knownRelayFeatures(newer.features)).toEqual([]);
    // …and the known one survives the filter, with duplicates collapsed.
    if (parsed.t !== "ready") throw new Error("expected ready");
    expect(knownRelayFeatures(parsed.features)).toEqual(["push"]);
    expect(knownRelayFeatures(["push", "push", "future"])).toEqual(["push"]);
    // The bound stays: a huge list is still refused (a close, not a guess).
    expect(
      RelayToDaemonFrameSchema.safeParse({
        t: "ready",
        v: 1,
        id: "WSbKVXnUw63XiNj5KDcKsU",
        features: Array.from({ length: 17 }, (_, i) => `f${i}`),
      }).success,
    ).toBe(false);
  });

  test("`error.code` accepts a code this build does not know (a refusal, not 'malformed')", () => {
    // Review R1 finding 1, second half. An error frame's job is to REFUSE
    // cleanly; a closed enum turned a newer relay's new code into "malformed
    // frame", which the daemon treats as a protocol violation instead of a
    // refusal. The known set stays a named constant for the notice and the doc.
    expect(RelayToDaemonFrameSchema.parse({ t: "error", code: "version", supported: [1] })).toEqual(
      {
        t: "error",
        code: "version",
        supported: [1],
      },
    );
    expect(
      RelayToDaemonFrameSchema.parse({ t: "error", code: "overloaded", supported: [2] }),
    ).toEqual({ t: "error", code: "overloaded", supported: [2] });
    expect(isRelayErrorCode("version")).toBe(true);
    expect(isRelayErrorCode("overloaded")).toBe(false);
    // A non-string / empty / oversized code is still refused: the field stays bounded.
    expect(
      RelayToDaemonFrameSchema.safeParse({ t: "error", code: 7, supported: [1] }).success,
    ).toBe(false);
    expect(
      RelayToDaemonFrameSchema.safeParse({ t: "error", code: "", supported: [1] }).success,
    ).toBe(false);
    expect(
      RelayToDaemonFrameSchema.safeParse({ t: "error", code: "x".repeat(33), supported: [1] })
        .success,
    ).toBe(false);
  });

  test("`ready` carries `features` from the start (task 16 amendment: a later `push` frame)", () => {
    // If `features` appeared later, a today-daemon would drop the unknown field
    // — fine — but the AMENDMENT's point is the daemon learns what the relay can
    // do without a second frame. It must be present and defaulted to [].
    expect(
      RelayToDaemonFrameSchema.parse({ t: "ready", v: 1, id: "WSbKVXnUw63XiNj5KDcKsU" }),
    ).toEqual({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
      features: [],
    });
  });
});

describe("RELAY_CONTROL_LIMITS", () => {
  test("pins the numbers the relay and the daemon both enforce", () => {
    // One source for both ends: an 87.4 Ki-char Noise frame must pass, a hostile
    // 97 KiB one must not (R0(a) proved 87 KiB splices intact; R0(b) proved a
    // Bun CLIENT has no inbound cap of its own before any handler runs).
    expect(RELAY_CONTROL_LIMITS.maxFrameChars).toBe(96 * 1024);
    expect(RELAY_CONTROL_LIMITS.phoneHoldMs).toBe(RELAY_STREAM_HOLD_MS);
    expect(RELAY_STREAM_HOLD_MS).toBe(5_000);
    expect(RELAY_CONTROL_LIMITS.preAcceptBytes).toBe(64 * 1024);
    expect(RELAY_CONTROL_LIMITS.backpressureBytes).toBe(16 * 1024 * 1024);
    // A 128-bit stream token is 22 base64url chars, and it dies 10 s after minting.
    expect(RELAY_STREAM_TEXT_LENGTH).toBe(22);
    expect(RELAY_STREAM_EXPIRY_MS).toBe(10_000);
    expect(RELAY_CLOSE_UNREGISTERED).toBe(4404);
  });

  test("the decode guard is ABOVE the Noise cap and below what R0(b) proved reachable", () => {
    // The guard brackets the JSON/zod parse and the channel's copy — a legitimate
    // worst-case frame must pass, so it sits above the Noise channel's own inbound
    // cap (~87.4 Ki chars) with room (the cap is 2×). It bounds COST, not memory:
    // see `isInboundFrameTooLarge`'s doc comment and F7.
    expect(RELAY_CONTROL_LIMITS.maxInboundChars).toBeGreaterThan(
      RELAY_CONTROL_LIMITS.maxFrameChars,
    );
    expect(RELAY_CONTROL_LIMITS.maxInboundChars).toBeLessThan(64 * 1024 * 1024);
  });
});

describe("isInboundFrameTooLarge (the decode cost guard)", () => {
  test("passes a legitimate worst-case frame and refuses a hostile one", () => {
    // R0(b) measured the gap this guard does NOT close: a Bun WebSocket CLIENT
    // accepted a 64 MiB frame and turned it into a JS string (~135 MiB RSS) before
    // any handler ran, so memory is spent before this is asked. It gates the work
    // after the socket (JSON/zod, the channel copy) — hence "decode", not "allocate".
    expect(isInboundFrameTooLarge("x".repeat(87 * 1024))).toBe(false);
    expect(isInboundFrameTooLarge("x".repeat(RELAY_CONTROL_LIMITS.maxInboundChars))).toBe(false);
    expect(isInboundFrameTooLarge("x".repeat(RELAY_CONTROL_LIMITS.maxInboundChars + 1))).toBe(true);
    expect(isInboundFrameTooLarge(new Uint8Array(RELAY_CONTROL_LIMITS.maxInboundChars + 1))).toBe(
      true,
    );
    // A Uint8Array is measured in BYTES, a string in code units: both are what the
    // socket hands over, and neither is re-encoded here.
    expect(isInboundFrameTooLarge(new Uint8Array(RELAY_CONTROL_LIMITS.maxInboundChars))).toBe(
      false,
    );
    expect(isInboundFrameTooLarge("")).toBe(false);
  });
});

describe("secrets", () => {
  test("isRelaySecret refuses anything that is not 43 base64url chars", () => {
    expect(isRelaySecret("A".repeat(43))).toBe(true);
    expect(isRelaySecret("A".repeat(44))).toBe(false);
    expect(isRelaySecret("A".repeat(42))).toBe(false);
    expect(isRelaySecret("")).toBe(false);
    expect(isRelaySecret(`${"A".repeat(42)}=`)).toBe(false);
    expect(isRelaySecret(`${"A".repeat(42)}+`)).toBe(false);
  });
});

// --- push frames (docs/feat/mobile-push.md P3, the amendment to R1) --------

/**
 * The relay's PUSH frames: `push` (daemon → relay) and `push-result`
 * (relay → daemon). `ready.features` already exists (R1 landed it), so this
 * slice adds only the two frames — the plan's "skip `features` if R1 has it".
 *
 * The properties that carry it:
 *  - a `push` may only travel to a relay that ANNOUNCED `"push"`; otherwise R2's
 *    relay closes the control socket on an unknown frame (C1) and the daemon
 *    reconnect-loops forever. The gate itself is the daemon's (P8) — this wire
 *    makes the frame expressible, and `isRelayPushFrame` the test it gates on;
 *  - the payload carries the SEALED envelope and nothing else: no `aps` (the
 *    relay's own template, P4), no plaintext;
 *  - the frame is bounded well under the control limits, so a hostile daemon
 *    cannot make the relay allocate an arbitrary string.
 */
describe("push frames", () => {
  const envelope = (): PushEnvelope => ({
    v: 1,
    k: "k".repeat(PUSH_KID_LENGTH),
    e: "e".repeat(PUSH_ENC_TEXT_LENGTH),
    c: "c".repeat(PUSH_ENVELOPE_CIPHERTEXT_LENGTHS[0] ?? 704),
  });
  const push = (over: Record<string, unknown> = {}) => ({
    t: "push" as const,
    n: 1,
    token: "a".repeat(64),
    env: "sandbox" as const,
    collapse: "collapse-1",
    ttl: 3600,
    payload: { tp: envelope() },
    ...over,
  });

  test('`"push"` is the feature that gates them (announced only with an APNs key)', () => {
    expect(isRelayFeature("push")).toBe(true);
    expect(isRelayFeature("streams")).toBe(false);
    // A relay WITHOUT an APNs key announces nothing (P4), and the daemon then
    // never builds a `push` frame at all (F4/C1).
    const withoutKey = RelayToDaemonFrameSchema.parse({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
      features: [],
    });
    expect(withoutKey.t === "ready" && withoutKey.features).toEqual([]);
    // `features` ABSENT ≡ `[]` (the plan's P3 test): an older relay that never
    // learned the field is a relay with no push, not a malformed `ready`.
    const absent = RelayToDaemonFrameSchema.parse({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
    });
    expect(absent).toEqual(withoutKey);
    expect(absent.t === "ready" && knownRelayFeatures(absent.features)).toEqual([]);
    // …and with `"push"` announced, the gate OPENS: the daemon may send one.
    const withPush = RelayToDaemonFrameSchema.parse({
      t: "ready",
      v: 1,
      id: "WSbKVXnUw63XiNj5KDcKsU",
      features: ["push"],
    });
    expect(withPush.t === "ready" && knownRelayFeatures(withPush.features)).toEqual(["push"]);
    expect(isRelayPushFrame(push())).toBe(true);
  });

  test("daemon → relay `push` round-trips through both unions", () => {
    const frame = push();
    expect(RelayPushFrameSchema.parse(frame)).toEqual(frame);
    expect(RelayDaemonFrameSchema.parse(frame)).toEqual(frame);
    expect(RelayControlFrameSchema.parse(frame)).toEqual(frame);
  });

  test("an unknown field is stripped; `aps` and clear text are NOT fields at all", () => {
    // The relay builds `aps` from its own template, so a daemon that tries to
    // supply one (or a plaintext body) has it dropped by the parse: the envelope
    // is the only content that crosses (Design 3, F9). Checked at BOTH levels —
    // `payload.aps` is the tempting place, because that is exactly where an APNs
    // payload keeps its banner text (mutation M8: add `aps` to the payload
    // schema and this fails).
    const parsed = RelayPushFrameSchema.parse({
      ...push(),
      future: 1,
      aps: { alert: "plaintext a banner would show without opening the seal" },
      body: "same",
    });
    expect(parsed).toEqual(push());
    expect("aps" in parsed).toBe(false);
    expect("body" in parsed).toBe(false);
    const nested = RelayPushFrameSchema.parse({
      ...push(),
      payload: { tp: envelope(), aps: { alert: "banner text the relay never authorised" } },
    });
    expect(nested.payload).toEqual({ tp: envelope() });
    expect("aps" in nested.payload).toBe(false);
  });

  test("every field is validated, so a malformed frame is a close (never a guess)", () => {
    // `n` is the daemon's per-socket counter: a non-negative integer, matched
    // against the `push-result` that answers it.
    expect(RelayPushFrameSchema.safeParse(push({ n: 0 })).success).toBe(true);
    expect(RelayPushFrameSchema.safeParse(push({ n: -1 })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ n: 1.5 })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ n: "1" })).success).toBe(false);
    // The token is a device's raw APNs token: the SAME rule as
    // `device/push_register` (P2), so a token the daemon accepted can never make
    // the relay refuse the frame.
    expect(RelayPushFrameSchema.safeParse(push({ token: "A".repeat(64) })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ token: "a".repeat(200) })).success).toBe(true);
    expect(RelayPushFrameSchema.safeParse(push({ token: "a".repeat(201) })).success).toBe(false);
    // The environment picks an APNs host, so it is closed.
    expect(RelayPushFrameSchema.safeParse(push({ env: "staging" })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ env: "production" })).success).toBe(true);
    // The collapse id is an `apns-collapse-id` HEADER value: bounded by BYTES,
    // and header-safe (no `"`, no control character).
    expect(RelayPushFrameSchema.safeParse(push({ collapse: "" })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ collapse: "x".repeat(64) })).success).toBe(true);
    expect(RelayPushFrameSchema.safeParse(push({ collapse: "x".repeat(65) })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ collapse: 'a"b' })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ collapse: "a\u0000b" })).success).toBe(false);
    // The TTL is `apns-expiration`: seconds, and Apple's own maximum is a day.
    expect(RelayPushFrameSchema.safeParse(push({ ttl: 0 })).success).toBe(true);
    expect(RelayPushFrameSchema.safeParse(push({ ttl: 86_400 })).success).toBe(true);
    expect(RelayPushFrameSchema.safeParse(push({ ttl: 86_401 })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ ttl: -1 })).success).toBe(false);
    // The payload is `{tp: <P2 envelope>}`, with the envelope's own bounds.
    expect(RelayPushFrameSchema.safeParse(push({ payload: {} })).success).toBe(false);
    expect(RelayPushFrameSchema.safeParse(push({ payload: undefined })).success).toBe(false);
    expect(
      RelayPushFrameSchema.safeParse({
        ...push(),
        payload: { tp: { ...envelope(), c: "c".repeat(703) } },
      }).success,
    ).toBe(false);
    // A collapse id the daemon's own helper produced always fits.
    expect(RelayCollapseIdSchema.safeParse(pushCollapseIdOf("s1", "r1")).success).toBe(true);
    expect(
      RelayCollapseIdSchema.safeParse(pushCollapseIdOf("x".repeat(4096), "y".repeat(4096))).success,
    ).toBe(true);
    expect(RelayPushTokenSchema.safeParse("a".repeat(64)).success).toBe(true);
    expect(RelayPushTokenSchema.safeParse(`${"a".repeat(63)}Z`).success).toBe(false);
  });

  test("the token and collapse-id schemas agree with `device/push_register` (one rule, two layers)", () => {
    // The relay parses its own frame (it must not load the RPC schemas), so the
    // token rule is duplicated; this pins the two together on a shared sample
    // (mutation M9: loosen the relay's regex → this fails).
    for (const [token, ok] of [
      ["a".repeat(64), true],
      ["a".repeat(200), true],
      [`${"a".repeat(63)}Z`, false],
      ["a".repeat(201), false],
    ] as const) {
      expect({ token: token.length, ok: RelayPushTokenSchema.safeParse(token).success }).toEqual({
        token: token.length,
        ok,
      });
      expect(
        DevicePushRegisterParamsSchema.safeParse({ token, env: "sandbox", key: "k".repeat(43) })
          .success,
      ).toBe(ok);
    }
  });

  test("the worst legitimate frame stays far under the control limits", () => {
    // The biggest thing the daemon can send: a 2752-char ciphertext plus the
    // ticket fields. It must never approach `maxFrameChars`, or a legitimate
    // push would trip the very oversize guard the relay applies to frames.
    const worst = push({
      token: "a".repeat(200),
      collapse: "x".repeat(PUSH_COLLAPSE_ID_MAX),
      payload: { tp: { ...envelope(), c: "c".repeat(2752) } },
    });
    expect(JSON.stringify(worst).length).toBeLessThan(RELAY_CONTROL_LIMITS.maxFrameChars / 4);
    expect(RelayPushFrameSchema.safeParse(worst).success).toBe(true);
  });

  test("relay → daemon `push-result` round-trips, with the five statuses", () => {
    for (const status of PUSH_DELIVERY_STATUSES) {
      const frame = { t: "push-result" as const, n: 3, status };
      expect(RelayPushResultFrameSchema.parse(frame)).toEqual(frame);
      expect(RelayToDaemonFrameSchema.parse(frame)).toEqual(frame);
      expect(RelayControlFrameSchema.parse(frame)).toEqual(frame);
      expect(isPushDeliveryStatus(status)).toBe(true);
    }
    expect(RelayToDaemonFrameSchema.safeParse({ t: "push-result", n: 1 }).success).toBe(false);
  });

  test("an unknown `status` PARSES but is not a known one (never a closed socket)", () => {
    // The property that matters on a shared control socket: one word this build
    // does not know must cost ONE push, not the link. A closed enum would make
    // the whole `push-result` a "malformed frame" → close → reconnect-loop
    // (exactly the mistake R1 review finding 1 fixed for `error.code`).
    const parsed = RelayToDaemonFrameSchema.parse({ t: "push-result", n: 1, status: "delivered" });
    expect(parsed).toEqual({ t: "push-result", n: 1, status: "delivered" });
    // …and the daemon refuses the VALUE: an unknown status is not a delivery.
    expect(isPushDeliveryStatus("delivered")).toBe(false);
    expect(isPushDeliveryStatus("gone")).toBe(true);
    expect(PUSH_DELIVERY_STATUSES).toEqual([
      "sent",
      "gone",
      "rejected",
      "throttled",
      "unavailable",
    ]);
    // The bound stays: a huge or empty status is still refused.
    expect(
      RelayPushResultFrameSchema.safeParse({ t: "push-result", n: 1, status: "" }).success,
    ).toBe(false);
    expect(
      RelayPushResultFrameSchema.safeParse({ t: "push-result", n: 1, status: "x".repeat(33) })
        .success,
    ).toBe(false);
  });

  test("`reason` is a bounded free string (a newer relay's detail never fails the parse)", () => {
    // Same rule as `error.code` (R1 review finding 1): the field exists so the
    // daemon can audit WHY, so a closed enum would turn a new detail into
    // "malformed frame" — a protocol violation instead of a result.
    expect(
      RelayPushResultFrameSchema.parse({ t: "push-result", n: 1, status: "rejected", reason: "x" }),
    ).toEqual({ t: "push-result", n: 1, status: "rejected", reason: "x" });
    expect(
      RelayPushResultFrameSchema.safeParse({
        t: "push-result",
        n: 1,
        status: "rejected",
        reason: "x".repeat(65),
      }).success,
    ).toBe(false);
    // Optional: `sent` has nothing to explain.
    expect(RelayPushResultFrameSchema.parse({ t: "push-result", n: 1, status: "sent" })).toEqual({
      t: "push-result",
      n: 1,
      status: "sent",
    });
  });

  test("`n` correlation implies no ORDER: two results are independent", () => {
    // The daemon matches on `n`, so out-of-order replies are legal (Design 3:
    // "responses can arrive out of order") — nothing in the shape sequences them.
    expect(RelayPushResultFrameSchema.parse({ t: "push-result", n: 2, status: "sent" }).n).toBe(2);
    expect(RelayPushResultFrameSchema.parse({ t: "push-result", n: 1, status: "gone" }).n).toBe(1);
  });
});

// --- Live Activity frames (docs/feat/mobile-live-activity.md Design 4, L3) ---
/**
 * The relay carries an activity exactly as it carries a push: one sealed blob
 * plus the CLEAR fields ActivityKit needs. Three rules, each a test below:
 *
 *  - the `liveactivity` frame is gated by a feature name, so an older relay
 *    never sees an unknown frame (R2 closes the socket on one);
 *  - the CLEAR part (`la`) is a fixed, bounded template — event, timestamp,
 *    dates, sealed state, attributes — with no field a daemon could turn into
 *    content (F5);
 *  - a push frame is still a push: the two cannot be confused, because `t`
 *    discriminates them and neither schema accepts the other's shape.
 */
describe("live activity frames", () => {
  const state = { v: 1 as const, e: "A".repeat(43), c: "B".repeat(704) };
  const attributes = { v: 1 as const, k: "tzHqlSe8ME5A", slot: "00112233445566778899aabb" };

  const start = (over: Record<string, unknown> = {}) => ({
    t: "liveactivity" as const,
    n: 1,
    token: "a".repeat(64),
    env: "sandbox" as const,
    priority: 10 as const,
    la: {
      event: "start" as const,
      timestamp: 1_731_000_000,
      staleDate: 1_731_000_900,
      contentState: state,
      attributes,
    },
    ...over,
  });

  test('`"liveactivity"` is the feature that gates the frame (only with an APNs key)', () => {
    expect(isRelayFeature("liveactivity")).toBe(true);
    expect(knownRelayFeatures(["liveactivity"])).toEqual(["liveactivity"]);
    // An older relay announces only "push": the daemon must send no LA frame then.
    expect(knownRelayFeatures(["push"])).toEqual(["push"]);
    expect(knownRelayFeatures(["push", "liveactivity"])).toEqual(["push", "liveactivity"]);
  });

  test("a start frame round-trips (the push-to-start: attributes + a sealed state)", () => {
    const parsed = RelayLiveActivityFrameSchema.parse(start());
    expect(parsed.la.event).toBe("start");
    expect(parsed.la.attributes).toEqual(attributes);
    expect(parsed.la.contentState).toEqual(state);
    expect(parsed.priority).toBe(10);
  });

  test("an update frame needs no attributes (the activity already exists)", () => {
    const update = start({
      la: { event: "update", timestamp: 1_731_000_100, contentState: state },
    });
    const parsed = RelayLiveActivityFrameSchema.parse(update);
    expect(parsed.la.attributes).toBeUndefined();
    expect(parsed.la.event).toBe("update");
  });

  test("an end frame carries a dismissal date and no state", () => {
    const end = start({
      la: { event: "end", timestamp: 1_731_000_200, dismissalDate: 1_731_000_500 },
    });
    const parsed = RelayLiveActivityFrameSchema.parse(end);
    expect(parsed.la.event).toBe("end");
    expect(parsed.la.contentState).toBeUndefined();
  });

  test("every event is accepted, an unknown one is refused", () => {
    for (const event of ["start", "update", "end"]) {
      expect(
        RelayLiveActivityFrameSchema.safeParse(start({ la: { event, timestamp: 1 } })).success,
      ).toBe(true);
    }
    expect(
      RelayLiveActivityFrameSchema.safeParse(start({ la: { event: "wake", timestamp: 1 } }))
        .success,
    ).toBe(false);
  });

  test("priority is only 5 or 10 — Apple's two, and nothing else", () => {
    expect(RelayLiveActivityFrameSchema.safeParse(start({ priority: 5 })).success).toBe(true);
    expect(RelayLiveActivityFrameSchema.safeParse(start({ priority: 10 })).success).toBe(true);
    expect(RelayLiveActivityFrameSchema.safeParse(start({ priority: 9 })).success).toBe(false);
    expect(RelayLiveActivityFrameSchema.safeParse(start({ priority: 0 })).success).toBe(false);
  });

  test("the clear part cannot carry content: an unknown `la` field is STRIPPED", () => {
    // F5: a daemon (or anything downstream) must not be able to put a title in
    // the clear fields the relay and Apple read.
    const parsed = RelayLiveActivityFrameSchema.parse(
      start({ la: { event: "update", timestamp: 1, contentState: state, title: "secret" } }),
    );
    expect(parsed.la).not.toHaveProperty("title");
  });

  test("a frame that is a push still parses as a push, and neither accepts the other", () => {
    const la = start();
    // A `liveactivity` frame is NOT a push: it has no `payload`/`collapse`/`ttl`.
    expect(RelayPushFrameSchema.safeParse(la).success).toBe(false);
    // And a push is not an LA frame: it has no `la` and `t` differs.
    const push = {
      t: "push",
      n: 1,
      token: "a".repeat(64),
      env: "sandbox",
      collapse: "abc",
      ttl: 60,
      payload: { tp: { v: 1, k: "tzHqlSe8ME5A", e: "A".repeat(43), c: "B".repeat(704) } },
    };
    expect(RelayPushFrameSchema.safeParse(push).success).toBe(true);
    expect(RelayLiveActivityFrameSchema.safeParse(push).success).toBe(false);
  });

  test("both frames are in the daemon's union, so the relay parses them one way", () => {
    const parsed = RelayDaemonFrameSchema.parse(start());
    expect(parsed.t).toBe("liveactivity");
    // An unknown `t` is still rejected (the union is not "anything goes").
    expect(RelayDaemonFrameSchema.safeParse({ t: "liveactivityx", n: 1 }).success).toBe(false);
  });

  test("a bad token, slot, env or ciphertext length is refused (F25)", () => {
    expect(RelayLiveActivityFrameSchema.safeParse(start({ token: "zz" })).success).toBe(false);
    expect(RelayLiveActivityFrameSchema.safeParse(start({ env: "moon" })).success).toBe(false);
    expect(
      RelayLiveActivityFrameSchema.safeParse(
        start({
          la: {
            event: "update",
            timestamp: 1,
            contentState: { v: 1, e: "A".repeat(43), c: "B".repeat(2752) },
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      RelayLiveActivityFrameSchema.safeParse(
        start({
          la: {
            event: "start",
            timestamp: 1,
            contentState: state,
            attributes: { v: 1, k: "short", slot: "00112233445566778899aabb" },
          },
        }),
      ).success,
    ).toBe(false);
  });
});
