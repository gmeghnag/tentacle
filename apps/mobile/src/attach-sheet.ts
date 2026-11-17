/**
 * What the compose `+` sheet offers (docs/feat/pdf-read.md D7): pure, so the
 * one rule that matters — a PDF is offered ONLY when this session can actually
 * read it — is testable without rendering a sheet.
 *
 * The alternative is the failure the whole feature exists to avoid: a "File
 * (PDF)" row that accepts a pick, uploads nothing and then refuses at send, or
 * (worse, on a pod session) puts PDF bytes on a wire AGENTS §7 says they may
 * never cross. So the row is ABSENT, not disabled, and the sheet carries the
 * reason for the person who wonders where it went.
 */
import type { DocumentsInput } from "@tentacle/client";

/** The pickable kinds the sheet shows, in order. */
export type AttachKind = "photo" | "camera" | "pdf";

/** What the sheet offers right now, and why a PDF is missing when it is. */
export interface AttachSheet {
  readonly items: readonly AttachKind[];
  /** The sentence to show under the sheet when `pdf` is absent; `null` when it is offered. */
  readonly reason: string | null;
}

/** The photos rows are unconditional: their own capability is `image-input.ts`'s story. */
const BASE: readonly AttachKind[] = ["photo", "camera"];

/**
 * The sheet for one session's document capability.
 *
 * `upload` is the only mode the PHONE can serve: the bytes go by `attachment/put`
 * and the daemon extracts. `laptop` means the daemon expects THIS client to
 * extract the text — which a pod's laptop does with the CLI's binary extractor,
 * and the phone cannot (no pdf.js in Hermes, and the phone is never the pod's
 * laptop), so it is not offered and says so. `off` carries the client's own
 * sentence (`OLD_DAEMON_DOCUMENTS` or a trust refusal), used verbatim so no two
 * surfaces word it differently.
 */
export function attachSheet(input: DocumentsInput): AttachSheet {
  if (input.kind === "upload") {
    return { items: [...BASE, "pdf"], reason: null };
  }
  if (input.kind === "laptop") {
    return {
      items: BASE,
      reason: "this session expects this device to read the PDF, and the phone cannot",
    };
  }
  return { items: BASE, reason: input.reason };
}

/** Whether the sheet offers the PDF row at all (the screen's own guard, one place). */
export const offersPdf = (sheet: AttachSheet): boolean => sheet.items.includes("pdf");
