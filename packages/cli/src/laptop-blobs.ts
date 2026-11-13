/**
 * The laptop side of durable images (docs/feat/attachments-durable.md D4/D5):
 * giving a (re)opened session back the images its history names, and the
 * words the user sees when that, or keeping one, fails. Free of the runtime:
 * `local-runtime.ts` binds the reads and the attach.
 */
import type { AttachmentRef } from "@tentacle/core";

/**
 * One session's disk behind its images (docs/feat/attachments-durable.md
 * D4/D5), as `persistingController` binds it: the refs to give back after a
 * (re)open, and the writes that keep what this laptop attaches.
 */
export interface DurableImages {
  /** The refs to re-send after a (re)open (empty for a fresh session). */
  readonly pending: readonly AttachmentRef[];
  /** One kept image's bytes, or `null` (absent, unreadable). */
  readonly read: (id: string) => Promise<Uint8Array | null>;
  /** Keeps one image this laptop attached, BEFORE the ref is returned. */
  readonly keep: (ref: AttachmentRef, bytes: Uint8Array, label: string) => Promise<void>;
  /** The run's notice channel (owner Q6: at most one per event). */
  readonly notify: (text: string) => void;
}

/** How a restore went: images re-sent, not on this laptop, or failing to re-send. */
export interface RestoreReport {
  readonly restored: number;
  readonly missing: number;
  readonly failed: number;
  /** The first failure's message (shown in the notice). */
  readonly firstError?: string;
}

/**
 * Give each ref's bytes back through `attach` (the ONE existing entry point:
 * upload, probe-only dedupe, or laptop-held), in order. `read` → `null` is
 * `missing`; an `attach` that throws is `failed`. Never throws.
 */
export async function restoreImages(
  refs: readonly AttachmentRef[],
  read: (id: string) => Promise<Uint8Array | null>,
  attach: (
    bytes: Uint8Array,
    meta: { readonly mimeType: string; readonly name?: string },
  ) => Promise<unknown>,
): Promise<RestoreReport> {
  let restored = 0;
  let missing = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const ref of refs) {
    const bytes = await read(ref.id).catch(() => null);
    if (bytes === null || bytes.length !== ref.size) {
      missing++;
      continue;
    }
    try {
      await attach(bytes, {
        mimeType: ref.mimeType,
        ...(ref.name !== undefined ? { name: ref.name } : {}),
      });
      restored++;
    } catch (error) {
      failed++;
      firstError ??= error instanceof Error ? error.message : String(error);
    }
  }
  return { restored, missing, failed, ...(firstError !== undefined ? { firstError } : {}) };
}

/** At most ONE notice for a restore (owner Q6, its wording); a full success is silent. */
export function restoreNotice(report: RestoreReport): string | null {
  const parts: string[] = [];
  if (report.missing > 0) {
    parts.push(
      `${report.missing} earlier image(s) of this session are not on this laptop — the model sees them as unavailable`,
    );
  }
  if (report.failed > 0) {
    parts.push(
      `${report.failed} earlier image(s) could not be re-sent: ${report.firstError ?? "unknown error"}`,
    );
  }
  return parts.length === 0 ? null : `⚠ ${parts.join("; ")}`;
}

/** The notice for an image this laptop could not keep (owner Q6). */
export function keepFailedNotice(label: string, why: string): string {
  return `⚠ image ${label} could not be saved on this laptop — after a restart the model will see it as unavailable (${why})`;
}

/** Bytes already kept for one session (the per-session cap's used side). */
export function keptBytes(index: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const size of index.values()) total += size;
  return total;
}

/**
 * Keeps each image the user attaches beside its session's log
 * (docs/feat/attachments-durable.md D4), with the two rules the user sees:
 * the per-session cap, and at most ONE notice per session (owner Q6) — the
 * image still works for this run, so a second failure adds nothing.
 */
export class LaptopKeeper {
  private readonly write: (id: string, bytes: Uint8Array) => Promise<void>;
  private readonly used: () => number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly notice: (text: string) => void;
  /** The ONE notice this session shows (owner Q6: per event, not per image). */
  private warned = false;

  constructor(opts: {
    /** `SessionSaver.putBlob`'s bound half: rejects when the write failed. */
    readonly write: (id: string, bytes: Uint8Array) => Promise<void>;
    /** Bytes already kept for this session. */
    readonly used: () => number;
    readonly maxBytes: number;
    /** A write slower than this is given up on (the attach never waits on a disk). */
    readonly timeoutMs: number;
    readonly notice: (text: string) => void;
  }) {
    this.write = opts.write;
    this.used = opts.used;
    this.maxBytes = opts.maxBytes;
    this.timeoutMs = opts.timeoutMs;
    this.notice = opts.notice;
  }

  /**
   * Keep `bytes` under `ref.id` before the ref can enter any history. Never
   * throws and never blocks past `timeoutMs`: a failed, slow or over-cap write
   * is one notice, and the attach goes on.
   */
  async keep(ref: AttachmentRef, bytes: Uint8Array, label: string): Promise<void> {
    if (this.used() + bytes.length > this.maxBytes) {
      this.warn(keepFailedNotice(label, "the laptop image store for this session is full"));
      return;
    }
    try {
      await this.bounded(this.write(ref.id, bytes));
    } catch (error) {
      this.warn(keepFailedNotice(label, error instanceof Error ? error.message : String(error)));
    }
  }

  private warn(text: string): void {
    if (this.warned) return;
    this.warned = true;
    this.notice(text);
  }

  private bounded(writing: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      writing,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`not written within ${this.timeoutMs}ms`)),
          this.timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer));
  }
}
