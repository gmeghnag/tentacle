/**
 * What to DO with one picked PDF (docs/feat/pdf-read.md D7) — pure, so every
 * refusal is testable without a simulator.
 *
 * The rule is `photo-input.ts`'s, applied to a document: **the type comes from
 * the BYTES** (`isPdf`, `@tentacle/core`). iOS gives `getDocumentAsync` a file
 * whose MIME type and extension are the provider's claim — a `.pdf` from Mail or
 * Files is often a text file someone renamed, and a scanned web page saved as
 * `.pdf` is not a PDF at all — so the picker's word is a hint, never evidence.
 * The phone also never PARSES a PDF (no pdf.js in Hermes): the trusted daemon
 * extracts the text, and this module only decides whether the bytes may go.
 *
 * The one case that is not a refusal by type: an **iCloud placeholder**. Files
 * hands back a zero-byte copy for a file that is not downloaded, which is
 * indistinguishable from an empty pick by its bytes ALONE — the picker's own
 * size, when it reports one, is what tells the two apart, and the two need
 * different words ("download it first" vs "pick something").
 */
import {
  ATTACHMENT_NAME_MAX_CHARS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  formatBytes,
  isPdf,
  sanitizeAttachmentName,
} from "@tentacle/core";

/** Why a picked PDF is not going out with this message. */
export type PdfRefusal =
  /** Zero bytes and nothing measured: nothing was picked, or the copy came back empty. */
  | "empty"
  /** The message already holds `MAX_ATTACHMENTS_PER_MESSAGE` (photos count too). */
  | "too-many"
  /** Over the byte cap (`MAX_PDF_ATTACH_BYTES`, or the daemon's smaller one). */
  | "too-large"
  /** Not a PDF: the header says so, whatever the name or the MIME type claimed. */
  | "not-a-pdf"
  /** A zero-byte copy of a file iCloud has not downloaded. */
  | "not-downloaded";

/**
 * The name a document block carries when the pick gave nothing usable.
 *
 * The wire requires a name (`DocumentContentSchema.name` is `.min(1)`), so a
 * nameless pick must invent one rather than send an empty string the daemon
 * would refuse — a whole message lost over a missing name.
 */
export const DEFAULT_PDF_NAME = "document.pdf";

/**
 * The per-document byte cap this build sends: the upload cap
 * (`MAX_IMAGE_BYTES`), because `attachment/put` and `DocumentSourceSchema.size`
 * are both bounded by it. A daemon may advertise less (its capability's
 * `maxBytes`); it can never usefully advertise more.
 */
export const MAX_PDF_ATTACH_BYTES = MAX_IMAGE_BYTES;

/** One PDF as the pipeline sees it. */
export interface PdfState {
  /** The bytes as they came off the picked file. */
  readonly bytes: Uint8Array;
  /**
   * The picker's reported size, when it reports one (`DocumentPickerAsset.size`).
   * Only used to tell an iCloud placeholder from an empty pick: a zero-byte copy
   * of a file that IS 240 KB is not empty, it is not downloaded.
   */
  readonly declaredSize?: number;
  /** The picker's file name. Display only; sanitised below, never trusted. */
  readonly name?: string | null;
  /** How many attachments the message already holds — photos count too. */
  readonly taken: number;
  /** The daemon's own cap when it advertises a smaller one (default `MAX_PDF_ATTACH_BYTES`). */
  readonly maxBytes?: number;
}

/** A PDF that may be handed to the client: the size the wire needs, and a safe name. */
export interface ReadyPdf {
  readonly name: string;
  readonly size: number;
}

/** The answer: send it, or refuse it with a reason a chip can show. */
export type PdfStep =
  | { readonly kind: "ready"; readonly pdf: ReadyPdf }
  | { readonly kind: "refuse"; readonly reason: PdfRefusal; readonly detail: string };

function refuse(reason: PdfRefusal, detail: string): PdfStep {
  return { kind: "refuse", reason, detail };
}

/**
 * The name a document block carries: the wire's own rule
 * (`sanitizeAttachmentName` — `ATTACHMENT_NAME_RE`, imported, never copied),
 * with a placeholder when nothing usable is left. Never an empty string: the
 * daemon's schema refuses one, and the refusal would take the WHOLE message.
 */
