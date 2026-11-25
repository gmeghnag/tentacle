// Chrome native-messaging framing (F3/F4): a 32-bit length in NATIVE byte
// order, then UTF-8 JSON. Host → Chrome is capped at 1 MB, Chrome → host at
// 64 MiB. Pure: no I/O.
import { endianness } from "node:os";
import { HOST_TO_CHROME_MAX_BYTES } from "./link-schema.ts";

export const CHROME_TO_HOST_MAX_BYTES = 64 * 1024 * 1024;

const NATIVE_LE = endianness() === "LE";

/** One host → Chrome message; throws when the JSON is over 1 MB (F4). */
export function encodeNative(value: unknown, littleEndian: boolean = NATIVE_LE): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(value));
  if (body.length > HOST_TO_CHROME_MAX_BYTES) {
    throw new Error(`message of ${body.length} bytes exceeds Chrome's 1 MB host limit`);
  }
  const out = new Uint8Array(4 + body.length);
  new DataView(out.buffer).setUint32(0, body.length, littleEndian);
  out.set(body, 4);
  return out;
}

export interface NativeDecoderHandlers {
  onMessage(value: unknown): void;
  /** Called once; the decoder is dead afterwards (every later byte ignored). */
  onViolation(reason: string): void;
}

/** Chrome → host stream decoder: chunk boundaries are arbitrary. */
export class NativeDecoder {
  private buf = new Uint8Array(0);
  private isDead = false;

  constructor(
    private readonly handlers: NativeDecoderHandlers,
    private readonly littleEndian: boolean = NATIVE_LE,
    private readonly maxBytes: number = CHROME_TO_HOST_MAX_BYTES,
  ) {}

  get dead(): boolean {
    return this.isDead;
  }

  push(chunk: Uint8Array): void {
    if (this.isDead) return;
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf, 0);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    while (!this.isDead && this.buf.length >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset, 4).getUint32(
        0,
        this.littleEndian,
      );
      if (len > this.maxBytes) {
        this.violate(`message length ${len} exceeds ${this.maxBytes}`);
        return;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.slice(4, 4 + len);
      this.buf = this.buf.slice(4 + len);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(body));
      } catch {
        this.violate("message is not JSON");
        return;
      }
      this.handlers.onMessage(value);
    }
  }

  private violate(reason: string): void {
    this.isDead = true;
    this.buf = new Uint8Array(0);
    this.handlers.onViolation(reason);
  }
}
