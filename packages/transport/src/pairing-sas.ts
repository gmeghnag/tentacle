/**
 * The pairing compare code — the SAS both ends show (docs/feat/device-pairing.md,
 * Design "Compare code (SAS)"):
 *
 *   6 decimal digits = uint32(SHA-256("tentacle-pair-sas/1" ‖ computerPub ‖
 *   devicePub)[0..4]) mod 10^6
 *
 * It is the ONLY check that defeats a photographed or raced QR: the host sees
 * a name (the peer chooses it, so it is spoofable) and this code. An attacker
 * who claims the one-time code first is shown on the terminal with a SAS the
 * real phone does not display, so the human answers "no". The attacker cannot
 * grind a match: the real device's public key is unknown until its own
 * handshake, by which time the single-use code is spent.
 *
 * Both keys are bound (order fixed: computer first), so the code differs from
 * the two ends' points of view only if a peer lies about its key — which the
 * Noise handshake makes impossible: each side uses the key IT authenticated
 * (`SecureChannel.remoteStatic`), never one from the params.
 *
 * Pure and dependency-light (`@noble/hashes`, already this package's dep):
 * lives beside `noise.ts`, reached through the same `@tentacle/transport/noise`
 * subpath the channel uses, so a client that pairs loads no extra crypto.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** The domain separator: one hash, one purpose (this is not a Noise hash, nor a key derivation). */
export const PAIRING_SAS_PREFIX = "tentacle-pair-sas/1";
/** Six digits: ~20 bits — enough for a human to compare once, which is all it must be. */
export const PAIRING_SAS_DIGITS = 6;

const prefix = new TextEncoder().encode(PAIRING_SAS_PREFIX);

/**
 * The compare code for a (computer, device) key pair: `"123456"`, always six
 * digits, zero-padded. Both arguments must be 32-byte X25519 public keys; a
 * wrong length is a caller bug, thrown rather than silently hashed (a SAS over
 * a truncated key would compare equal for two different devices).
 */
export function pairingSas(computerPub: Uint8Array, devicePub: Uint8Array): string {
  if (computerPub.length !== 32 || devicePub.length !== 32) {
    throw new Error("pairingSas: both public keys must be 32 bytes");
  }
  const input = new Uint8Array(prefix.length + 64);
  input.set(prefix, 0);
  input.set(computerPub, prefix.length);
  input.set(devicePub, prefix.length + 32);
  const digest = sha256(input);
  // Big-endian 32-bit read of the first four bytes (byte order is part of the
  // definition: the app's implementation must agree byte for byte).
  const n =
    ((digest[0] ?? 0) * 0x1000000 +
      ((digest[1] ?? 0) << 16) +
      ((digest[2] ?? 0) << 8) +
      (digest[3] ?? 0)) >>>
    0;
  return String(n % 10 ** PAIRING_SAS_DIGITS).padStart(PAIRING_SAS_DIGITS, "0");
}

/** `"123456"` → `"123 456"`: how both screens show it (the mockup's grouping). */
export function formatPairingSas(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}
