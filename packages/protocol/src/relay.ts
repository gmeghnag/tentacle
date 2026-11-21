/**
 * The mobile relay's wire and its two pure helpers (docs/feat/mobile-relay.md,
 * Owner Q2/Q4) — see the design doc for the full picture. Nothing here is
 * `PROTOCOL_VERSION`: a relay is not an RPC peer, so the daemon ↔ relay
 * control wire carries its OWN version, independently, and an unknown one owes a
 * clean `error:"version"` instead of a confusing mid-session skew.
 *
 *   phone ──wss /d/<id>/e2e──► relay ◄──wss /v1/daemon (control)── daemon
 *                                │   ──{t:"open",stream,ip}──────►
 *                                │◄──wss /v1/accept {t:"accept"}── daemon
 *                                └── splice text frames 1:1 ──────► the EXISTING device path
 *
 * **The relay is not trusted** (AGENTS §7 "a pod is not trusted", applied to a
 * service we host): it may read, drop, delay, reorder, replay, inject and forge
 * anything it carries, and may lie on this control channel. So every frame here
 * is INPUT to validate, never authority: the id it echoes back is checked
 * against the one our own secret derives (`relayIdOf`, task R1's transport
 * half), and every stream still needs the Noise handshake against the computer
 * key. A leaked secret buys an address (a denial of service), never a session.
 *
 * Shape (Owner Q3/Q4): ONE control socket per daemon + one data socket per phone
 * stream ("reverse accept"), and a **self-certifying id** — the address is
 * computed locally as `<relay>/d/<id>/e2e`, so `pair` and the daemon record know
 * it before any connection and the relay stays stateless (no account, no
 * database). The relay only CONFIRMS the id in `ready`.
 *
 * The `/d/<id>/e2e` path is FROZEN across relay versions: an installed app
 * (11b+) already dials it with no update (`isPairingAddress` accepts it,
 * `pairing.ts`), which is the whole point of the shape.
 */
import { z } from "zod";
import { ActivityAttributesSchema, ActivityContentStateSchema } from "./live-activity.ts";
import { PushEnvelopeSchema } from "./push.ts";

/**
 * The control wire's own version. Bump it when a frame changes shape or
 * meaning; the far end answers `error` with `code:"version"` and the daemon
 * backs off an hour with one notice (no reconnect loop).
 */
export const RELAY_PROTOCOL_VERSION = 1 as const;

/**
 * The ONE place the hosted relay's domain appears in code (mobile decision 9):
 * `relay.url` overrides it, `serve --relay` names another, and the app learns
 * every address from the QR — it hard-codes no domain at all.
 */
export const DEFAULT_RELAY_URL = "wss://relay.tentacle.so";

/** A per-daemon secret: 32 random bytes, stored base64url in `<store>/relay.json`. */
export const RELAY_SECRET_BYTES = 32;
/** 43 unpadded base64url characters — exactly what {@link RELAY_SECRET_BYTES} encodes to. */
export const RELAY_SECRET_TEXT_LENGTH = 43;
/** An id's length: 22 base64url chars = 132 bits of the 256-bit digest. */
export const RELAY_ID_LENGTH = 22;
/** A stream token's length: 22 base64url chars = a 128-bit random value. */
export const RELAY_STREAM_TEXT_LENGTH = 22;

const SECRET_RE = new RegExp(`^[A-Za-z0-9_-]{${RELAY_SECRET_TEXT_LENGTH}}$`);
const ID_RE = new RegExp(`^[A-Za-z0-9_-]{${RELAY_ID_LENGTH}}$`);
const STREAM_RE = new RegExp(`^[A-Za-z0-9_-]{${RELAY_STREAM_TEXT_LENGTH}}$`);

/**
 * A phone dial for an id that is not registered yet is HELD this long, then
 * closed `4404`: it covers a daemon's reconnect blip and the pairing race (F2,
 * F17) without leaving the phone's socket open indefinitely.
 */
export const RELAY_STREAM_HOLD_MS = 5_000;
/** A stream token is single-use and dies after this long (F12: a captured `open` is worthless). */
export const RELAY_STREAM_EXPIRY_MS = 10_000;
/** The phone leg's close code for "no such id / no longer held". */
export const RELAY_CLOSE_UNREGISTERED = 4404;

