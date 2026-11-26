/**
 * The apps host's wire (docs/feat/session-apps-host.md): what a publisher (a
 * `serve`) and the host (`apps/apps-host`) must agree on byte for byte. The host
 * is not an RPC peer, so like the relay's control wire (`relay.ts`) it carries
 * its OWN version, never `PROTOCOL_VERSION`.
 *
 * Every API request is signed with the publisher's Ed25519 key. No crypto here:
 * the caller hashes the body and signs the payload `appsSigningPayload` builds.
 */
import { z } from "zod";

/** The API's own version; it is the first line of every signed payload. */
export const APPS_API_VERSION = 1 as const;

/**
 * The largest page either end takes by default: the host's `maxAppBytes` and the
 * publisher's pre-check (so the owner is never asked about a page the host will
 * refuse). A host configured lower still answers `413 too_large`.
 */
export const APPS_MAX_APP_BYTES_DEFAULT = 10 * 1024 * 1024;

/** An app id's length: 16 lowercase base32 characters = 80 bits. */
export const APP_ID_LENGTH = 16;

const APP_ID_RE = new RegExp(`^[a-z2-7]{${APP_ID_LENGTH}}$`);

/** `true` iff `value` is a well-formed app id (also the app's DNS label). */
export function isAppId(value: string): boolean {
  return APP_ID_RE.test(value);
}

/** The four request headers a signed call carries. */
export const APPS_HEADERS = {
  /** base64url of the 32-byte Ed25519 public key (43 chars). */
  key: "Tentacle-Key",
  /** Unix time in milliseconds, decimal. */
  date: "Tentacle-Date",
  /** base64url of 16 random bytes (22 chars). */
  nonce: "Tentacle-Nonce",
  /** base64url of the 64-byte signature (86 chars). */
  signature: "Tentacle-Signature",
} as const;

/** Byte lengths of the binary header values. */
export const APPS_KEY_BYTES = 32;
export const APPS_NONCE_BYTES = 16;
export const APPS_SIGNATURE_BYTES = 64;

/**
 * The exact string a publisher signs (as UTF-8 bytes). The domain is in it so a
 * request signed for one deployment cannot be replayed at another; `path`
 * excludes the query (the API takes none). `date` is the header's own text.
 */
export function appsSigningPayload(input: {
  readonly method: string;
  readonly domain: string;
  readonly path: string;
  readonly date: string;
  readonly nonce: string;
  readonly bodySha256Hex: string;
}): string {
  return [
    `tentacle-apps/${APPS_API_VERSION}`,
    input.method.toUpperCase(),
    input.domain,
    input.path,
    input.date,
    input.nonce,
    input.bodySha256Hex,
  ].join("\n");
}

/** The answer to a successful create, update or renew. */
export const AppsLeaseResultSchema = z.object({
  id: z.string().regex(APP_ID_RE),
  url: z.string().url(),
  /** Unix ms at which the app goes offline unless renewed. */
  leaseExpiresAt: z.number().int().nonnegative(),
  leaseMs: z.number().int().positive(),
  renewAfterMs: z.number().int().positive(),
});
export type AppsLeaseResult = z.infer<typeof AppsLeaseResultSchema>;

export const AppsErrorCodeSchema = z.enum([
  "bad_request",
  "bad_signature",
  "clock_skew",
  "replay",
  "not_found",
  "forbidden",
  "blocked",
  "taken_down",
  "expired",
  "deleted",
  "too_large",
  "unsupported_media",
  "malformed",
  "rate_limited",
  "cap_reached",
  "conflict",
  "storage_full",
  "killed",
  "busy",
  "internal",
]);
export type AppsErrorCode = z.infer<typeof AppsErrorCodeSchema>;

/** Every non-2xx API answer. */
export const AppsErrorSchema = z.object({
  error: AppsErrorCodeSchema,
  message: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** The operator's statement of reasons on `blocked` / `taken_down`. */
  reason: z.string().optional(),
  /** The host's clock on `clock_skew`, so the publisher can correct its offset. */
  serverTime: z.number().int().nonnegative().optional(),
});
export type AppsError = z.infer<typeof AppsErrorSchema>;
