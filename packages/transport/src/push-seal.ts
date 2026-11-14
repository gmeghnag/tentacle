/**
 * `sealPush` / `openPush` — the end-to-end encryption of a push notification
 * (docs/feat/mobile-push.md Design 2, Owner Q1). HPKE (RFC 9180), **Auth mode**,
 * suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / ChaCha20-Poly1305, single
 * shot: one ephemeral key, one ciphertext, no sequence number.
 *
 * The two properties this file exists for:
 *
 *  - **The relay and Apple learn nothing.** The payload is a sealed blob; only
 *    the plaintext's bucket (512/1024/2048) is visible, so even the length is
 *    one of three values.
 *  - **Only the paired computer can have produced it.** Auth mode means the
 *    sender's STATIC private key is part of the KEM input, so a relay (or Apple,
 *    or any third party) cannot forge a push that opens. The recipient checks it
 *    against the computer's public key pinned at pairing — the same rule as
 *    AGENTS §7 "a pod/relay is not trusted".
 *
 * iOS 17+ CryptoKit implements exactly this suite and mode
 * (`HPKE.Recipient(…authenticatedBy:)`), so the app's Notification Service
 * Extension decrypts with no hand-written Swift crypto — which is why the
 * success of this file is pinned by the RFC's own vectors
 * (`test/vectors/push-v1.json`).
 *
 * Pure and synchronous: no I/O, no timers, no randomness of its own — the
 * ephemeral key is injected, exactly as in `noise.ts`, so the published vectors
 * drive it byte for byte.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { encodeBase64Url } from "@tentacle/protocol";

/** The HPKE `info` for this protocol version. Changing it breaks every vector. */
export const PUSH_INFO = "tentacle-push/1";

/**
 * The domain separator of a push key id. ONE hash, one purpose: unlike the
 * relay id (a secret's hash) this one is over a PUBLIC key, and its job is only
 * to let the extension pick which paired computer's key to try — and to be the
 * AEAD's `aad`, binding the ciphertext to that computer.
 */
export const PUSH_KID_PREFIX = "tentacle-push-kid/1";

/** 12 base64url characters = 72 bits of the hash: enough to name one key, short enough for a payload. */
export const PUSH_KID_LENGTH = 12;

/**
 * The only plaintext lengths on the wire, before sealing. A short `ask` and a
 * `turn_done` are both 512, so the envelope's size says nothing about the kind
 * (Owner Q4: uniform for every kind).
 */
export const PUSH_PAD_BUCKETS = [512, 1024, 2048] as const;

/**
 * The plaintext length prefix: `u16` big-endian. 2 bytes are reserved for it in
 * every bucket, so the largest plaintext that fits is 2046 bytes. A larger one
 * is THROWN, never truncated — the P2 wire schema clips text fields before it
 * ever gets here, and the plan's worst-case test asserts the bound.
 */
export const PUSH_LENGTH_BYTES = 2;

/** ChaCha20-Poly1305 appends a 16-byte tag, so a sealed push is `bucket + 16` bytes: three sizes on the wire. */
export const PUSH_AEAD_TAG_BYTES = 16;

/** Why a seal/open failed. `bad-tag` (a flipped byte, a wrong key) is not authenticated; the rest are caller bugs. */
export type PushSealErrorKind = "too-large" | "bad-key" | "bad-tag" | "bad-padding";

export class PushSealError extends Error {
  readonly kind: PushSealErrorKind;
  constructor(kind: PushSealErrorKind, message: string) {
    super(message);
    this.name = "PushSealError";
    this.kind = kind;
  }
}

/** The sealed form: what rides in the APNs payload's `tp` object (P2 encodes it as base64url). */
export interface SealedPush {
  /** `k` — the whole key id string, which is also the AEAD `aad`. */
  readonly keyId: string;
  /** `enc` — the ephemeral (sender) public key, 32 bytes. */
  readonly enc: Uint8Array;
  /** `c` — the ChaCha20-Poly1305 ciphertext of the padded plaintext: bucket + 16 tag (528/1040/2064). */
  readonly ciphertext: Uint8Array;
}

