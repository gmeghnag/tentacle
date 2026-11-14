/**
 * Everything the relay knows about APNs that is DECIDED, not I/O
 * (docs/feat/mobile-push.md Design 4): the fixed `aps` template, the request one
 * push becomes, the provider JWT and its cache, and how an APNs status maps onto
 * the daemon's vocabulary. `apns-client.ts` owns the sockets and `server.ts` the
 * frames, so this file stays pure enough to table-test (AGENTS §7).
 *
 * **The relay is not trusted, and Apple is not either.** The only content this
 * file can put in a request is a daemon-supplied SEALED envelope plus a constant
 * banner: `apnsPayloadOf` takes `{tp}` and nothing else, so no daemon can choose
 * the text the OS shows (F9's boundary). Everything else here is transport
 * detail Apple requires.
 */
import {
  type PushDeliveryStatus,
  type PushEnvironment,
  PushPayloadSchema,
  encodeBase64Url,
} from "@tentacle/protocol";

/**
 * The banner every push shows, whatever its kind (Owner Q4). Uniform on purpose:
 * `ask` vs `turn_done`, the interruption level and the thread are decided by
 * task 17's Notification Service Extension from the DECRYPTED kind, so the outer
 * payload leaks nothing. Without an extension (this task) every push shows this
 * placeholder.
 */
export const APNS_APS_TEMPLATE = {
  alert: { title: "tentacle", body: "Open tentacle to see what's new" },
  "mutable-content": 1,
  sound: "default",
} as const;

/** Apple's payload ceiling, in BYTES (the aps template included). */
export const APNS_MAX_PAYLOAD_BYTES = 4096;

/**
 * How long a minted JWT is reused. Apple refuses a token minted more often than
 * once per 20 minutes and accepts one for up to 60, so 40 is the safe middle:
 * one mint per 40 minutes per relay, well inside both bounds.
 */
export const APNS_JWT_REUSE_MS = 40 * 60_000;

/** One APNs request's ceiling; past it the push is `unavailable`, not hung (F2). */
export const APNS_REQUEST_TIMEOUT_MS = 10_000;

/** `push-result.reason`'s bound (`packages/protocol/src/relay.ts`). */
export const APNS_REASON_MAX = 64;

/**
 * Where each environment's session dials. Pinned by a test: swapping the two
 * would deliver sandbox tokens to production (or silently drop every push),
 * which no other test would notice.
 */
export const APNS_DEFAULT_ORIGINS: Record<PushEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

/** The bundle id the relay pushes to. Config only — never daemon-supplied. */
export interface ApnsKeyConfig {
  /** The `.p8` key's id (`--apns-key-id`), which goes in the JWT header. */
  readonly keyId: string;
  /** The Apple team id (`--apns-team-id`), the JWT's `iss`. */
  readonly teamId: string;
  /** The topic, i.e. the app's bundle id (`--apns-topic`). */
  readonly topic: string;
}

/**
 * The APNs request body: the relay's own `aps` plus the sealed envelope.
 *
 * `payload` is parsed through the STRIP schema, so a `{tp, aps}` a daemon sends
 * has its `aps` dropped and cannot reach a banner — the property P2's schema
 * states and this function enforces again at the one place a body is built.
 */
export function apnsPayloadOf(payload: unknown): string {
  const parsed = PushPayloadSchema.parse(payload);
  return JSON.stringify({ aps: APNS_APS_TEMPLATE, tp: parsed.tp });
}

/** The byte size of the body `apnsPayloadOf` would send (the 4096-byte check). */
export function apnsPayloadBytesOf(payload: unknown): number {
  return new TextEncoder().encode(apnsPayloadOf(payload)).length;
}

/**
 * One push as the HTTP/2 request APNs expects. Pure: the caller supplies the
 * JWT and the clock, so a test asserts the exact headers (Design 4).
 *
 * `:method`/`:path` are pseudo-headers and belong to the header set: the client
 * hands this straight to `session.request()`.
 */
