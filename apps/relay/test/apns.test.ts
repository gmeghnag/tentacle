import { describe, expect, test } from "bun:test";
import { PUSH_ENVELOPE_CIPHERTEXT_LENGTHS, isPushDeliveryStatus } from "@tentacle/protocol";
import {
  APNS_APS_TEMPLATE,
  APNS_DEFAULT_ORIGINS,
  APNS_JWT_REUSE_MS,
  APNS_MAX_PAYLOAD_BYTES,
  APNS_TIMEOUT_OUTCOME,
  apnsOutcomeOf,
  apnsPayloadBytesOf,
  apnsPayloadOf,
  apnsRequestOf,
  clipApnsReason,
  createApnsJwtSource,
  decodeApnsKeyPem,
  readApnsKeySource,
} from "../src/apns.ts";

/** A sealed envelope at one of the three legal sizes (the daemon's own output shape). */
function envelope(ciphertextLength = PUSH_ENVELOPE_CIPHERTEXT_LENGTHS[0] ?? 704) {
  return {
    v: 1 as const,
    k: "A".repeat(12),
    e: "B".repeat(43),
    c: "C".repeat(ciphertextLength),
  };
}

/** A P-256 key pair as Apple's `.p8` hands us one (PKCS#8, sign-only). */
async function p256(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; der: Uint8Array }> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const imported = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { privateKey: imported, publicKey: pair.publicKey, der };
}

const CONFIG = { keyId: "ABC123DEFG", teamId: "TEAM123456", topic: "so.tentacle.app" };

function decode(text: string): unknown {
  return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
}

describe("the aps template — the one banner a daemon cannot influence", () => {
  test("every payload carries the relay's own alert, whatever the daemon sent", () => {
    const body = JSON.parse(apnsPayloadOf({ tp: envelope() }));
    expect(body.aps).toEqual({
      alert: { title: "tentacle", body: "Open tentacle to see what's new" },
      "mutable-content": 1,
      sound: "default",
    });
    expect(body.tp.v).toBe(1);
  });

  test("a daemon-supplied `aps` is STRIPPED, so no plaintext can reach a banner", () => {
    // The boundary F9 rests on: the only text iOS can show is the template above,
    // unless the extension opens the seal. A daemon that puts an `aps` in its
    // payload is not an error, it is simply ignored.
    const hostile = {
      tp: envelope(),
      aps: { alert: { title: "Approved: rm -rf /", body: "tap to continue" } },
    };
    const body = JSON.parse(apnsPayloadOf(hostile));
    expect(body.aps).toEqual(APNS_APS_TEMPLATE);
    expect(JSON.stringify(body)).not.toContain("rm -rf");
    expect(Object.keys(body).sort()).toEqual(["aps", "tp"]);
  });

  test("a payload that is not `{tp}` is refused rather than sent", () => {
    expect(() => apnsPayloadOf({})).toThrow();
    expect(() => apnsPayloadOf({ tp: { v: 2, k: "A".repeat(12) } })).toThrow();
  });

  test("the largest legal envelope still fits Apple's 4096-byte body", () => {
    const smallest = PUSH_ENVELOPE_CIPHERTEXT_LENGTHS.reduce((a, b) => Math.min(a, b));
    const biggest = PUSH_ENVELOPE_CIPHERTEXT_LENGTHS.reduce((a, b) => Math.max(a, b));
    const largest = apnsPayloadBytesOf({ tp: envelope(biggest) });
    expect(largest).toBeLessThanOrEqual(APNS_MAX_PAYLOAD_BYTES);
    // The measurement is of THIS payload, not a constant: the small envelope
    // measures strictly smaller (so a byte count that ignored the ciphertext
    // would fail here), and the three wire sizes are the ones P1 seals.
    expect(apnsPayloadBytesOf({ tp: envelope(smallest) })).toBeLessThan(largest);
    expect(PUSH_ENVELOPE_CIPHERTEXT_LENGTHS).toHaveLength(3);
  });
});

