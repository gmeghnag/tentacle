/**
 * An attached PDF's rows and chips (docs/feat/pdf-read.md D5/D6): the pure half
 * of "a PDF is in this message".
 *
 * The TUI does not parse a PDF and does not import the extractor: the SESSION
 * decides where the bytes may live (`documentsInput()`) and produces the wire
 * `document` block (`attachDocument()`), which is the same seam an image uses
 * (`attachImage`). This module only names things — the chip the composer shows,
 * the row the transcript shows, and the sentence a refusal says — so the App
 * renders decisions instead of making them (AGENTS §7).
 *
 * A `DocumentMode` is STRUCTURAL on purpose (the `AttachMode` rule): the TUI
 * does not depend on `@tentacle/client`, so `DocumentsInput` fits here as-is.
 */
import { type MessageMedia, splitFileBlocks } from "@tentacle/core";

/**
 * What this session may do with a PDF:
 * - `upload`: the daemon holds the bytes and extracts them;
 * - `laptop`: a pod — this laptop extracts and only text is sent;
 * - `off`: refuse, with a sentence a user reads.
 */
export type DocumentMode =
  | { readonly kind: "upload" | "laptop"; readonly maxBytes: number }
  | { readonly kind: "off"; readonly reason: string };

/** What a session with no document seam says (the `NO_IMAGE_SEAM` shape). */
export const NO_DOCUMENT_SEAM: DocumentMode = {
  kind: "off",
  reason: "this session cannot read PDFs",
};

/** The glyph every document chip and row carries (`📄`), the eye's cue, not a decision. */
export const DOCUMENT_GLYPH = "📄";

/**
 * The composer chip for a PDF: `report.pdf · reading…` while nothing has been
 * extracted yet (the client knows no page count before the send — and in
 * `upload` mode it never learns one: the daemon extracts), else `name · N pp`.
 */
export function documentChipLabel(name: string, pages?: number): string {
  return pages === undefined || pages <= 0 ? `${name} · reading…` : `${name} · ${pages} pp`;
}

/** The ONE row an upload/extract row shows for a document (never two rows). */
export function documentUploadText(name: string): string {
  return `reading ${name}…`;
}

/**
 * A user row's document line, the `[image: name]` shape: `[pdf: report.pdf · 2 pp]`
 * when the page count is known, `[pdf: report.pdf]` when it is not (an uploaded
 * PDF the daemon extracted — the client never saw the count on this turn).
 */
export function documentRowText(name: string, pages?: number): string {
  return pages === undefined || pages <= 0 ? `[pdf: ${name}]` : `[pdf: ${name} · ${pages} pp]`;
}

/**
 * The rows a stored message's `media` earns (a resumed user message): the same
 * `[pdf: …]` line as a live one, built from the chip entry the daemon persisted.
 * A `kind` this build does not know is labelled plainly, never dropped silently
 * (a `media` entry the daemon wrote is still a fact about the message).
 */
export function mediaRowText(media: MessageMedia): string {
  if (media.kind === "pdf") {
    return documentRowText(media.name, media.pages);
  }
  return `[${media.kind}: ${media.name}]`;
}

/** A user message's text, as the transcript shows it: prose plus `[pdf: …]` rows. */
export interface UserMessageView {
  /** The text the user typed — the file blocks are GONE (they are the model's copy). */
  readonly text: string;
  /** One row per attached file, in the order the daemon recorded them. */
  readonly rows: readonly string[];
}

/**
 * What a stored user message looks like (D5): with `media` — a document was
 * attached — the `<file …>` blocks are stripped (the model has the text; the
 * user has the file) and each chip becomes one row. WITHOUT `media` (an older
 * log, a build that dropped the field) the content is shown RAW: honest
 * degradation, never a guess about which `<file>` block was a PDF.
 */
export function userMessageView(
  content: string,
  media: readonly MessageMedia[] | undefined,
): UserMessageView {
  if (media === undefined || media.length === 0) {
    return { text: content, rows: [] };
  }
  const split = splitFileBlocks(content);
  return {
    // Blocks removed, prose trimmed: the SAME shape `splitFileBlocks` promises
    // (a prompt that was only a PDF has no text left, and its rows are the row).
    text: split.text,
    rows: media.map(mediaRowText),
  };
}
