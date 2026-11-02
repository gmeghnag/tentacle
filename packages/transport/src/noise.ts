/**
 * Noise, spec revision 34 (noiseprotocol.org/noise.html), for exactly one
 * protocol: `Noise_IK_25519_ChaChaPoly_SHA256`. Pure and synchronous: no I/O,
 * no timers, no randomness of its own — every key, the ephemeral included, is
 * injected, which is what lets the published vectors drive it byte for byte
 * (docs/feat/e2e-channel.md). The only module that touches `@noble/*`.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";

export const PROTOCOL_NAME = "Noise_IK_25519_ChaChaPoly_SHA256";
export const DHLEN = 32;
export const HASHLEN = 32;
export const TAGLEN = 16;
/** The largest Noise message (spec §3). */
export const MAX_NOISE_MESSAGE = 65_535;

/**
 * Why a secure channel failed. `denied` is authenticated (only the holder of
 * the responder's static key can say it); every other kind is not.
 */
export type NoiseErrorKind = "denied" | "timeout" | "closed" | "handshake-failed" | "bad-frame";

export class NoiseError extends Error {
  readonly kind: NoiseErrorKind;
  constructor(kind: NoiseErrorKind, message: string) {
    super(message);
    this.name = "NoiseError";
    this.kind = kind;
  }
}

const EMPTY = new Uint8Array(0);
const encoder = new TextEncoder();

function concat(...parts: readonly Uint8Array[]): Uint8Array {
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

function need(bytes: Uint8Array, length: number, what: string): void {
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
    throw new NoiseError("handshake-failed", `${what} must be ${length} bytes`);
  }
}

/** X25519 public key of a 32-byte private key. */
export function publicKeyOf(privateKey: Uint8Array): Uint8Array {
  need(privateKey, DHLEN, "a private key");
  return x25519.getPublicKey(privateKey);
}

/**
 * DH(priv, pub). An all-zero output (a low-order public key) is refused here
 * rather than trusted to the library's default.
 */
function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  let shared: Uint8Array;
  try {
    shared = x25519.getSharedSecret(privateKey, publicKey);
  } catch {
    throw new NoiseError("handshake-failed", "invalid DH public key");
  }
  let acc = 0;
  for (const b of shared) acc |= b;
  if (acc === 0) throw new NoiseError("handshake-failed", "low-order DH public key");
  return shared;
}

/** HKDF(ck, ikm) → 2 outputs (spec §4.3), HMAC-SHA256. */
function hkdf2(ck: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmac(sha256, ck, ikm);
  const out1 = hmac(sha256, temp, Uint8Array.of(1));
  const out2 = hmac(sha256, temp, concat(out1, Uint8Array.of(2)));
  return [out1, out2];
}

/**
 * One direction's AEAD key and its implicit counter (spec §5.1). The counter
 * is a `number`, stopped at `Number.MAX_SAFE_INTEGER` — far below the spec's
 * 2^64-1 — and is taken BEFORE the ciphertext exists, so no path can reuse it.
 */
export class CipherState {
  private k: Uint8Array | null = null;
  private n: number;
  constructor(key?: Uint8Array, nonce = 0) {
    if (key) this.initializeKey(key);
    this.n = nonce;
  }

  initializeKey(key: Uint8Array): void {
    need(key, 32, "a cipher key");
    this.k = key;
    this.n = 0;
  }

  hasKey(): boolean {
    return this.k !== null;
  }

  get nonce(): number {
    return this.n;
  }

  /** 32 zero bits then the 64-bit little-endian counter (ChaChaPoly, spec §12.3). */
  private nextNonce(): Uint8Array {
    if (this.n >= Number.MAX_SAFE_INTEGER) {
      throw new NoiseError("closed", "nonce limit reached");
    }
    const n = this.n;
    this.n = n + 1;
    const out = new Uint8Array(12);
    const view = new DataView(out.buffer);
    view.setUint32(4, n >>> 0, true);
    view.setUint32(8, Math.floor(n / 2 ** 32), true);
    return out;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) return plaintext;
    return chacha20poly1305(this.k, this.nextNonce(), ad).encrypt(plaintext);
  }

  /** Throws on a tag failure; the counter is not advanced then (spec §5.1). */
  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) return ciphertext;
    const before = this.n;
    const nonce = this.nextNonce();
    try {
      return chacha20poly1305(this.k, nonce, ad).decrypt(ciphertext);
    } catch {
      this.n = before;
      throw new NoiseError("bad-frame", "decryption failed");
    }
  }
}

/** The handshake's chaining key and transcript hash (spec §5.2). */
export class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  private readonly cipher = new CipherState();

  constructor(protocolName: string) {
    const name = encoder.encode(protocolName);
    // ≤ HASHLEN: zero-padded; longer: hashed.
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h;
  }

  get handshakeHash(): Uint8Array {
    return this.h;
  }

  mixKey(ikm: Uint8Array): void {
    const [ck, temp] = hkdf2(this.ck, ikm);
    this.ck = ck;
    this.cipher.initializeKey(temp);
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(concat(this.h, data));
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    let plaintext: Uint8Array;
    try {
      plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    } catch {
      throw new NoiseError("handshake-failed", "handshake message failed to decrypt");
    }
    this.mixHash(ciphertext);
    return plaintext;
  }

  /** c1 carries initiator → responder, c2 the reverse. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, EMPTY);
    return [new CipherState(k1), new CipherState(k2)];
  }
}

export interface IkRoleOptions {
  /** This side's X25519 private key. */
  readonly staticKey: Uint8Array;
  /** This handshake's ephemeral private key (fresh randomness per connection). */
  readonly ephemeralKey: Uint8Array;
  readonly prologue: Uint8Array;
}

