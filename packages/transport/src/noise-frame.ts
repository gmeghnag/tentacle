/**
 * The secure channel's framing, pure (docs/feat/e2e-channel.md, Framing). A
 * wire frame is the text `t1:` + canonical base64 of ONE Noise message, so it
 * rides today's text-only `DuplexChannel`. A message's plaintext is one type
 * byte + up to `MAX_CHUNK` bytes of the UTF-8 encoded RPC frame: bytes are
 * split, never characters, and the type byte is inside the AEAD.
 */
import { MAX_NOISE_MESSAGE, NoiseError, TAGLEN } from "./noise.ts";

/** Names this channel's framing; covered by the prologue's version. */
export const FRAME_TAG = "t1:";
/** Base64 of the largest Noise message, plus the tag. */
export const MAX_FRAME_TEXT = FRAME_TAG.length + Math.ceil(MAX_NOISE_MESSAGE / 3) * 4;
/** Content bytes per transport message: the Noise maximum less the tag and the type byte. */
export const MAX_CHUNK = MAX_NOISE_MESSAGE - TAGLEN - 1;

export const TYPE_CONTINUATION = 0x00;
export const TYPE_FINAL = 0x01;
/** The handshake's third flight; never valid once the channel is up. */
export const TYPE_CONFIRM = 0x02;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Int16Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

const encoder = new TextEncoder();
/** `ignoreBOM`: a leading U+FEFF is content, not a marker; the channel is transparent. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** RFC 4648 base64 with padding (no `Buffer`/`btoa`: the app's Hermes has neither for certain). */
export function encodeBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let line = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    line +=
      ALPHABET.charAt(n >> 18) +
      ALPHABET.charAt((n >> 12) & 63) +
      ALPHABET.charAt((n >> 6) & 63) +
      ALPHABET.charAt(n & 63);
    if (line.length >= 8192) {
      parts.push(line);
      line = "";
    }
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    line += `${ALPHABET.charAt(n >> 18)}${ALPHABET.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    line += `${ALPHABET.charAt(n >> 18)}${ALPHABET.charAt((n >> 12) & 63)}${ALPHABET.charAt((n >> 6) & 63)}=`;
  }
  parts.push(line);
  return parts.join("");
}

function sextet(text: string, at: number): number {
  const code = text.charCodeAt(at);
  const v = code < 128 ? (LOOKUP[code] ?? -1) : -1;
  if (v < 0) throw new NoiseError("bad-frame", "invalid base64 character");
  return v;
}

/** Strict decode: only the canonical encoding of some byte string is accepted. */
export function decodeBase64(text: string): Uint8Array {
  if (text.length % 4 !== 0) throw new NoiseError("bad-frame", "base64 length not a multiple of 4");
  const pad = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - pad);
  let o = 0;
  const full = text.length - (pad > 0 ? 4 : 0);
  for (let i = 0; i < full; i += 4) {
    const n =
      (sextet(text, i) << 18) |
      (sextet(text, i + 1) << 12) |
      (sextet(text, i + 2) << 6) |
      sextet(text, i + 3);
    out[o++] = n >> 16;
    out[o++] = (n >> 8) & 0xff;
    out[o++] = n & 0xff;
  }
  if (pad > 0) {
    const a = sextet(text, full);
    const b = sextet(text, full + 1);
    if (pad === 2) {
      // The unused low 4 bits must be zero, or two texts would mean one byte.
      if ((b & 0x0f) !== 0) throw new NoiseError("bad-frame", "non-canonical base64");
      out[o++] = (a << 2) | (b >> 4);
    } else {
      const c = sextet(text, full + 2);
      if ((c & 0x03) !== 0) throw new NoiseError("bad-frame", "non-canonical base64");
      out[o++] = (a << 2) | (b >> 4);
      out[o++] = ((b & 0x0f) << 4) | (c >> 2);
    }
  }
  return out;
}

export function encodeFrame(message: Uint8Array): string {
  return FRAME_TAG + encodeBase64(message);
}

/** One wire frame → one Noise message. The length is checked before any decoding. */
export function decodeFrame(text: string): Uint8Array {
  if (text.length > MAX_FRAME_TEXT) {
    throw new NoiseError("bad-frame", `frame too long (${text.length} characters)`);
  }
  if (!text.startsWith(FRAME_TAG)) {
    throw new NoiseError("bad-frame", `not a secure-channel frame (no ${FRAME_TAG} tag)`);
  }
  return decodeBase64(text.slice(FRAME_TAG.length));
}

/** One RPC frame → the plaintexts of its transport messages (type byte + content). */
export function chunk(data: string): Uint8Array[] {
  const bytes = encoder.encode(data);
  const out: Uint8Array[] = [];
  let at = 0;
  do {
    const part = bytes.subarray(at, at + MAX_CHUNK);
    at += part.length;
    const plaintext = new Uint8Array(part.length + 1);
    plaintext[0] = at >= bytes.length ? TYPE_FINAL : TYPE_CONTINUATION;
    plaintext.set(part, 1);
    out.push(plaintext);
  } while (at < bytes.length);
  return out;
}

/**
 * Transport plaintexts → whole RPC frames. Bytes are concatenated before the
 * UTF-8 decode (a character split across chunks survives); the total is capped.
 */
export class Reassembler {
  private parts: Uint8Array[] = [];
  private size = 0;
  constructor(private readonly maxMessageBytes: number) {}

  /** The whole frame on a `final`, else null. Throws `bad-frame` on a violation. */
  push(plaintext: Uint8Array): string | null {
    const type = plaintext[0];
    if (type !== TYPE_CONTINUATION && type !== TYPE_FINAL) {
      throw new NoiseError("bad-frame", `unexpected message type ${String(type)}`);
    }
    const content = plaintext.subarray(1);
    if (this.size + content.length > this.maxMessageBytes) {
      throw new NoiseError("bad-frame", `message exceeds ${this.maxMessageBytes} bytes`);
    }
    this.parts.push(content);
    this.size += content.length;
    if (type === TYPE_CONTINUATION) return null;
    const whole = new Uint8Array(this.size);
    let at = 0;
    for (const p of this.parts) {
      whole.set(p, at);
      at += p.length;
    }
    this.parts = [];
    this.size = 0;
    return decoder.decode(whole);
  }
}
