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
 *
 * A miss may fall back to this laptop's DISK (docs/feat/attachments-durable.md
 * D6: a 2nd TUI that is the model link, a pod turn resumed before any send) —
 * but only for the sessions THIS client built (`allowSession`), and only
 * through the injected `fallback`, which reads the blob dir the laptop wrote
 * from its own attaches. The scope is the laptop's own publication, never a
 * ref in a (pod-supplied) log; a pod still chooses only the id.
 */
import type { AttachmentRef, AttachmentSource } from "@tentacle/core";
import { ATTACHMENT_ID_RE } from "@tentacle/protocol";

/** Reads `<uid>.attachments/<ref.id>` from the laptop's store (`null`: absent). */
export type LaptopImageFallback = (uid: string, ref: AttachmentRef) => Promise<Uint8Array | null>;

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
  private readonly fallback: LaptopImageFallback | undefined;
  /** The session uids this client built: the only ones `fallback` is asked about. */
  private readonly allowed = new Set<string>();
  private used = 0;

  constructor(opts: { maxBytes?: number; fallback?: LaptopImageFallback } = {}) {
    this.maxBytes = opts.maxBytes ?? LAPTOP_IMAGE_BYTES;
    this.fallback = opts.fallback;
  }

  /** Let `read` fall back to `uid`'s blobs on this laptop's disk (a session this client built). */
  allowSession(uid: string): void {
    this.allowed.add(uid);
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

  /**
   * The bytes of `ref`, or `null` (absent, or a size that disagrees). A miss
   * asks `fallback` for each allowed session, first hit wins; the id is
   * checked before (never a path from a malformed one), the size after, the
   * sha256 by the provider.
   */
  async read(ref: AttachmentRef): Promise<Uint8Array | null> {
    const held = this.entries.get(ref.id);
    if (held !== undefined) {
      return held.length === ref.size ? held : null;
    }
    if (this.fallback === undefined || !ATTACHMENT_ID_RE.test(ref.id)) {
      return null;
    }
    for (const uid of this.allowed) {
      const bytes = await this.fallback(uid, ref).catch(() => null);
      if (bytes !== null && bytes.length === ref.size) {
        return bytes;
      }
    }
    return null;
  }
}