/** A bare HPKE Auth single-shot output — no tentacle framing, no padding (what the RFC vectors address). */
export interface HpkeAuthSealed {
  readonly enc: Uint8Array;
  readonly ciphertext: Uint8Array;
}

/** The inputs of {@link hpkeAuthSeal}. Every key and the ephemeral are injected, so a vector is exact. */
export interface HpkeAuthSealInput {
  readonly plaintext: Uint8Array;
  /** The AEAD's `aad`. `sealPush` passes the key id, which binds a ciphertext to one computer. */
  readonly aad: Uint8Array;
  /** The HPKE `info`. `sealPush` passes {@link PUSH_INFO}. */
  readonly info: Uint8Array;
  /** The sender's static X25519 private key: in Auth mode this is what authenticates the sender. */
  readonly senderStatic: Uint8Array;
  readonly recipientPublicKey: Uint8Array;
  readonly rng: PushRng;
}

export type PushRng = (length: number) => Uint8Array;

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const N_HASH = 32;
const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

// RFC 9180 §7.1: DHKEM(X25519, HKDF-SHA256) = KEM id 0x0020; KDF-SHA256 = 0x0001;
// AEAD_CHACHA20_POLY1305 = 0x0003. Auth mode = 0x02 (§5.1).
const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;
const MODE_AUTH = 0x02;

const HPKE_V1 = encoder.encode("HPKE-v1");
/** §4.1: the KEM's own suite id starts with "KEM" — a different separator from the rest of HPKE. */
const KEM_SUITE_ID = cat(encoder.encode("KEM"), i2osp2(KEM_ID));
const HPKE_SUITE_ID = cat(encoder.encode("HPKE"), i2osp2(KEM_ID), i2osp2(KDF_ID), i2osp2(AEAD_ID));

function cat(...parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function i2osp2(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

function need(bytes: Uint8Array, length: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new PushSealError("bad-key", `${what} must be ${length} bytes`);
  }
}

/** §4: `LabeledExtract(salt, label, ikm)` = HMAC-SHA256(salt, "HPKE-v1" ‖ suite_id ‖ label ‖ ikm). */
function labeledExtract(
  suiteId: Uint8Array,
  salt: Uint8Array,
  label: string,
  ikm: Uint8Array,
): Uint8Array {
  return hmac(sha256, salt, cat(HPKE_V1, suiteId, encoder.encode(label), ikm));
}

/** §4: `LabeledExpand(prk, label, info, L)` — HKDF-Expand over one labeled block, for any L ≤ 255·32. */
function labeledExpand(
  suiteId: Uint8Array,
  prk: Uint8Array,
  label: string,
  info: Uint8Array,
  length: number,
): Uint8Array {
  const labeled = cat(i2osp2(length), HPKE_V1, suiteId, encoder.encode(label), info);
  const out = new Uint8Array(length);
  let previous = EMPTY;
  let at = 0;
  for (let counter = 1; at < length; counter++) {
    previous = hmac(sha256, prk, cat(previous, labeled, Uint8Array.of(counter)));
    out.set(previous.subarray(0, Math.min(previous.length, length - at)), at);
    at += previous.length;
  }
  return out;
}

/**
 * §4.1 `ExtractAndExpand`: DH → the KEM shared secret. Both KDF calls use the
 * KEM suite id, NOT the HPKE one — swapping them silently derives a different
 * secret that still "works" against itself (the mutation P1 names).
 */
function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, "eae_prk", dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, N_HASH);
}

/** §5.1 key schedule for Auth mode with no PSK: `(key, base_nonce)` for the single shot. */
function keySchedule(
  sharedSecret: Uint8Array,
  info: Uint8Array,
): { key: Uint8Array; baseNonce: Uint8Array } {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "info_hash", info);
  const context = cat(Uint8Array.of(MODE_AUTH), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE_ID, secret, "key", context, 32),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", context, NONCE_BYTES),
  };
}

/** DH that refuses a low-order peer key (an all-zero secret) instead of deriving from it. */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  need(publicKey, KEY_BYTES, "a public key");
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, publicKey);
  } catch {
    throw new PushSealError("bad-key", "invalid X25519 public key");
  }
  let acc = 0;
  for (const b of shared) acc |= b;
  if (acc === 0) throw new PushSealError("bad-key", "low-order X25519 public key");
  return shared;
}