describe("apnsRequestOf — the request Apple expects", () => {
  test("the headers, the device path and the expiry derived from the clock", () => {
    const request = apnsRequestOf({
      token: "d".repeat(64),
      collapse: "collapse-1",
      ttl: 3600,
      topic: CONFIG.topic,
      jwt: "header.claims.signature",
      now: 1_700_000_000_000,
    });
    expect(request.path).toBe(`/3/device/${"d".repeat(64)}`);
    expect(request.headers).toEqual({
      ":method": "POST",
      ":path": request.path,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": CONFIG.topic,
      // 1_700_000_000 s + 1 h, in seconds (Apple's `apns-expiration`).
      "apns-expiration": String(1_700_000_000 + 3600),
      "apns-collapse-id": "collapse-1",
      authorization: "bearer header.claims.signature",
    });
  });

  test("the topic is the config's, never anything a daemon sent", () => {
    // The daemon cannot supply a topic at all (P3's frame has no such field), so
    // the only way to change it is the relay's own `--apns-topic`.
    const request = apnsRequestOf({
      token: "d".repeat(64),
      collapse: "c",
      ttl: 0,
      topic: "com.example.other",
      jwt: "j",
      now: 0,
    });
    expect(request.headers["apns-topic"]).toBe("com.example.other");
    expect(JSON.stringify(request.headers)).not.toContain(CONFIG.topic);
  });
});

describe("createApnsJwtSource — the provider token and its cache", () => {
  test("the claims and header Apple wants, signed with ES256 over the PKCS#8 key", async () => {
    const { privateKey, publicKey } = await p256();
    const source = createApnsJwtSource({
      config: CONFIG,
      key: privateKey,
      now: () => 1_700_000_000_000,
    });
    const jwt = await source.jwt();
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header ?? "")).toEqual({ alg: "ES256", kid: CONFIG.keyId });
    expect(decode(claims ?? "")).toEqual({ iss: CONFIG.teamId, iat: 1_700_000_000 });
    // The raw 64-byte r‖s APNs requires (P0(c): not DER).
    expect(Buffer.from(signature ?? "", "base64url")).toHaveLength(64);
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(signature ?? "", "base64url"),
      new TextEncoder().encode(`${header}.${claims}`),
    );
    expect(valid).toBe(true);
  });

  test("reused at 39 minutes, re-minted at 40 (an injected clock, not a wait)", async () => {
    const { privateKey } = await p256();
    let at = 1_700_000_000_000;
    const source = createApnsJwtSource({ config: CONFIG, key: privateKey, now: () => at });
    const first = await source.jwt();
    at += APNS_JWT_REUSE_MS - 60_000;
    expect(await source.jwt()).toBe(first);
    // The boundary itself (40 min) mints a new one: Apple refuses a token minted
    // more often than once per 20 min, and accepts one for at most 60.
    at += 60_000;
    const second = await source.jwt();
    expect(second).not.toBe(first);
    expect(decode(second.split(".")[1] ?? "")).toEqual({
      iss: CONFIG.teamId,
      iat: 1_700_000_000 + 2400,
    });
  });

  test("invalidate() forces a fresh token (Apple's `ExpiredProviderToken`)", async () => {
    const { privateKey } = await p256();
    const source = createApnsJwtSource({
      config: CONFIG,
      key: privateKey,
      now: () => 1_700_000_000_000,
    });
    const first = await source.jwt();
    source.invalidate();
    expect(await source.jwt()).not.toBe(first);
  });

  test("concurrent calls mint ONE token (finding 2: a cold cache is not a storm)", async () => {
    // `crypto.subtle.sign` is async, so a cache checked only BEFORE the await
    // minted once per concurrent push. Apple answers frequent token changes with
    // a 429 `TooManyProviderTokenUpdates`, throttling the pushes this cache exists
    // to carry (F15: never a storm). Four callers on a cold cache share ONE
    // mint: one token, and the same token a later call returns.
    const { privateKey } = await p256();
    const source = createApnsJwtSource({
      config: CONFIG,
      key: privateKey,
      now: () => 1_700_000_000_000,
    });
    const burst = await Promise.all([source.jwt(), source.jwt(), source.jwt(), source.jwt()]);
    expect(new Set(burst).size).toBe(1);
    expect(await source.jwt()).toBe(burst[0]);
  });

  test("invalidate(staleJwt) does not drop a token a sibling already replaced", async () => {
    // The other half of finding 2: an `ExpiredProviderToken` burst reaches every
    // in-flight push with the SAME stale JWT. If each wiped the cache on its way
    // back, the fresh token a sibling minted would be thrown away and the relay
    // would mint once per push. Only the token that failed may be dropped.
    const { privateKey } = await p256();
    const source = createApnsJwtSource({
      config: CONFIG,
      key: privateKey,
      now: () => 1_700_000_000_000,
    });
    const stale = await source.jwt();
    source.invalidate(stale);
    const fresh = await source.jwt();
    expect(fresh).not.toBe(stale);
    // A laggard push, still holding `stale`, reports its own failure late.
    source.invalidate(stale);
    expect(await source.jwt()).toBe(fresh);
    // The token that IS current is still droppable.
    source.invalidate(fresh);
    expect(await source.jwt()).not.toBe(fresh);
  });

  test("a mint that fails does not wedge the cache (the next call tries again)", async () => {
    // The in-flight promise is cleared in a `finally`: a rejected mint must not
    // leave every later caller awaiting the same dead promise. A clock that throws
    // once is how a REAL key produces a failed mint (as a transient WebCrypto
    // error would).
    const { privateKey } = await p256();
    let boom = true;
    const source = createApnsJwtSource({
      config: CONFIG,
      key: privateKey,
      now: () => {
        if (boom) {
          throw new Error("clock is down");
        }
        return 1_700_000_000_000;
      },
    });
    await expect(source.jwt()).rejects.toThrow("clock is down");
    boom = false;
    // A real mint, not the dead promise: three JWT segments.
    expect((await source.jwt()).split(".")).toHaveLength(3);
  });
});