export function pdfName(raw: string | null | undefined): string {
  const safe = raw === null || raw === undefined ? undefined : sanitizeAttachmentName(raw);
  return safe === undefined || safe === "" ? DEFAULT_PDF_NAME : safe;
}

/** The decision for one picked file. Pure: the adapter performs every effect. */
export function nextPdfStep(state: PdfState): PdfStep {
  const size = state.bytes.length;
  if (size === 0) {
    // Two different faults behind one zero-byte copy, and only the picker's own
    // measurement tells them apart (see the module comment).
    return (state.declaredSize ?? 0) > 0
      ? refuse(
          "not-downloaded",
          `“${pdfName(state.name)}” is not downloaded from iCloud — open it once in Files, then pick it again`,
        )
      : refuse("empty", "the picked file has no bytes");
  }
  if (state.taken >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return refuse(
      "too-many",
      `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments (photos and files together)`,
    );
  }
  if (!isPdf(state.bytes.subarray(0, PDF_SNIFF_BYTES))) {
    // The header is the evidence: a renamed text file, a video, a truncated
    // download. Sending it would make the daemon answer "corrupt PDF" about a
    // file the phone could have refused at the pick.
    return refuse("not-a-pdf", `“${pdfName(state.name)}” is not a PDF`);
  }
  const maxBytes = state.maxBytes ?? MAX_PDF_ATTACH_BYTES;
  if (size > maxBytes) {
    return refuse(
      "too-large",
      `${formatBytes(size)} is over the ${formatBytes(maxBytes)} limit for one file`,
    );
  }
  return { kind: "ready", pdf: { name: pdfName(state.name), size } };
}

/**
 * How much of the file the sniff reads. `isPdf` searches this window for the
 * header (a printable prefix is allowed — an HTTP body, a stray banner), so the
 * window is what `PDF_HEAD_BYTES` already bounds; a bigger one only reads more
 * bytes into memory for nothing.
 */
const PDF_SNIFF_BYTES = 1024;

/**
 * The name of one pick's sandbox COPY, unique per pick.
 *
 * The copy is written `overwrite: false` (like a photo's), so two picks landing
 * in the same millisecond under the same name — two files both called
 * `report.pdf`, or two names that clip to one string — must not resolve to one
 * file: the first outbox item would then send the second PDF's bytes, silently.
 * The `seq` part (a per-process counter, the adapter's) makes that impossible,
 * and `overwrite: false` turns any remaining collision into a visible failure
 * instead of swapped bytes.
 *
 * The name is ASCII-only and capped as a WHOLE name: a copy's name is a
 * FILESYSTEM name, not a ref's, so it inherits neither the wire's 255-character
 * budget (which the `<stamp>-<seq>-` prefix would already overflow) nor its
 * Unicode. The `.pdf` extension keeps its room, so a truncated copy still says
 * what it is.
 */
export function pdfCopyName(
  name: string | undefined | null,
  pick: { readonly stamp: number; readonly seq: number },
): string {
  const safe =
    name === undefined || name === null || name === ""
      ? undefined
      : name.replace(/[^A-Za-z0-9._-]/g, "_");
  const at = safe === undefined ? -1 : safe.lastIndexOf(".");
  // No extension (a name like `scan` or `.hidden`): the whole string is the stem.
  const stem = safe === undefined ? "" : at <= 0 ? safe : safe.slice(0, at);
  // Always this build's own extension, lower-cased: the copy holds the bytes
  // that were sniffed as a PDF, so it says `.pdf` however the pick spelled it.
  const extension = ".pdf";
  const prefix = `${pick.stamp}-${pick.seq}-`;
  const budget = ATTACHMENT_NAME_MAX_CHARS - prefix.length - extension.length;
  const clipped = clipToUnits(stem === "" ? "document" : stem, budget);
  return `${prefix}${clipped}${extension}`;
}

/**
 * `text` cut to at most `max` UTF-16 units — the cap's own unit, never splitting
 * a surrogate pair (by the same rule, and for the same reason, as
 * `sanitizeAttachmentName`'s cap). The name is ASCII by then; the rule is kept
 * anyway so a future non-ASCII source cannot split a character.
 */
function clipToUnits(text: string, max: number): string {
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > max) {
      break;
    }
    kept += char;
  }
  return kept;
}
