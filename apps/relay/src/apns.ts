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
  /**
   * Mint a fresh one on the next call (a 403 `ExpiredProviderToken` says to).
   * With the token that failed, only THAT token is dropped: a token already
   * replaced by another push's retry stays (F15: no minting storm).
   */
  invalidate(jwt?: string): void;
}

/**
 * The ES256 provider token and its cache. Bun's `crypto.subtle.sign` returns the
 * raw 64-byte `r‖s` APNs wants (P0(c)), so the `.p8` needs no conversion.
 *
 * `now` is injected, which is the only way the 40-minute boundary can be a test
 * instead of a 40-minute wait.
 *
 * Minting is SINGLE-FLIGHT (F15: "never a storm"). `crypto.subtle.sign` is async,
 * so a cache that only checks `cached` before awaiting would mint once per
 * concurrent push — and Apple answers frequent token changes with a 429
 * `TooManyProviderTokenUpdates`, throttling the pushes this cache exists to carry.
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
  /** The mint in flight, shared by every caller that arrives while it runs. */
  let inFlight: Promise<string> | undefined;

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
      if (inFlight !== undefined) {
        return await inFlight;
      }
      const pending = mint().then((jwt) => {
        cached = { jwt, mintedAt: input.now() };
        return jwt;
      });
      inFlight = pending;
      // Cleared in a `finally`, so a failed mint does not wedge the cache: the
      // next caller tries again instead of awaiting a rejected promise forever.
      try {
        return await pending;
      } finally {
        if (inFlight === pending) {
          inFlight = undefined;
        }
      }
    },
    /**
     * A cached token Apple refused (`403 ExpiredProviderToken`). Only the token
     * that FAILED is dropped: an `ExpiredProviderToken` burst reaches several
     * in-flight pushes with the same stale JWT, and if each of them wiped the
     * fresh one its sibling had already minted, the relay would mint once per
     * push — exactly the storm this cache exists to prevent.
     */
    invalidate(jwt?: string) {
      if (jwt !== undefined && cached !== undefined && cached.jwt !== jwt) {
        return;
      }
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

// ---------------------------------------------------------------------------
// Live Activities (docs/feat/mobile-live-activity.md Design 5, L4)
// ---------------------------------------------------------------------------

/**
 * The alert a push-to-start carries. L0(d): APNs REFUSES a `start` with no
 * alert, so one is required; it is a fixed constant (the banner rule, F9) — the
 * content is sealed, so the only text iOS may show before the widget opens is
 * this. Task 16's notification stays the rich, actionable channel.
 */
export const APNS_LA_ALERT = { title: "tentacle", body: "A turn is running" } as const;

/**
 * The furthest any `stale-date` / `dismissal-date` may sit past now, in seconds
 * (12 h). The daemon's own policy is minutes (stale 15 min, done 5 min); this is
 * the RELAY's backstop so neither a bug nor a hostile daemon can pin an activity
 * on the lock screen past iOS's 8 h cap (Design 3, Owner Q5).
 */
export const APNS_LA_MAX_AHEAD_SECONDS = 12 * 60 * 60;

/**
 * The `attributes-type` Apple requires on a `start`. It must equal the widget's
 * Swift type name EXACTLY (it is how iOS links an incoming activity to the type
 * it decodes `attributes` into), so it is a constant here and never a frame
 * field: a daemon-supplied name would silently break the widget.
 */
export const APNS_LA_ATTRIBUTES_TYPE = "TentacleActivityAttributes";

/**
 * The `liveactivity` half of an `apns-topic`. Apple routes by it, so a wrong
 * suffix is a 400 for every activity — which no other test would notice.
 */
export const APNS_LA_TOPIC_SUFFIX = ".push-type.liveactivity";

/** The `la` block as the relay received it — the clear fields only (L3's frame). */
export interface ApnsLiveActivity {
  readonly event: "start" | "update" | "end";
  readonly timestamp: number;
  readonly staleDate?: number | undefined;
  readonly dismissalDate?: number | undefined;
  readonly contentState?: { readonly v: 1; readonly e: string; readonly c: string } | undefined;
  readonly attributes?: { readonly v: 1; readonly k: string; readonly slot: string } | undefined;
}

/**
 * The LA request body: a FIXED template plus the daemon's clear fields. Pure and
 * total — every field it emits is either a constant or one of the bounded values
 * L3's schema already checked, so there is no path by which text reaches `aps`.
 *
 * `now` (ms) bounds the dates. Throws when a date is past the bound or the event
 * is unknown: the caller turns that into a `rejected` result, never a send.
 */
export function liveActivityPayloadOf(la: ApnsLiveActivity, now: number): string {
  const nowSeconds = Math.floor(now / 1000);
  const bounded = (value: number | undefined, what: string): number | undefined => {
    if (value === undefined) {
      return undefined;
    }
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${what} must be a non-negative integer of seconds`);
    }
    if (value > nowSeconds + APNS_LA_MAX_AHEAD_SECONDS) {
      throw new Error(`${what} must be at most ${APNS_LA_MAX_AHEAD_SECONDS}s past now`);
    }
    return value;
  };

  const aps: Record<string, unknown> = { timestamp: la.timestamp, event: la.event };
  if (la.event === "start") {
    // A start NEEDS attributes (there is no activity to inherit them from) and,
    // per L0(d), an alert.
    if (la.attributes === undefined) {
      throw new Error("a live activity start must carry attributes");
    }
    aps["attributes-type"] = APNS_LA_ATTRIBUTES_TYPE;
    aps.attributes = la.attributes;
    aps.alert = APNS_LA_ALERT;
  }
  if (la.event === "start" || la.event === "update") {
    if (la.contentState === undefined) {
      throw new Error(`a live activity ${la.event} must carry a content-state`);
    }
    aps["content-state"] = la.contentState;
  }
  const staleDate = bounded(la.staleDate, "stale-date");
  if (staleDate !== undefined) {
    aps["stale-date"] = staleDate;
  }
  const dismissalDate = bounded(la.dismissalDate, "dismissal-date");
  if (dismissalDate !== undefined) {
    aps["dismissal-date"] = dismissalDate;
  }
  if (la.event !== "start" && la.event !== "update" && la.event !== "end") {
    throw new Error("a live activity event must be start, update or end");
  }
  return JSON.stringify({ aps });
}

/**
 * One activity push as the HTTP/2 request APNs expects. The differences from a
 * banner push are all Apple's: the push type, the topic's suffix, the priority
 * (the daemon's 5|10 rather than a constant) and the ABSENCE of `apns-expiration`
 * / `apns-collapse-id` — an activity's lifetime is `dismissal-date`, and there is
 * nothing to collapse.
 */
export function liveActivityRequestOf(input: {
  readonly token: string;
  readonly topic: string;
  readonly jwt: string;
  readonly priority: 5 | 10;
  readonly now: number;
  readonly la: ApnsLiveActivity;
}): { readonly path: string; readonly headers: Record<string, string> } {
  const path = `/3/device/${input.token}`;
  return {
    path,
    headers: {
      ":method": "POST",
      ":path": path,
      "apns-push-type": "liveactivity",
      "apns-priority": String(input.priority),
      "apns-topic": `${input.topic}${APNS_LA_TOPIC_SUFFIX}`,
      authorization: `bearer ${input.jwt}`,
    },
  };
}

/**
 * The per-token LA push budgets. `priority 10` is the scarce one (Apple's LA
 * budget is ~2-4× a normal push's), so an excess is DOWNGRADED to 5, never
 * dropped: a throttled update is superseded by the next state anyway, but a
 * dropped `asking` would be a missed approval (F19).
 */
export const APNS_LA_LIMITS = {
  /** LA pushes per hour, per token. */
  pushesPerHourPerToken: 60,
  /** Priority-10 pushes per hour, per token; past it a 10 becomes a 5. */
  priority10PerHourPerToken: 20,
} as const;