describe("apnsOutcomeOf — the status table", () => {
  test("200 → sent, with no reason to audit", () => {
    expect(apnsOutcomeOf({ status: 200 })).toEqual({ status: "sent" });
  });

  test("410 and a 400 BadDeviceToken/DeviceTokenNotForTopic → gone", () => {
    // `gone` is the only status the DAEMON acts on (it deletes that registration),
    // so each of Apple's three "this token is dead" answers must map to it.
    expect(apnsOutcomeOf({ status: 410 })).toEqual({ status: "gone" });
    expect(apnsOutcomeOf({ status: 400, reason: "BadDeviceToken" })).toEqual({
      status: "gone",
      reason: "BadDeviceToken",
    });
    expect(apnsOutcomeOf({ status: 400, reason: "DeviceTokenNotForTopic" })).toEqual({
      status: "gone",
      reason: "DeviceTokenNotForTopic",
    });
  });

  test("429 → throttled", () => {
    expect(apnsOutcomeOf({ status: 429 }).status).toBe("throttled");
  });

  test("another 4xx → rejected + reason", () => {
    expect(apnsOutcomeOf({ status: 400, reason: "BadCollapseId" })).toEqual({
      status: "rejected",
      reason: "BadCollapseId",
    });
    expect(apnsOutcomeOf({ status: 413, reason: "PayloadTooLarge" })).toEqual({
      status: "rejected",
      reason: "PayloadTooLarge",
    });
    expect(apnsOutcomeOf({ status: 403, reason: "InvalidProviderToken" })).toEqual({
      status: "rejected",
      reason: "InvalidProviderToken",
    });
  });

  test("403 ExpiredProviderToken asks for exactly one retry", () => {
    expect(apnsOutcomeOf({ status: 403, reason: "ExpiredProviderToken" })).toEqual({
      status: "rejected",
      reason: "ExpiredProviderToken",
      retry: true,
    });
    // Every other answer leaves `retry` unset: a push is best-effort, and a
    // retrying relay is a request storm (F15).
    for (const outcome of [
      apnsOutcomeOf({ status: 200 }),
      apnsOutcomeOf({ status: 410 }),
      apnsOutcomeOf({ status: 429 }),
      apnsOutcomeOf({ status: 500 }),
    ]) {
      expect(outcome.retry).toBeUndefined();
    }
  });

  test("5xx and a timeout → unavailable", () => {
    expect(apnsOutcomeOf({ status: 500 })).toEqual({ status: "unavailable" });
    expect(apnsOutcomeOf({ status: 503, reason: "ServiceUnavailable" })).toEqual({
      status: "unavailable",
      reason: "ServiceUnavailable",
    });
    expect(apnsOutcomeOf({ status: 0 })).toEqual({ status: "unavailable" });
    expect(APNS_TIMEOUT_OUTCOME).toEqual({ status: "unavailable", reason: "timeout" });
    expect(isPushDeliveryStatus(APNS_TIMEOUT_OUTCOME.status)).toBe(true);
  });

  test("every outcome is a status the daemon's vocabulary knows", () => {
    for (const status of [200, 400, 403, 410, 413, 429, 500, 503, 0]) {
      expect(isPushDeliveryStatus(apnsOutcomeOf({ status }).status)).toBe(true);
    }
  });

  test("a reason is clipped to a header-safe, bounded word (it goes in a frame)", () => {
    expect(clipApnsReason("Bad Device Token\n")).toBe("BadDeviceToken");
    expect(clipApnsReason("x".repeat(200))).toHaveLength(64);
    expect(clipApnsReason("!!!")).toBe("unknown");
    expect(apnsOutcomeOf({ status: 400, reason: `a".repeat(200)` }).reason?.length).toBeLessThan(
      65,
    );
  });
});