export function apnsRequestOf(input: {
  readonly token: string;
  readonly collapse: string;
  readonly ttl: number;
  readonly topic: string;
  readonly jwt: string;
  readonly now: number;
}): { readonly path: string; readonly headers: Record<string, string> } {
  const path = `/3/device/${input.token}`;
  return {
    path,
    headers: {
      ":method": "POST",
      ":path": path,
      // An alert (not a background push): the extension runs, and iOS may show
      // the placeholder even with no extension installed.
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": input.topic,
      // Past this Apple drops the push instead of delivering a stale ask; the
      // pending ask on the daemon is the source of truth either way (F1).
      "apns-expiration": String(Math.floor(input.now / 1000) + input.ttl),
      "apns-collapse-id": input.collapse,
      authorization: `bearer ${input.jwt}`,
    },
  };
}

/** A provider JWT and the cache that keeps the relay inside Apple's minting rate. */
export interface ApnsJwtSource {
  /** The token to send now (minted if there is none, or the cached one is stale). */
  jwt(): Promise<string>;
  /** Mint a fresh one on the next call (a 403 `ExpiredProviderToken` says to). */
  invalidate(): void;
}

/**
 * The ES256 provider token and its cache. Bun's `crypto.subtle.sign` returns the
 * raw 64-byte `r‖s` APNs wants (P0(c)), so the `.p8` needs no conversion.
 *
 * `now` is injected, which is the only way the 40-minute boundary can be a test
 * instead of a 40-minute wait.
 */