/** X25519 public key of a 32-byte private key — the sender half is the computer's static key. */
export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  need(privateKey, KEY_BYTES, "a private key");
  return x25519.getPublicKey(privateKey);
}

/**
 * The push key id of a computer's static public key:
 * `b64url(SHA-256("tentacle-push-kid/1" ‖ pk))[0..12]`. The extension tries the
 * paired computers it has pinned by this id; the same string is the AEAD `aad`,
 * so a ciphertext cannot be moved to another computer's envelope.
 */
export function pushKeyId(computerPublicKey: Uint8Array): string {
  need(computerPublicKey, KEY_BYTES, "a computer public key");
  const input = cat(encoder.encode(PUSH_KID_PREFIX), computerPublicKey);
  return encodeBase64Url(sha256(input)).slice(0, PUSH_KID_LENGTH);
}

/** The padded length for a plaintext of `length` bytes, or `undefined` when it cannot fit. */
export function pushPaddedLength(length: number): number | undefined {
  const needed = length + PUSH_LENGTH_BYTES;
  for (const bucket of PUSH_PAD_BUCKETS) if (needed <= bucket) return bucket;
  return undefined;
}

/** The largest plaintext this protocol can seal: the last bucket minus the length prefix (2046). */
export function maxPushPlaintextBytes(): number {
  return (PUSH_PAD_BUCKETS[PUSH_PAD_BUCKETS.length - 1] ?? 2048) - PUSH_LENGTH_BYTES;
}

/**
 * `u16` big-endian length, the plaintext, then zeros up to the bucket. Explicit
 * and trivial in Swift: task 17's extension reads the first two bytes and
 * ignores the rest — no "strip trailing zeros" guesswork (a plaintext may end in
 * a zero byte).
 */
function pad(plaintext: Uint8Array): Uint8Array {
  const bucket = pushPaddedLength(plaintext.length);
  if (bucket === undefined) {
    throw new PushSealError(
      "too-large",
      `a push plaintext must be at most ${maxPushPlaintextBytes()} bytes`,
    );
  }
  const out = new Uint8Array(bucket);
  out.set(i2osp2(plaintext.length), 0);
  out.set(plaintext, PUSH_LENGTH_BYTES);
  return out;
}

/** The reverse of {@link pad}: the declared length, then a tail that must be all zeros. */
function unpad(padded: Uint8Array): Uint8Array {
  let bucket: number | undefined;
  for (const candidate of PUSH_PAD_BUCKETS) if (candidate === padded.length) bucket = candidate;
  if (bucket === undefined) {
    throw new PushSealError("bad-padding", "a sealed push must be exactly one bucket long");
  }
  if (padded.length < PUSH_LENGTH_BYTES) throw new PushSealError("bad-padding", "no length prefix");
  const length = ((padded[0] ?? 0) << 8) | (padded[1] ?? 0);
  if (length + PUSH_LENGTH_BYTES > padded.length) {
    throw new PushSealError("bad-padding", "length prefix exceeds the bucket");
  }
  for (let i = PUSH_LENGTH_BYTES + length; i < padded.length; i++) {
    if (padded[i] !== 0) throw new PushSealError("bad-padding", "non-zero padding");
  }
  return padded.slice(PUSH_LENGTH_BYTES, PUSH_LENGTH_BYTES + length);
}

/**
 * HPKE Auth mode, single shot (§5.1.1 `SetupAuthS` + `Seal`, sequence number 0).
 * `senderStatic` is the sender's static X25519 private key, which in this
 * protocol is the COMPUTER's key, and `recipientPublicKey` the device's
 * per-device push key (generated at registration, separate from its Noise key).
 * `rng` provides the 32-byte ephemeral secret — injected so a vector can fix it.
 */