export interface Transport {
  readonly send: CipherState;
  readonly recv: CipherState;
  readonly handshakeHash: Uint8Array;
}

/** IK, `<- s` then `-> e, es, s, ss` then `<- e, ee, se`: the initiator. */
export class IkInitiator {
  private readonly ss = new SymmetricState(PROTOCOL_NAME);
  private readonly s: Uint8Array;
  private readonly sPub: Uint8Array;
  private readonly e: Uint8Array;
  private readonly ePub: Uint8Array;
  private readonly rs: Uint8Array;
  private step = 0;

  constructor(options: IkRoleOptions & { readonly remoteStatic: Uint8Array }) {
    need(options.remoteStatic, DHLEN, "the remote static key");
    this.s = options.staticKey;
    this.sPub = publicKeyOf(options.staticKey);
    this.e = options.ephemeralKey;
    this.ePub = publicKeyOf(options.ephemeralKey);
    this.rs = options.remoteStatic;
    this.ss.mixHash(options.prologue);
    this.ss.mixHash(this.rs);
  }

  writeMessage1(payload: Uint8Array): Uint8Array {
    this.advance(0);
    this.ss.mixHash(this.ePub);
    this.ss.mixKey(dh(this.e, this.rs));
    const s = this.ss.encryptAndHash(this.sPub);
    this.ss.mixKey(dh(this.s, this.rs));
    return concat(this.ePub, s, this.ss.encryptAndHash(payload));
  }

  readMessage2(message: Uint8Array): Uint8Array {
    this.advance(1);
    if (message.length < DHLEN + TAGLEN) {
      throw new NoiseError("handshake-failed", "handshake message 2 too short");
    }
    const re = message.subarray(0, DHLEN);
    this.ss.mixHash(re);
    this.ss.mixKey(dh(this.e, re));
    this.ss.mixKey(dh(this.s, re));
    return this.ss.decryptAndHash(message.subarray(DHLEN));
  }

  split(): Transport {
    this.advance(2);
    const [c1, c2] = this.ss.split();
    return { send: c1, recv: c2, handshakeHash: this.ss.handshakeHash };
  }

  private advance(expected: number): void {
    if (this.step !== expected) throw new NoiseError("handshake-failed", "handshake out of order");
    this.step += 1;
  }
}

/** IK, the responder: learns the initiator's static key from message 1. */
export class IkResponder {
  private readonly ss = new SymmetricState(PROTOCOL_NAME);
  private readonly s: Uint8Array;
  private readonly e: Uint8Array;
  private readonly ePub: Uint8Array;
  private rs: Uint8Array | null = null;
  private re: Uint8Array | null = null;
  private step = 0;

  constructor(options: IkRoleOptions) {
    this.s = options.staticKey;
    const sPub = publicKeyOf(options.staticKey);
    this.e = options.ephemeralKey;
    this.ePub = publicKeyOf(options.ephemeralKey);
    this.ss.mixHash(options.prologue);
    this.ss.mixHash(sPub);
  }

  /** The initiator's static public key, authenticated by message 1. */
  get remoteStatic(): Uint8Array {
    if (!this.rs) throw new NoiseError("handshake-failed", "message 1 not read yet");
    return this.rs;
  }

  readMessage1(message: Uint8Array): Uint8Array {
    this.advance(0);
    if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN) {
      throw new NoiseError("handshake-failed", "handshake message 1 too short");
    }
    const re = message.subarray(0, DHLEN);
    this.ss.mixHash(re);
    this.ss.mixKey(dh(this.s, re));
    const rs = this.ss.decryptAndHash(message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN));
    this.ss.mixKey(dh(this.s, rs));
    const payload = this.ss.decryptAndHash(message.subarray(DHLEN + DHLEN + TAGLEN));
    this.re = Uint8Array.from(re);
    this.rs = rs;
    return payload;
  }

  writeMessage2(payload: Uint8Array): Uint8Array {
    this.advance(1);
    const re = this.re;
    const rs = this.rs;
    if (!re || !rs) throw new NoiseError("handshake-failed", "message 1 not read yet");
    this.ss.mixHash(this.ePub);
    this.ss.mixKey(dh(this.e, re));
    this.ss.mixKey(dh(this.e, rs));
    return concat(this.ePub, this.ss.encryptAndHash(payload));
  }

  split(): Transport {
    this.advance(2);
    const [c1, c2] = this.ss.split();
    return { send: c2, recv: c1, handshakeHash: this.ss.handshakeHash };
  }

  private advance(expected: number): void {
    if (this.step !== expected) throw new NoiseError("handshake-failed", "handshake out of order");
    this.step += 1;
  }
}
