/**
 * The laptop's own image bytes, for the refs a pod names
 * (docs/feat/attachments-prompt.md D5/D6).
 *
 * A pod `--model-proxy` session sends REFS to the laptop, which runs the model
 * (AGENTS §7 "model stays on the laptop"). The bytes therefore never leave the
 * laptop: this store holds them, in this process, and only for ids that
 * `attachImage` added itself — so a pod that names any other id (or a wrong
 * size) gets a placeholder, never a file read and never a wrong image
 * (`RemoteClient` passes this as the request's `attachments` source; the
 * provider re-verifies the sha256 on top).
 *
 * Bytes, never paths: a screenshot's temp file may be gone by the time the
 * model call runs. Never evicts, and refuses loudly when full: an eviction
 * would silently turn an image the user already sent into `[image unavailable]`.
 */
import type { AttachmentRef, AttachmentSource } from "@tentacle/core";

/** The laptop store's own cap (bytes), mirroring the daemon's per-session store. */
export const LAPTOP_IMAGE_BYTES = 100 * 1024 * 1024;

/** Thrown by `add` when the store would exceed its cap. Never evicts to make room. */
export class LaptopImagesFullError extends Error {
  constructor(held: number, incoming: number, maxBytes: number) {
    super(
      `the laptop's image store is full: ${held} B held + ${incoming} B new is over ${maxBytes} B (attached images are kept: restart the client to clear them)`,
    );
    this.name = "LaptopImagesFullError";
  }
}

/** The `AttachmentSource` a pod session's laptop-side requests carry. */
export class LaptopImages implements AttachmentSource {
  private readonly entries = new Map<string, Uint8Array>();
  private readonly maxBytes: number;
  private used = 0;

  constructor(opts: { maxBytes?: number } = {}) {
    this.maxBytes = opts.maxBytes ?? LAPTOP_IMAGE_BYTES;
  }

  /** Bytes held right now. */
  get held(): number {
    return this.used;
  }

  /** How many distinct images are held. */
  get count(): number {
    return this.entries.size;
  }

  /**
   * Keep `bytes` under `id` (the sha256 the caller computed from them). Adding
   * an id already held is a no-op (the same bytes, by content addressing), so
   * a re-attached image costs nothing. Throws `LaptopImagesFullError` rather
   * than evicting.
   */
  add(id: string, bytes: Uint8Array): void {
    if (this.entries.has(id)) {
      return;
    }
    if (this.used + bytes.length > this.maxBytes) {
      throw new LaptopImagesFullError(this.used, bytes.length, this.maxBytes);
    }
    this.entries.set(id, bytes);
    this.used += bytes.length;
  }

  /** True when `id` is held at exactly `size` — the synchronous twin of `read`. */
  holds(id: string, size: number): boolean {
    const held = this.entries.get(id);
    return held !== undefined && held.length === size;
  }

  /** The bytes of `ref`, or `null` (absent, or a size that disagrees). */
  async read(ref: AttachmentRef): Promise<Uint8Array | null> {
    const held = this.entries.get(ref.id);
    return held !== undefined && held.length === ref.size ? held : null;
  }
}