/**
 * The numbers BOTH ends enforce, in one place so they cannot drift: the relay
 * closes on them and the daemon's accept leg is bounded by them.
 *
 * `maxFrameChars` is 96 Ki — characters for a text frame, BYTES for a binary one
 * (Bun's `maxPayloadLength` counts the payload either way) — above both the raw
 * Noise message of E2E v2 (≤ 65 535 B, +1 version byte in the handshake) and a
 * legacy v1 `t1:` text frame (≤ ~87.4 Ki chars), so a legitimate frame is never
 * cut (R0(a) proved an 87 KiB frame splices intact; docs/feat/noise-binary-carrier.md).
 *
 * `maxInboundChars` is the receiver-side DECODE guard: a Bun WebSocket CLIENT has
 * NO inbound frame limit of its own (R0(b) measured it accepting a 64 MiB frame,
 * ~135 MiB RSS), so a hostile relay can hand the daemon an arbitrarily large
 * frame. This predicate does NOT bound that memory — the string (or `Uint8Array`)
 * has already been materialised by Bun before any handler runs, which is exactly
 * what R0(b) showed; a check here cannot undo it. What it does bound is the cost
 * of everything AFTER the socket: the JSON/zod parse and the channel's own copy.
 * Anything above it on a daemon leg is refused before that work — 2× the Noise
 * cap, so a legitimate worst-case frame still passes.
 *
 * The unbounded-allocation gap itself stays OPEN (F7, R4): Bun exposes
 * `maxPayloadLength` on a SERVER only — a client constructor ignores it (probed
 * on 1.4.3: a `WebSocket` built with `{maxPayloadLength:1024}` still received
 * 4096). R4's fallback is to accept it and back off after an oversize close, so
 * a hostile relay cannot make us reconnect-loop into the same allocation.
 */
export const RELAY_CONTROL_LIMITS = {
  /** A spliced frame larger than this (characters of text, bytes of binary) closes both legs. */
  maxFrameChars: 96 * 1024,
  /** The daemon's own inbound guard per leg (see the doc comment above). */
  maxInboundChars: 176 * 1024,
  /** Phone frames buffered before `accept` (text by characters, binary by bytes), so a Noise message 1 (97 B) never waits. */
  preAcceptBytes: 64 * 1024,
  /** Per-leg backpressure ceiling, the `serve` policy (`closeOnBackpressureLimit`). */
  backpressureBytes: 16 * 1024 * 1024,
  /** A phone dial is held this long for a registration. */
  phoneHoldMs: RELAY_STREAM_HOLD_MS,
} as const;

/** A stream token the relay minted, or one a daemon echoes back. */
export const RelayStreamTokenSchema = z.string().regex(STREAM_RE);

/** `hello`'s secret, in the FRAME (never in the URL: a URL reaches an access log). */
export const RelaySecretTextSchema = z.string().regex(SECRET_RE);

/** The relay's id for a daemon: public, but only computable from the secret. */
export const RelayIdSchema = z.string().regex(ID_RE);

/** `true` iff `value` is a well-formed relay id (22 base64url chars). */
export function isRelayId(value: string): boolean {
  return ID_RE.test(value);
}

/**
 * `true` iff `value` is a phone's address THROUGH a relay — `<relay>[/prefix]/d/<id>/e2e`
 * (what {@link relayAddress} builds).
 *
 * It exists to be told apart from the DIRECT kind (`ws://192.168.1.8:4000/e2e`),
 * because the two are not worth the same to the phone: a relay address is a
 * fallback by construction (docs/feat/mobile-relay.md Design §5, "direct first,
 * relay last"), so anything ordering addresses — `pair`'s QR, the daemon's
 * announcement — must put one AFTER every direct address, not merely after the
 * ones that came from the same record.
 *
 * Deliberately stricter than `isPairingAddress`: that one only needs the path to
 * END in `/e2e`, which every direct address does too, so it cannot tell the two
 * apart (and must not — an installed app dials both).
 */
