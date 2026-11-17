/**
 * `pdf-input` (docs/feat/pdf-read.md D7): the phone's PDF decisions, pure.
 *
 * The rule the module exists for is `photo-input.ts`'s, applied to a document:
 * **the type comes from the BYTES**. iOS hands `getDocumentAsync` a file whose
 * MIME type and extension are the provider's claim — a `.pdf` from Mail or Files
 * can be a text file saved with the wrong name, and an iCloud placeholder is a
 * zero-byte copy that must be told apart from an empty pick (which would
 * otherwise be uploaded as a "PDF" and refused only by the daemon).
 *
 * Each `describe` names the mutation it is red on (AGENTS §9).
 */
import { describe, expect, test } from "bun:test";
import {
  ATTACHMENT_NAME_MAX_CHARS,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
} from "@tentacle/core";
import { DocumentContentSchema } from "@tentacle/protocol";
import { MAX_PDF_ATTACH_BYTES, nextPdfStep, pdfCopyName, pdfName } from "../src/pdf-input.ts";

const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

/** Bytes: `head` then `pad` filler bytes (a plausible PDF body). */
function bytesOf(head: readonly number[], pad: number): Uint8Array {
  const bytes = new Uint8Array(head.length + pad);
  bytes.set(head, 0);
  for (let i = head.length; i < bytes.length; i += 1) {
    bytes[i] = i % 251;
  }
  return bytes;
}

const PDF = bytesOf(ascii("%PDF-1.4\n"), 64);
/** A `.pdf` whose bytes are prose: the MIME/extension claim is a lie. */
const NOT_PDF = bytesOf(ascii("This is a text file someone renamed.\n"), 16);

/** A wire-legal document block around `name`, to prove the name is sendable. */
function wireName(name: string): string | undefined {
  const parsed = DocumentContentSchema.safeParse({
    type: "document",
    kind: "pdf",
    name,
    source: { type: "ref", id: "a".repeat(64), size: 1024 },
  });
  return parsed.success ? parsed.data.name : undefined;
}

describe("pdfName — the wire's own name rule, never a local one", () => {
  test("a plain name passes through", () => {
    expect(pdfName("report.pdf")).toBe("report.pdf");
  });

  test("nothing usable becomes document.pdf (never an empty name, which the wire refuses)", () => {
    expect(pdfName("")).toBe("document.pdf");
    expect(pdfName(undefined)).toBe("document.pdf");
    expect(pdfName(null)).toBe("document.pdf");
    // A name that is nothing BUT refused characters sanitises to nothing.
    expect(pdfName("\u0000\u0007")).toBe("document.pdf");
  });

  test("control characters are stripped by ATTACHMENT_NAME_RE, not a copy of it", () => {
    expect(pdfName("re\u0000port\u0085.pdf")).toBe("report.pdf");
  });

  test("a long name is capped to the wire's bound and still parses", () => {
    const named = pdfName(`${"a".repeat(400)}.pdf`);
    expect(named).toBeDefined();
    expect(named.length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_CHARS);
    expect(wireName(named)).toBe(named);
  });
});

