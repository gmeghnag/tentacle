/**
 * The pairing payload `tentacle pair` prints as a QR code and as pasteable
 * text (docs/feat/device-pairing.md, Design "Pairing payload"):
 *
 *   tentacle://pair?v=1&k=<b64url computer key>&n=<computer name>&c=<code>&a=<url>[&a=<url>…]
 *
 * It is a LINK, never a credential (mobile decision 2): the `c` code is
 * one-time and only half of what pairing needs (the host still confirms), and
 * nothing here is a token. `v` is the payload's OWN version, like
 * `E2E_CHANNEL_VERSION` — not `PROTOCOL_VERSION`: a stale QR owes a clean
 * "this QR is from another version" message, not a wire mismatch.
 *
 * Parsing is strict on the required params and lenient everywhere else
 * (AGENTS §7 forward compatibility, applied to a QR instead of a frame): an
 * unknown parameter is ignored, so a later task can add one (a relay address,
 * a TLS pin) without breaking an older app. Required-and-wrong (`v`, `k`, `c`,
 * `a`, the name) is refused with a reason a client can show.
 *
 * Not a wire type: `PairingPayloadSchema` is deliberately NOT exported, so the
 * JSON-Schema export (`json-schema.ts`) never lists a QR payload as protocol.
 * The base64url codec here is exported too, because the device store keeps
 * identity and device keys in exactly this encoding (`device-store.ts`) and
 * two encodings for one 32-byte key would be a bug waiting to happen.
 */
import { z } from "zod";
import { line } from "./text-line.ts";

/** The payload's own version (independent of `PROTOCOL_VERSION`). */
export const PAIRING_PAYLOAD_VERSION = 1;
/** `tentacle://pair?…` */
export const PAIRING_PAYLOAD_PREFIX = "tentacle://pair?";
/** A pairing code: 10 Crockford base32 characters = 50 bits. */
export const PAIRING_CODE_LENGTH = 10;
/**
 * Crockford base32: no `I`, `L`, `O`, `U` — the characters a human confuses
 * with 1, 0 and each other when retyping a code (the QR carries it anyway; the
 * code is also shown as text).
 */
export const PAIRING_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** Every key on the wire and on disk is an X25519 static public key. */
export const PAIRING_KEY_BYTES = 32;
/** A computer's display name, as shown on the terminal and in the app. */
export const PAIRING_COMPUTER_NAME_MAX = 64;
/** More than a laptop has real addresses; a bound keeps the QR small and the parse cheap. */
export const MAX_PAIRING_ADDRESSES = 8;
/** The device route's path: an address is a full `ws(s)` URL pointing at it. */
export const PAIRING_ADDRESS_SUFFIX = "/e2e";

const ADDRESS_MAX = 512;
const CODE_RE = new RegExp(`^[${PAIRING_CODE_ALPHABET}]{${PAIRING_CODE_LENGTH}}$`);
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** RFC 4648 §5 base64url, UNPADDED (43 chars for a 32-byte key; no `Buffer`/`btoa`: the app's Hermes has neither). */
export function encodeBase64Url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      BASE64URL_ALPHABET.charAt(n >> 18) +
      BASE64URL_ALPHABET.charAt((n >> 12) & 63) +
      BASE64URL_ALPHABET.charAt((n >> 6) & 63) +
      BASE64URL_ALPHABET.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += `${BASE64URL_ALPHABET.charAt(n >> 18)}${BASE64URL_ALPHABET.charAt((n >> 12) & 63)}`;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out +=
      BASE64URL_ALPHABET.charAt(n >> 18) +
      BASE64URL_ALPHABET.charAt((n >> 12) & 63) +
      BASE64URL_ALPHABET.charAt((n >> 6) & 63);
  }
  return out;
}

/**
 * Strict base64url decode: `undefined` for a padding, an alphabet violation or
 * a NON-CANONICAL encoding (trailing bits set — two strings would otherwise
 * decode to one key, which is exactly the aliasing a key encoding must not
 * have).
 */
export function decodeBase64Url(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    return undefined;
  }
  const pad = text.length % 4 === 0 ? 0 : 4 - (text.length % 4);
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let o = 0;
  let bits = 0;
  let acc = 0;
  for (let i = 0; i < text.length; i++) {
    const v = BASE64URL_ALPHABET.indexOf(text.charAt(i));
    if (v < 0) {
      return undefined;
    }
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // Leftover bits must be zero, and the re-encode must be identical: that is
  // what makes the encoding canonical (padding bits and length in one check).
  if (pad === 0 && bits > 0 && (acc & ((1 << bits) - 1)) !== 0) {
    return undefined;
  }
  return out.length === 0 || encodeBase64Url(out) === text ? out : undefined;
}

/** The canonical form of a pairing code (upper case), or `undefined` if it is not one. */
export function normalizePairingCode(text: string): string | undefined {
  const upper = text.toUpperCase();
  return CODE_RE.test(upper) ? upper : undefined;
}

/** A `ws`/`wss` URL that points at the device route. */
export function isPairingAddress(value: string): boolean {
  if (value.length === 0 || value.length > ADDRESS_MAX) {
    return false;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") {
      return false;
    }
    return url.hostname.length > 0 && url.pathname.endsWith(PAIRING_ADDRESS_SUFFIX);
  } catch {
    return false;
  }
}