export function createApnsJwtSource(input: {
  readonly config: ApnsKeyConfig;
  readonly key: CryptoKey;
  readonly now: () => number;
  readonly reuseMs?: number;
}): ApnsJwtSource {
  const reuseMs = input.reuseMs ?? APNS_JWT_REUSE_MS;
  const encoder = new TextEncoder();
  let cached: { readonly jwt: string; readonly mintedAt: number } | undefined;

  const mint = async (): Promise<string> => {
    const at = Math.floor(input.now() / 1000);
    const header = encodeBase64Url(
      encoder.encode(JSON.stringify({ alg: "ES256", kid: input.config.keyId })),
    );
    const claims = encodeBase64Url(
      encoder.encode(JSON.stringify({ iss: input.config.teamId, iat: at })),
    );
    const signingInput = `${header}.${claims}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      input.key,
      encoder.encode(signingInput),
    );
    return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
  };

  return {
    async jwt() {
      if (cached !== undefined && input.now() - cached.mintedAt < reuseMs) {
        return cached.jwt;
      }
      const jwt = await mint();
      cached = { jwt, mintedAt: input.now() };
      return jwt;
    },
    invalidate() {
      cached = undefined;
    },
  };
}

/** What one APNs attempt concluded, in the vocabulary the daemon understands. */
export interface ApnsOutcome {
  readonly status: PushDeliveryStatus;
  /** A bounded detail for the audit line, never matched on (`≤ 64` chars). */
  readonly reason?: string;
  /**
   * `403 ExpiredProviderToken`: the JWT was rejected, so the client mints a new
   * one and retries ONCE (Apple's own instruction). Nothing else retries: a push
   * is best-effort and a retry storm is worse than a dropped banner.
   */
  readonly retry?: true;
}

/** The reasons APNs means "this token is dead" with (F11: the daemon deletes it). */
const GONE_REASONS = new Set(["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"]);

/** Clip an APNs reason into something a `push-result` frame may carry. */
export function clipApnsReason(reason: string): string {
  const safe = reason.replace(/[^A-Za-z0-9_.:-]/g, "");
  return safe.length === 0 ? "unknown" : safe.slice(0, APNS_REASON_MAX);
}

/**
 * The status table (Design 4): `200 → sent`; `410` and a `400` `BadDeviceToken` /
 * `DeviceTokenNotForTopic` `→ gone` (the daemon deletes that registration);
 * `429 → throttled`; another 4xx `→ rejected` + reason; a 5xx (and a timeout,
 * which the client reports through this same function) `→ unavailable`.
 */
export function apnsOutcomeOf(input: {
  readonly status: number;
  readonly reason?: string | undefined;
}): ApnsOutcome {
  const reason = input.reason === undefined ? undefined : clipApnsReason(input.reason);
  const withReason = (status: PushDeliveryStatus): ApnsOutcome =>
    reason === undefined ? { status } : { status, reason };
  if (input.status === 200) {
    return { status: "sent" };
  }
  if (input.status === 410) {
    return { status: "gone" };
  }
  if (input.status === 403 && input.reason === "ExpiredProviderToken") {
    return { status: "rejected", reason: "ExpiredProviderToken", retry: true };
  }
  if (input.status === 429) {
    return withReason("throttled");
  }
  if (input.status === 400 && reason !== undefined && GONE_REASONS.has(reason)) {
    return { status: "gone", reason };
  }
  if (input.status >= 400 && input.status < 500) {
    return withReason("rejected");
  }
  return withReason("unavailable");
}

/** A timeout is `unavailable`, timed out by the client — one constant, one meaning. */
export const APNS_TIMEOUT_OUTCOME: ApnsOutcome = { status: "unavailable", reason: "timeout" };

/** Where the APNs key comes from: not configured, unusable, or a PEM to import. */
export type ApnsKeySource =
  | { readonly kind: "off" }
  | { readonly kind: "error"; readonly error: string }
  | { readonly kind: "pem"; readonly config: ApnsKeyConfig; readonly pem: string };

/**
 * Read the four `--apns-*` values (flags or env, already parsed) into a key
 * source. All four or none: a key with no topic cannot push, and a topic with no
 * key is a deploy that thinks it has push.
 *
 * `readFile` is injected so this is testable without a real file (AGENTS §9).
 * The message names WHAT failed, never the key's contents.
 */
export function readApnsKeySource(input: {
  readonly keyFile?: string | undefined;
  readonly keyId?: string | undefined;
  readonly teamId?: string | undefined;
  readonly topic?: string | undefined;
  readonly readFile?: (path: string) => string;
}): ApnsKeySource {
  const given = [input.keyFile, input.keyId, input.teamId, input.topic].filter(
    (value) => value !== undefined,
  );
  if (given.length === 0) {
    return { kind: "off" };
  }
  if (given.length !== 4) {
    return {
      kind: "error",
      error: "apns-key-file, apns-key-id, apns-team-id and apns-topic must all be set",
    };
  }
  const config = { keyId: input.keyId ?? "", teamId: input.teamId ?? "", topic: input.topic ?? "" };
  for (const [name, value] of Object.entries(config)) {
    if (value.trim().length === 0) {
      return { kind: "error", error: `${name} is empty` };
    }
  }
  const read = input.readFile;
  if (read === undefined) {
    return { kind: "error", error: "no reader for the apns key file" };
  }
  try {
    return { kind: "pem", config, pem: read(input.keyFile ?? "") };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "error", error: `apns key file unreadable: ${reason}` };
  }
}

/**
 * A PKCS#8 `.p8` PEM to DER, for `crypto.subtle.importKey`. Pure: the armour is
 * stripped here so a malformed file is an explicit error rather than a DOM
 * exception somewhere inside the client.
 */
export function decodeApnsKeyPem(
  pem: string,
):
  | { readonly kind: "ok"; readonly der: Uint8Array }
  | { readonly kind: "error"; readonly error: string } {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  if (body.length === 0) {
    return { kind: "error", error: "the apns key file holds no PEM private key" };
  }
  try {
    const der = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
    return { kind: "ok", der };
  } catch {
    return { kind: "error", error: "the apns key file is not base64 PEM" };
  }
}
