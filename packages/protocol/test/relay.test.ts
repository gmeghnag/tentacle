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
  DEFAULT_RELAY_URL,
  RELAY_CLOSE_UNREGISTERED,
  RELAY_CONTROL_LIMITS,
  RELAY_ID_LENGTH,
  RELAY_PROTOCOL_VERSION,
  RELAY_SECRET_TEXT_LENGTH,
  RELAY_STREAM_EXPIRY_MS,
  RELAY_STREAM_HOLD_MS,
  RELAY_STREAM_TEXT_LENGTH,
  RelayControlFrameSchema,
  type RelayDaemonFrame,
  RelayDaemonFrameSchema,
  type RelayToDaemonFrame,
  RelayToDaemonFrameSchema,
  isInboundFrameTooLarge,
  isRelayErrorCode,
  isRelayFeature,
  isRelayId,
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
    expect(RelayDaemonFrameSchema.safeParse({ t: "push", v: 1 }).success).toBe(false);
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