export function isRelayDeviceAddress(value: string): boolean {
  const url = parseUrl(value);
  if (url === undefined || (url.protocol !== "ws:" && url.protocol !== "wss:")) {
    return false;
  }
  // A base path is kept (`wss://example.com/relay/d/<id>/e2e`), so the three
  // segments are read from the END, never assumed to start at the root.
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  return (
    segments.length >= 3 &&
    segments[segments.length - 3] === "d" &&
    isRelayId(segments[segments.length - 2] ?? "") &&
    segments[segments.length - 1] === "e2e"
  );
}

/**
 * `true` iff `value` is a well-formed relay secret (43 base64url chars).
 *
 * Note it does NOT verify a secret against an id — that hash lives in
 * `@tentacle/transport`'s `relayIdOf`, the crypto subpath, so a runtime that
 * only validates a frame loads no hash function.
 */
export function isRelaySecret(value: string): boolean {
  return SECRET_RE.test(value);
}

/** The features this build knows; `push` is task 16's, `liveactivity` task 18's (both owner-approved amendments). */
export const RELAY_FEATURES = ["push", "liveactivity"] as const;
export type RelayFeature = (typeof RELAY_FEATURES)[number];

/** `true` iff `value` is a feature name this build knows. */
export function isRelayFeature(value: string): value is RelayFeature {
  return (RELAY_FEATURES as readonly string[]).includes(value);
}

/**
 * The feature names in an announced list that this build knows, duplicates
 * dropped — the filter `ready.features` is read through.
 *
 * Why the list is NOT a closed enum (review R1 finding 1): `features` exists
 * (task 16 amendment) so a later `push` frame never hits "unknown frame closes
 * the control socket". A closed enum defeats exactly that — a relay deployed
 * with one name this build does not know would fail the WHOLE `ready` parse, and
 * ("a malformed frame is a close") the daemon would drop the link and retry
 * forever: every installed `serve` losing relay reachability at once, with no
 * version error and no notice. Fields are free (AGENTS §7), so unknown names are
 * accepted by the parse and filtered here.
 */
export function knownRelayFeatures(features: readonly string[]): RelayFeature[] {
  const known: RelayFeature[] = [];
  for (const name of features) {
    if (isRelayFeature(name) && !known.includes(name)) {
      known.push(name);
    }
  }
  return known;
}

/**
 * `ready` carries `features` FROM THE START (task 16 amendment): a later `push`
 * frame must not be an "unknown frame" that closes the control socket. Today the
 * relay announces none, so the default is the honest value.
 *
 * Any bounded name parses ({@link knownRelayFeatures} is how a reader filters),
 * for the forward-compat reason above. Not a `.transform()`: the JSON-schema
 * export cannot represent a `ZodEffects`, and the wire contract must stay
 * exportable.
 */
const featuresField = z.array(z.string().min(1).max(64)).max(16).default([]);

/** daemon → relay: register this id (first frame on `/v1/daemon`). */
const helloFrame = z.object({
  t: z.literal("hello"),
  v: z.number().int().min(1),
  secret: RelaySecretTextSchema,
});

/** daemon → relay: open the data leg for the stream the relay announced. */
const acceptFrame = z.object({
  t: z.literal("accept"),
  v: z.number().int().min(1),
  stream: RelayStreamTokenSchema,
});

/** daemon → relay: liveness (R0(c): a Bun client does NOT notice a dead TCP path on its own). */
const pingFrame = z.object({ t: z.literal("ping") });

/**
 * relay → daemon: the registration was accepted. `id` MUST equal the daemon's own
 * `relayIdOf(secret)` — a mismatch means a lying relay and the link is dropped
 * (F7).
 */
const readyFrame = z.object({
  t: z.literal("ready"),
  v: z.number().int().min(1),
  id: RelayIdSchema,
  features: featuresField,
});

/** The refusal codes this build knows (relay → daemon `error`); a doc for the relay's author. */
export const RELAY_ERROR_CODES = ["version", "invalid", "busy"] as const;
export type RelayErrorCode = (typeof RELAY_ERROR_CODES)[number];

