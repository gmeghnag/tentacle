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
 * `maxFrameChars` is 96 Ki CHARACTERS, above the Noise channel's own inbound cap
 * (~87.4 Ki chars) so a legitimate frame is never cut (R0(a) proved an 87 KiB
 * frame splices intact).
 *
 * `maxInboundChars` is the receiver-side guard R0(b) earned: a Bun WebSocket
 * CLIENT has NO inbound frame limit of its own (it accepted a 64 MiB frame and
 * made it a JS string, ~135 MiB RSS), so a hostile relay could hand the daemon an
 * arbitrarily large frame. Anything above this on a daemon leg is refused by
 * `isInboundFrameTooLarge` BEFORE the frame is decoded — 2× the Noise cap, so a
 * legitimate worst-case frame still passes.
 */
export const RELAY_CONTROL_LIMITS = {
  /** A spliced/text frame larger than this (in characters) closes both legs. */
  maxFrameChars: 96 * 1024,
  /** The daemon's own inbound guard per leg (see the doc comment above). */
  maxInboundChars: 176 * 1024,
  /** Phone frames buffered before `accept`, so a Noise message 1 (~100 B) never waits. */
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
 * `true` iff `value` is a well-formed relay secret (43 base64url chars).
 *
 * Note it does NOT verify a secret against an id — that hash lives in
 * `@tentacle/transport`'s `relayIdOf`, the crypto subpath, so a runtime that
 * only validates a frame loads no hash function.
 */
export function isRelaySecret(value: string): boolean {
  return SECRET_RE.test(value);
}

/** The features a `ready` frame may announce; `push` is task 16's (owner-approved amendment). */
export const RELAY_FEATURES = ["push"] as const;
export type RelayFeature = (typeof RELAY_FEATURES)[number];

/**
 * `ready` carries `features` FROM THE START (task 16 amendment): a later `push`
 * frame must not be an "unknown frame" that closes the control socket. Today the
 * relay announces none, so the default is the honest value.
 */
const featuresField = z.array(z.enum(RELAY_FEATURES)).max(16).default([]);

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

/** relay → daemon: registration refused. `supported` is the relay's versions, for the notice. */
const errorFrame = z.object({
  t: z.literal("error"),
  code: z.enum(["version", "invalid", "busy"]),
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
 * A daemon's frames, on `/v1/daemon` and `/v1/accept`. Validated on both ends:
 * a malformed frame is a close, never a guess (F19).
 */
export const RelayDaemonFrameSchema = z.discriminatedUnion("t", [
  helloFrame,
  acceptFrame,
  pingFrame,
]);
export type RelayDaemonFrame = z.infer<typeof RelayDaemonFrameSchema>;

/** The relay's frames, on `/v1/daemon`. */
export const RelayToDaemonFrameSchema = z.discriminatedUnion("t", [
  readyFrame,
  errorFrame,
  openFrame,
  replacedFrame,
  pongFrame,
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
 * R0(b)'s guard: `true` iff an inbound frame is too large to even decode. A Bun
 * WebSocket client caps nothing on its own, so the daemon's legs check this
 * before handing a frame to a channel (an oversized one closes the leg).
 */
export function isInboundFrameTooLarge(data: string | Uint8Array): boolean {
  return data.length > RELAY_CONTROL_LIMITS.maxInboundChars;
}