describe("nextPdfStep — sniff the header, then the caps", () => {
  test("a PDF header is ready, with its size and safe name", () => {
    expect(nextPdfStep({ bytes: PDF, name: "report.pdf", taken: 0 })).toEqual({
      kind: "ready",
      pdf: { name: "report.pdf", size: PDF.length },
    });
  });

  test("a .pdf that is really text is refused, not uploaded", () => {
    // MUTATION M1: dropping the isPdf branch makes this ready.
    expect(nextPdfStep({ bytes: NOT_PDF, name: "notes.pdf", taken: 0 })).toMatchObject({
      kind: "refuse",
      reason: "not-a-pdf",
    });
  });

  test("a header behind a printable banner is still a PDF (an HTTP body, a save's junk)", () => {
    const banner = bytesOf(ascii("HTTP/1.1 200 OK\r\n\r\n%PDF-1.7\n"), 32);
    expect(nextPdfStep({ bytes: banner, taken: 0 })).toMatchObject({ kind: "ready" });
  });

  test("a header cut shorter than its version line is not a PDF", () => {
    expect(nextPdfStep({ bytes: bytesOf(ascii("%PDF-"), 0), taken: 0 })).toMatchObject({
      kind: "refuse",
      reason: "not-a-pdf",
    });
  });

  test("zero bytes with no reported size is empty", () => {
    expect(nextPdfStep({ bytes: new Uint8Array(0), taken: 0 })).toMatchObject({
      kind: "refuse",
      reason: "empty",
    });
  });

  test("zero bytes that the picker measured is an iCloud placeholder, not an empty pick", () => {
    // The two need different words: "pick something" vs "download it first".
    expect(
      nextPdfStep({ bytes: new Uint8Array(0), declaredSize: 240_000, taken: 0 }),
    ).toMatchObject({ kind: "refuse", reason: "not-downloaded" });
  });

  test("the 5-attachment cap refuses a sixth, counting photos too", () => {
    expect(nextPdfStep({ bytes: PDF, taken: MAX_ATTACHMENTS_PER_MESSAGE })).toMatchObject({
      kind: "refuse",
      reason: "too-many",
    });
    expect(nextPdfStep({ bytes: PDF, taken: MAX_ATTACHMENTS_PER_MESSAGE - 1 })).toMatchObject({
      kind: "ready",
    });
  });

  test("over the byte cap is refused, naming both sizes", () => {
    const huge = bytesOf(ascii("%PDF-1.4\n"), MAX_PDF_ATTACH_BYTES);
    const step = nextPdfStep({ bytes: huge, taken: 0 });
    expect(step).toMatchObject({ kind: "refuse", reason: "too-large" });
    if (step.kind === "refuse") {
      expect(step.detail).toContain("15 MB");
    }
  });

  test("exactly at the cap is allowed (the cap is the upload's own bound)", () => {
    const at = bytesOf(ascii("%PDF-1.4\n"), MAX_PDF_ATTACH_BYTES - "%PDF-1.4\n".length);
    expect(at.length).toBe(MAX_PDF_ATTACH_BYTES);
    expect(nextPdfStep({ bytes: at, taken: 0 })).toMatchObject({ kind: "ready" });
  });

  test("the cap the daemon advertises is honoured when it is smaller", () => {
    expect(nextPdfStep({ bytes: PDF, taken: 0, maxBytes: 8 })).toMatchObject({
      kind: "refuse",
      reason: "too-large",
    });
  });

  test("the default cap is the upload cap", () => {
    expect(MAX_PDF_ATTACH_BYTES).toBe(MAX_IMAGE_BYTES);
  });
});

describe("pdfCopyName — one file per pick, and it still says .pdf", () => {
  test("stamp and seq make two same-named picks different files", () => {
    const a = pdfCopyName("report.pdf", { stamp: 1_700_000_000_000, seq: 1 });
    const b = pdfCopyName("report.pdf", { stamp: 1_700_000_000_000, seq: 2 });
    expect(a).not.toBe(b);
    expect(a.endsWith(".pdf")).toBe(true);
    expect(b.endsWith(".pdf")).toBe(true);
  });

  test("the name is ASCII-clipped (a filesystem name, not a ref name)", () => {
    expect(pdfCopyName("répo rt.pdf", { stamp: 5, seq: 1 })).toBe("5-1-r_po_rt.pdf");
  });

  test("a name with no extension wears .pdf", () => {
    expect(pdfCopyName("scan", { stamp: 5, seq: 1 })).toBe("5-1-scan.pdf");
  });

  test("an absent name still makes a .pdf copy", () => {
    expect(pdfCopyName(undefined, { stamp: 5, seq: 1 })).toBe("5-1-document.pdf");
  });

  test("a very long name is capped as a WHOLE name, extension kept", () => {
    const copy = pdfCopyName(`${"a".repeat(400)}.pdf`, { stamp: 5, seq: 1 });
    expect(copy.length).toBeLessThanOrEqual(ATTACHMENT_NAME_MAX_CHARS);
    expect(copy.endsWith(".pdf")).toBe(true);
  });
});
