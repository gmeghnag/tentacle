/**
 * The laptop side of durable images (docs/feat/attachments-durable.md D4/D5):
 * giving a (re)opened session back the images its history names, and the
 * words the user sees when that, or keeping one, fails. Free of the runtime:
 * `local-runtime.ts` binds the reads and the attach.
 */
import type { AttachmentRef } from "@tentacle/core";

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
      await attach(bytes, { mimeType: ref.mimeType, ...(ref.name !== undefined ? { name: ref.name } : {}) });
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