/** A validated pairing payload: what the QR carries, decoded. */
export interface PairingPayload {
  /** Always `PAIRING_PAYLOAD_VERSION` (a future version is refused, not guessed at). */
  readonly v: number;
  /** The computer's static public key. */
  readonly key: Uint8Array;
  /** The computer's display name (control-character free, ≤ 64 chars). */
  readonly computer: string;
  /** The one-time code, canonical (upper case). */
  readonly code: string;
  /** Full `ws(s)` URLs ending in `/e2e`, in the order printed, duplicates removed. */
  readonly addresses: readonly string[];
}

/** Why a payload was refused. A client shows a sentence per reason; never parses text. */
export type PairingRefusal =
  | "prefix"
  | "version"
  | "key"
  | "name"
  | "code"
  | "address"
  | "no_address";

export type PairingPayloadResult =
  | { readonly ok: true; readonly payload: PairingPayload }
  | { readonly ok: false; readonly reason: PairingRefusal };

/** The raw params, validated together so one missing field cannot read as another. */
const ParamsSchema = z.object({
  v: z.literal(String(PAIRING_PAYLOAD_VERSION)),
  k: z.string().regex(KEY_RE),
  n: line(PAIRING_COMPUTER_NAME_MAX),
  c: z.string().regex(CODE_RE),
  a: z.array(z.string().max(ADDRESS_MAX)).min(1).max(MAX_PAIRING_ADDRESSES),
});

/**
 * Is this a display name a terminal may print (ours, a computer's, a device's)?
 * The same rule the payload applies to `n`, exported so the device store
 * validates a name read back from disk the way it validated the one it wrote —
 * one definition, whether the string came from a QR, a peer or a file (F17).
 */
export function isPairingName(value: string): boolean {
  return line(PAIRING_COMPUTER_NAME_MAX).safeParse(value).success;
}

/** The refusal a zod field's failure means (the first issue's path). */
function reasonOf(field: string): PairingRefusal {
  if (field === "v") return "version";
  if (field === "k") return "key";
  if (field === "n") return "name";
  if (field === "a") return "address";
  return "code";
}

/**
 * Parse a scanned/pasted payload. Unknown params are ignored (a later task's
 * addition must not break this build); a missing, duplicated-wrong or invalid
 * required one is refused with its reason.
 */
export function parsePairingPayload(text: string): PairingPayloadResult {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PAIRING_PAYLOAD_PREFIX)) {
    return { ok: false, reason: "prefix" };
  }
  const params = new URLSearchParams(trimmed.slice(PAIRING_PAYLOAD_PREFIX.length));
  const raw = {
    v: params.get("v") ?? "",
    k: params.get("k") ?? "",
    n: params.get("n") ?? "",
    c: (params.get("c") ?? "").toUpperCase(),
    a: params.getAll("a"),
  };
  if (raw.a.length === 0) {
    // Its own reason: "no daemon is listening that a phone can reach" is a
    // different sentence from "this address is not one a phone can dial".
    return { ok: false, reason: "no_address" };
  }
  const parsed = ParamsSchema.safeParse(raw);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    return { ok: false, reason: reasonOf(typeof field === "string" ? field : "") };
  }
  // `KEY_RE` is exactly 43 base64url characters, the unpadded length of 32
  // bytes: a decoded key cannot be any other size, and `decodeBase64Url`
  // enforces canonicality (so a padded or trailing-bit form is refused too).
  const key = decodeBase64Url(parsed.data.k);
  if (key === undefined) {
    return { ok: false, reason: "key" };
  }
  if (!parsed.data.a.every(isPairingAddress)) {
    return { ok: false, reason: "address" };
  }
  const addresses = [...new Set(parsed.data.a)];
  if (addresses.length === 0) {
    return { ok: false, reason: "no_address" };
  }
  return {
    ok: true,
    payload: {
      v: PAIRING_PAYLOAD_VERSION,
      key,
      computer: parsed.data.n,
      code: parsed.data.c,
      addresses,
    },
  };
}

/**
 * Encode a payload for the QR and the pasted line. Every field is re-checked:
 * a throw here is a caller BUG (`pair` builds this from a validated identity
 * and a fresh code), never something a peer sent.
 */
export function formatPairingPayload(payload: PairingPayload): string {
  const name = line(PAIRING_COMPUTER_NAME_MAX).safeParse(payload.computer);
  const code = normalizePairingCode(payload.code);
  if (!name.success) {
    throw new Error("pairing payload: invalid computer name");
  }
  if (code === undefined) {
    throw new Error("pairing payload: invalid code");
  }
  if (payload.key.length !== PAIRING_KEY_BYTES) {
    throw new Error("pairing payload: the key must be 32 bytes");
  }
  const addresses = [...new Set(payload.addresses)];
  if (addresses.length === 0 || addresses.length > MAX_PAIRING_ADDRESSES) {
    throw new Error("pairing payload: 1 to 8 addresses");
  }
  const parts = [
    `v=${PAIRING_PAYLOAD_VERSION}`,
    `k=${encodeBase64Url(payload.key)}`,
    `n=${encodeURIComponent(payload.computer)}`,
    `c=${code}`,
  ];
  for (const address of addresses) {
    if (!isPairingAddress(address)) {
      throw new Error(
        `pairing payload: ${address} is not a ws(s) URL ending in ${PAIRING_ADDRESS_SUFFIX}`,
      );
    }
    parts.push(`a=${encodeURIComponent(address)}`);
  }
  return `${PAIRING_PAYLOAD_PREFIX}${parts.join("&")}`;
}