/**
 * `true` iff `value` is a refusal code this build knows.
 *
 * `code` is a free bounded string, not an enum, for the same reason as
 * `ready.features` (review R1 finding 1, less severe): an error frame's job is to
 * REFUSE cleanly, and a closed enum turned a newer relay's new code into
 * "malformed frame" — a protocol violation the daemon answers by dropping the
 * link, instead of a refusal. An unknown code is a refusal like any other; only
 * `version` earns the 1 h notice (F13).
 */
export function isRelayErrorCode(value: string): value is RelayErrorCode {
  return (RELAY_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * relay → daemon: registration refused. `supported` is the relay's versions, for
 * the notice; `code` is name-checked with {@link isRelayErrorCode}, never by the schema.
 */
const errorFrame = z.object({
  t: z.literal("error"),
  code: z.string().min(1).max(32),
  supported: z.array(z.number().int().min(1)).max(16),
});

/**
 * relay → daemon: a phone is waiting. `ip` is the phone's address as the RELAY
 * saw it — untrusted, used only as a rate-limit key (`relay:<ip>`), never logged
 * as fact and never an identity.
 */
const openFrame = z.object({
  t: z.literal("open"),
  stream: RelayStreamTokenSchema,
  ip: z.string().min(1).max(64),
});

/** relay → daemon: a newer `hello` for this id replaced this socket (F15, F16). */
const replacedFrame = z.object({ t: z.literal("replaced") });

/** relay → daemon: liveness answer. */
const pongFrame = z.object({ t: z.literal("pong") });

/**
 * The `apns-collapse-id` header's limit, in BYTES (Apple refuses a longer one).
 * The daemon builds these (`pushCollapseIdOf`, `push.ts`); the relay only checks
 * the shape, because the value ends up in a request HEADER.
 */
export const RELAY_PUSH_COLLAPSE_MAX = 64;

/** `apns-expiration`'s range, in seconds: `0` means "deliver now or drop", a day is Apple's maximum. */
export const RELAY_PUSH_TTL_MIN_SECONDS = 0;
export const RELAY_PUSH_TTL_MAX_SECONDS = 86_400;

/**
 * A device's raw APNs token as the daemon forwards it: lowercase hex, 64..200
 * chars — the SAME rule as `device/push_register` (`push.ts`'s
 * `DevicePushRegisterParamsSchema.token`). Duplicated on purpose: this frame is
 * parsed by the RELAY, which must not load the RPC schemas, and `relay-push`'s
 * test pins the two against a shared sample so they cannot drift silently.
 */
export const RelayPushTokenSchema = z.string().regex(/^[0-9a-f]{64,200}$/);

/** A collapse id: header-safe base64url, bounded by BYTES. */
export const RelayCollapseIdSchema = z
  .string()
  .regex(new RegExp(`^[A-Za-z0-9_-]{1,${RELAY_PUSH_COLLAPSE_MAX}}$`));

/**
 * daemon → relay: deliver one sealed push to one device (docs/feat/mobile-push.md
 * Design 3). `n` is the daemon's per-socket counter; the relay answers with the
 * same `n` in `push-result`, and responses may arrive OUT OF ORDER (several
 * pushes are in flight at once), so nothing may assume a reply follows its
 * request.
 *
 * `payload` is `{tp: <P2 envelope>}` — the SEALED envelope and nothing else. It
 * is not `aps`: the relay builds that from its own fixed template (P4), so a
 * daemon cannot put plaintext into a banner the OS shows without opening the
 * seal (F9's boundary).
 *
 * This frame may only be sent to a relay that announced `"push"` in
 * `ready.features`: an R2 relay closes the control socket on an unknown frame
 * (C1), so sending one to an older relay would loop forever.
 */
const pushFrame = z.object({
  t: z.literal("push"),
  n: z.number().int().nonnegative(),
  token: RelayPushTokenSchema,
  env: z.enum(["sandbox", "production"]),
  collapse: RelayCollapseIdSchema,
  ttl: z.number().int().min(RELAY_PUSH_TTL_MIN_SECONDS).max(RELAY_PUSH_TTL_MAX_SECONDS),
  payload: z.object({ tp: PushEnvelopeSchema }),
});
export type RelayPushFrame = z.infer<typeof pushFrame>;

/** The schema alone, for a caller that validates a frame it is about to send. */
export const RelayPushFrameSchema = pushFrame;

/** `true` iff `frame` is a `push` — the gate a daemon applies before sending one. */
export function isRelayPushFrame(frame: { t: string }): frame is RelayPushFrame {
  return frame.t === "push";
}

/**
 * The CLEAR fields of an activity update (docs/feat/mobile-live-activity.md
 * Design 4): the ActivityKit template the relay builds `aps` from, and NOTHING a
 * daemon could turn into content. `contentState` is the sealed blob; `attributes`
 * exist only on `start` (Apple requires them for push-to-start, and a
 * push-started activity has no activity to inherit them from).
 *
 * Why the dates live here rather than in the relay's own template: they are the
 * daemon's intent ("stale after 15 min of silence", "done stays 5 min"), so
 * moving them into the relay would put a policy the caller owns out of its
 * reach — but they are BOUNDED, so a daemon cannot make an activity live forever.
 */
const activityLa = z.object({
  event: z.enum(["start", "update", "end"]),
  /** Apple's `aps.timestamp`, in seconds since the epoch (it subtracts nothing; we send absolute). */
  timestamp: z.number().int().min(0),
  /** When the view should say "may be out of date" (`stale-date`), seconds. */
  staleDate: z.number().int().min(0).optional(),
  /** When it should disappear (`dismissal-date`), seconds. */
  dismissalDate: z.number().int().min(0).optional(),
  /** The sealed state. Absent on `end`. */
  contentState: ActivityContentStateSchema.optional(),
  /** Push-to-start only. Never on `update`/`end` (Apple ignores it, and it would re-name the activity). */
  attributes: ActivityAttributesSchema.optional(),
});

/**
 * daemon → relay: deliver one Live Activity push (docs/feat/mobile-live-activity.md
 * Design 4). Same shape as a `push` — `n`, `token`, `env` — because it is the SAME
 * transport (decision 2: one relay for streams and push), plus the `la` block.
 *
 * No `collapse` and no `ttl`: an activity is not a banner to replace, and its
 * lifetime is `dismissalDate`, not `apns-expiration` — a `ttl` here would be a
 * second, contradicting source of truth.
 *
 * `priority` is Apple's LA priority, not a push's: 10 for start / asking /
 * resolved / end, 5 for a tool or title update. The relay degrades an excess of
 * 10s to 5 (never drops) — the budget belongs to it, since it is the one that
 * sees all tokens.
 *
 * Only to a relay that announced `"liveactivity"` in `ready.features`: an older
 * relay closes the control socket on an unknown frame (C1).
 */
const liveActivityFrame = z.object({
  t: z.literal("liveactivity"),
  n: z.number().int().nonnegative(),
  token: RelayPushTokenSchema,
  env: z.enum(["sandbox", "production"]),
  priority: z.union([z.literal(5), z.literal(10)]),
  la: activityLa,
});
export type RelayLiveActivityFrame = z.infer<typeof liveActivityFrame>;

/** The schema alone, for a caller that validates a frame it is about to send. */
export const RelayLiveActivityFrameSchema = liveActivityFrame;

/** `true` iff `frame` is a `liveactivity` — the gate a daemon applies before sending one. */
export function isRelayLiveActivityFrame(frame: { t: string }): frame is RelayLiveActivityFrame {
  return frame.t === "liveactivity";
}

/**
 * relay → daemon: what became of a `push` — `sent`, `gone`, `rejected`,
 * `throttled` or `unavailable` (the vocabulary P2 owns,
 * `PUSH_DELIVERY_STATUSES`, which the daemon reads it through).
 *
 * `status` is a BOUNDED FREE string, not an enum, for the reason `error.code`
 * is (R1 review finding 1): a closed enum makes a newer relay's new status a
 * "malformed frame", which closes the whole control socket — one unknown word
 * costs every push in flight, and the link's reachability with it. Parsing it
 * loosely and refusing the VALUE (`isPushDeliveryStatus`) keeps a bad status
 * one dropped push instead. `reason` is a bounded detail for the audit line,
 * never matched on.
 */
const pushResultFrame = z.object({
  t: z.literal("push-result"),
  n: z.number().int().nonnegative(),
  status: z.string().min(1).max(32),
  reason: z.string().min(1).max(64).optional(),
});
export type RelayPushResultFrame = z.infer<typeof pushResultFrame>;

/** The schema alone, for the relay that answers a `push`. */
export const RelayPushResultFrameSchema = pushResultFrame;

/**
 * A daemon's frames, on `/v1/daemon` and `/v1/accept`. Validated on both ends:
 * a malformed frame is a close, never a guess (F19).
 */
export const RelayDaemonFrameSchema = z.discriminatedUnion("t", [
  helloFrame,
  acceptFrame,
  pingFrame,
  pushFrame,
  liveActivityFrame,
]);
export type RelayDaemonFrame = z.infer<typeof RelayDaemonFrameSchema>;

/** The relay's frames, on `/v1/daemon`. */
export const RelayToDaemonFrameSchema = z.discriminatedUnion("t", [
  readyFrame,
  errorFrame,
  openFrame,
  replacedFrame,
  pongFrame,
  pushResultFrame,
]);
export type RelayToDaemonFrame = z.infer<typeof RelayToDaemonFrameSchema>;

/** Every control frame, either direction — for a relay that reads one socket class. */
export const RelayControlFrameSchema = z.discriminatedUnion("t", [
  helloFrame,
  acceptFrame,
  pingFrame,
  readyFrame,
  errorFrame,
  openFrame,
  replacedFrame,
  pongFrame,
  pushFrame,
  pushResultFrame,
  liveActivityFrame,
]);
export type RelayControlFrame = z.infer<typeof RelayControlFrameSchema>;

/** Loopback names/addresses only: a `ws://` secret must never cross a network in clear. */
function isLoopbackHost(hostname: string): boolean {
  // Bun's `URL.hostname` KEEPS the brackets of an IPv6 literal (`[::1]`); accept
  // both spellings so a hand-written or a parser-produced URL behaves the same.
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

/**
 * `true` iff `value` is a usable relay base URL: `wss://` anywhere, or `ws://` to
 * a LOOPBACK host only (dev and tests). Everything else is refused rather than
 * "fixed up", because the alternative is a daemon offering its secret in clear
 * over a real network, or a relay URL that `relayAddress` cannot extend.
 *
 * Credentials, a query and a fragment are refused: userinfo would put a secret in
 * an access log on the way, and the address is built by appending path segments.
 */
export function isRelayUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed !== value) {
    return false;
  }
  return parseRelayUrl(value) !== undefined;
}

/** The parsed URL of a valid relay base URL, or `undefined` — the one place both callers validate. */
function parseRelayUrl(value: string): ReturnType<typeof parseUrl> {
  const url = parseUrl(value);
  if (url === undefined) {
    return undefined;
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    return undefined;
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (url.hostname.length === 0) {
    return undefined;
  }
  return url.protocol === "wss:" || isLoopbackHost(url.hostname) ? url : undefined;
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * The phone's address for a daemon: `<relay>/d/<id>/e2e` (Owner Q4 — computed
 * locally, so the record and `pair`'s QR can carry it before any connection; the
 * relay only confirms the id).
 *
 * The result MUST stay something {@link isPairingAddress} accepts: an installed
 * app dials it with no update, and that is the feature's whole reach.
 */
export function relayAddress(relayUrl: string, id: string): string {
  if (!isRelayId(id)) {
    throw new Error("relayAddress: malformed relay id");
  }
  const base = relayUrl.trim().replace(/\/+$/, "");
  if (!isRelayUrl(base)) {
    throw new Error("relayAddress: not a relay URL");
  }
  return `${base}/d/${id}/e2e`;
}

/**
 * `true` iff an inbound frame's size is over the DECODE bound — the cost gate for
 * the JSON/zod parse and the channel's copy, never a memory bound: the value is
 * already in memory when this is asked (R0(b); see the limits' doc comment).
 */
export function isInboundFrameTooLarge(data: string | Uint8Array): boolean {
  return data.length > RELAY_CONTROL_LIMITS.maxInboundChars;
}