describe("APNS_DEFAULT_ORIGINS", () => {
  test("sandbox and production are the right way round", () => {
    // Swapping them would send sandbox tokens to production: every push silently
    // dropped, and nothing else in the suite would notice.
    expect(APNS_DEFAULT_ORIGINS.sandbox).toBe("https://api.sandbox.push.apple.com");
    expect(APNS_DEFAULT_ORIGINS.production).toBe("https://api.push.apple.com");
  });
});

describe("the key: reading it, and refusing to half-configure push", () => {
  /** A real P-256 PKCS#8 body in PEM armour, as the `.p8` file holds it. */
  async function pem(): Promise<string> {
    const { der } = await p256();
    const body = Buffer.from(der).toString("base64");
    const lines = body.match(/.{1,64}/g) ?? [];
    return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
  }

  test("no flag at all → push is off, and that is not an error", () => {
    expect(readApnsKeySource({})).toEqual({ kind: "off" });
  });

  test("all four or none: a partial configuration is refused, naming the rule", () => {
    const source = readApnsKeySource({ keyFile: "/k.p8", keyId: "ABC", teamId: "T" });
    expect(source.kind).toBe("error");
    if (source.kind === "error") {
      expect(source.error).toContain("apns-topic");
    }
    for (const name of ["keyId", "teamId", "topic"] as const) {
      const partial = readApnsKeySource({
        keyFile: "/k.p8",
        keyId: "ABC",
        teamId: "T",
        topic: "so.tentacle.app",
        [name]: " ",
      });
      expect(partial.kind).toBe("error");
    }
  });

  test("the reader is injected; an unreadable file is an error, never a throw", () => {
    const config = { keyFile: "/k.p8", keyId: "ABC", teamId: "T", topic: "so.tentacle.app" };
    const ok = readApnsKeySource({ ...config, readFile: () => "PEM" });
    expect(ok.kind).toBe("pem");
    const missing = readApnsKeySource({
      ...config,
      readFile: () => {
        throw new Error("ENOENT: no such file or directory");
      },
    });
    expect(missing.kind).toBe("error");
    if (missing.kind === "error") {
      expect(missing.error).toContain("unreadable");
    }
    // A source with no reader cannot be used, and says so rather than pretending.
    expect(readApnsKeySource(config).kind).toBe("error");
  });

  test("the PEM armour is stripped to DER, and junk is named", async () => {
    const text = await pem();
    const decoded = decodeApnsKeyPem(text);
    expect(decoded.kind).toBe("ok");
    if (decoded.kind === "ok") {
      const key = await crypto.subtle.importKey(
        "pkcs8",
        decoded.der,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      expect(key.type).toBe("private");
    }
    expect(decodeApnsKeyPem("").kind).toBe("error");
    expect(
      decodeApnsKeyPem("-----BEGIN PRIVATE KEY-----\n!!!\n-----END PRIVATE KEY-----").kind,
    ).toBe("error");
  });
});