export function hpkeAuthSeal(input: HpkeAuthSealInput): HpkeAuthSealed {
  need(input.senderStatic, KEY_BYTES, "the sender static key");
  need(input.recipientPublicKey, KEY_BYTES, "the recipient public key");
  const ephemeral = input.rng(KEY_BYTES);
  need(ephemeral, KEY_BYTES, "the ephemeral key");
  const senderPub = publicKeyOf(input.senderStatic);
  const enc = x25519.getPublicKey(ephemeral);
  // AuthEncap: DH(skE, pkR) ‖ DH(skS, pkR) — the second half is what authenticates us.
  const kemContext = cat(enc, input.recipientPublicKey, senderPub);
  const sharedSecret = extractAndExpand(
    cat(dh(ephemeral, input.recipientPublicKey), dh(input.senderStatic, input.recipientPublicKey)),
    kemContext,
  );
  const { key, baseNonce } = keySchedule(sharedSecret, input.info);
  return { enc, ciphertext: chacha20poly1305(key, baseNonce, input.aad).encrypt(input.plaintext) };
}

/** The inverse of {@link hpkeAuthSeal}: §5.1.1 `SetupAuthR` + `Open`, sequence number 0. */
export function hpkeAuthOpen(input: {
  readonly sealed: HpkeAuthSealed;
  readonly aad: Uint8Array;
  readonly info: Uint8Array;
  readonly recipientStatic: Uint8Array;
  readonly senderPublicKey: Uint8Array;
}): Uint8Array {
  need(input.recipientStatic, KEY_BYTES, "the recipient static key");
  need(input.senderPublicKey, KEY_BYTES, "the sender public key");
  need(input.sealed.enc, KEY_BYTES, "the ephemeral public key");
  const recipientPub = publicKeyOf(input.recipientStatic);
  // AuthDecap: DH(skR, pkE) ‖ DH(skR, pkS).
  const kemContext = cat(input.sealed.enc, recipientPub, input.senderPublicKey);
  const sharedSecret = extractAndExpand(
    cat(
      dh(input.recipientStatic, input.sealed.enc),
      dh(input.recipientStatic, input.senderPublicKey),
    ),
    kemContext,
  );
  const { key, baseNonce } = keySchedule(sharedSecret, input.info);
  try {
    return chacha20poly1305(key, baseNonce, input.aad).decrypt(input.sealed.ciphertext);
  } catch {
    throw new PushSealError("bad-tag", "an HPKE Auth ciphertext did not authenticate");
  }
}

/**
 * Seal a padded push message for one device (the protocol on top of
 * {@link hpkeAuthSeal}): `info` = {@link PUSH_INFO}, `aad` = the key id.
 */
export function sealPush(
  plaintext: Uint8Array,
  senderStatic: Uint8Array,
  recipientPub: Uint8Array,
  rng: PushRng,
): SealedPush {
  const padded = pad(plaintext);
  const keyId = pushKeyId(publicKeyOf(senderStatic));
  const sealed = hpkeAuthSeal({
    plaintext: padded,
    aad: encoder.encode(keyId),
    info: encoder.encode(PUSH_INFO),
    senderStatic,
    recipientPublicKey: recipientPub,
    rng,
  });
  return { keyId, enc: sealed.enc, ciphertext: sealed.ciphertext };
}

/**
 * Open a sealed push. `recipientStatic` is the DEVICE's push private key and
 * `senderPub` the computer's static public key pinned at pairing: with the wrong
 * one the Auth-mode KEM derives a different secret and the AEAD fails — which
 * is exactly the "a relay cannot forge a push" property (F6). The key id is
 * checked first, so an envelope that names another computer is refused before
 * any decryption.
 */
export function openPush(
  sealed: SealedPush,
  recipientStatic: Uint8Array,
  senderPub: Uint8Array,
): Uint8Array {
  need(recipientStatic, KEY_BYTES, "the recipient static key");
  need(senderPub, KEY_BYTES, "the sender public key");
  if (sealed.keyId !== pushKeyId(senderPub)) {
    throw new PushSealError("bad-key", "the envelope names another computer's key");
  }
  const padded = hpkeAuthOpen({
    sealed,
    aad: encoder.encode(sealed.keyId),
    info: encoder.encode(PUSH_INFO),
    recipientStatic,
    senderPublicKey: senderPub,
  });
  return unpad(padded);
}
