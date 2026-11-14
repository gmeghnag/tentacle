/**
 * `relayIdOf` — the mobile relay's self-certifying daemon id
 * (docs/feat/mobile-relay.md, Owner Q4).
 *
 *   id = b64url(SHA-256("tentacle-relay-id/1" ‖ secret))[0..22]
 *
 * The invariant this file exists for: the ID IS PUBLIC (it is in QRs, logs and
 * daemon announcements) and the SECRET IS NOT, yet the id can only be produced
 * by someone holding the secret. So the relay needs no account and no database:
 * it registers an id only from a socket presenting a secret that hashes to it,
 * and nobody can squat an id without a 132-bit preimage.
 *
 * It lives on the `@tentacle/transport/noise` subpath beside `pairingSas` — the
 * same shape (one hash, one purpose, a domain separator, a fixed-size key) and
 * the same reason: a box that holds a secret needs the hash function anyway, and
 * no runtime that merely SPEAKS the protocol should load any crypto.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { RELAY_ID_LENGTH, RELAY_SECRET_BYTES, encodeBase64Url } from "@tentacle/protocol";

/** The domain separator: one hash, one purpose (not a Noise hash, not the pairing SAS). */
export const RELAY_ID_PREFIX = "tentacle-relay-id/1";

const prefix = new TextEncoder().encode(RELAY_ID_PREFIX);

/**
 * The relay id for a 32-byte daemon secret: {@link RELAY_ID_LENGTH} base64url
 * characters (132 bits). A wrong-size secret is a caller bug, THROWN rather than
 * silently hashed — a hash over a truncated secret would map two different
 * secrets to one id, exactly the aliasing a self-certifying id must not have.
 *
 * Whoever computes an id from its own secret (`serve`, `devices reset`) and
 * whoever CHECKS one (`the relay`, the daemon checking `ready.id`) must agree
 * byte for byte, which is why the definition is here and not in either of them.
 */
export function relayIdOf(secret: Uint8Array): string {
  if (secret.length !== RELAY_SECRET_BYTES) {
    throw new Error(`relayIdOf: the secret must be ${RELAY_SECRET_BYTES} bytes`);
  }
  const input = new Uint8Array(prefix.length + secret.length);
  input.set(prefix, 0);
  input.set(secret, prefix.length);
  return encodeBase64Url(sha256(input)).slice(0, RELAY_ID_LENGTH);
}
