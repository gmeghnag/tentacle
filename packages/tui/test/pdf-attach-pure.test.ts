/**
 * The pure half of an attached PDF (docs/feat/pdf-read.md D5/D6, slice P5):
 * chips, rows, and the one view-model the transcript reads.
 *
 * Pure, so the whole shape is pinned without a terminal: what a chip says before
 * a page count is known, what a stored message's row says, and — the property
 * the "hide the block" rule turns on — that a `media` message loses its `<file>`
 * block while one WITHOUT `media` keeps its content raw.
 */
import { describe, expect, test } from "bun:test";
import { attachedDocument, splitFileBlocks } from "@tentacle/core";
import {
  DOCUMENT_GLYPH,
  NO_DOCUMENT_SEAM,
  documentChipLabel,
  documentRowText,
  documentUploadText,
  mediaRowText,
  userMessageView,
} from "../src/pdf-attach.ts";

describe("the chip", () => {
  test("before a page count is known: `reading…` (the daemon's fact is not invented)", () => {
    expect(documentChipLabel("report.pdf")).toBe("report.pdf · reading…");
    // A page count that is not a count (0) is not one either.
    expect(documentChipLabel("report.pdf", 0)).toBe("report.pdf · reading…");
  });

  test("with a page count: `name · N pp` (D5's wording)", () => {
    expect(documentChipLabel("report.pdf", 2)).toBe("report.pdf · 2 pp");
    expect(documentChipLabel("report.pdf", 12)).toBe("report.pdf · 12 pp");
  });

  test("an upload's own row names the file it is reading", () => {
    expect(documentUploadText("report.pdf")).toContain("report.pdf");
  });

  test("the glyph is the chip's, so a PDF is distinguishable on a mixed row", () => {
    expect(DOCUMENT_GLYPH).not.toBe("");
  });
});

describe("the transcript row", () => {
  test("a known page count is shown; an unknown one is not invented", () => {
    expect(documentRowText("report.pdf", 2)).toBe("[pdf: report.pdf · 2 pp]");
    expect(documentRowText("report.pdf")).toBe("[pdf: report.pdf]");
  });

  test("`media` becomes the row, and an unknown kind is still named (never dropped)", () => {
    expect(mediaRowText({ kind: "pdf", name: "r.pdf", pages: 3 })).toBe("[pdf: r.pdf · 3 pp]");
    // A newer build's kind: labelled plainly, not silently lost.
    expect(mediaRowText({ kind: "audio", name: "clip.m4a" })).toBe("[audio: clip.m4a]");
  });
});

describe("userMessageView — the block is hidden, the chip is shown", () => {
  const { block } = attachedDocument({
    name: "report.pdf",
    pages: 2,
    text: "--- page 1 / 2 ---\nthe body",
  });

  test("`media` present: prose kept, block gone, one row per file", () => {
    const view = userMessageView(`summarise this\n${block}`, [
      { kind: "pdf", name: "report.pdf", pages: 2, chars: 20 },
    ]);
    expect(view.text).toBe("summarise this");
    expect(view.rows).toEqual(["[pdf: report.pdf · 2 pp]"]);
    // The block's own text is NOWHERE: the model has it, the user has the file.
    expect(view.text).not.toContain("the body");
    expect(view.text).not.toContain("<file");
  });

  test("a PDF-only prompt: no text left, its row alone (the row is the whole bubble)", () => {
    const view = userMessageView(block, [{ kind: "pdf", name: "report.pdf", pages: 2 }]);
    expect(view.text).toBe("");
    expect(view.rows).toHaveLength(1);
  });

  test("NO media (an older log): the content is RAW — never a guess about which block", () => {
    const raw = `hello\n${block}`;
    const view = userMessageView(raw, undefined);
    expect(view.text).toBe(raw);
    expect(view.rows).toEqual([]);
    // …and an EMPTY media list is the same absence, not "there was a file".
    expect(userMessageView(raw, [])).toEqual({ text: raw, rows: [] });
  });

  test("prose with no block at all round-trips (no phantom row, no lost text)", () => {
    const view = userMessageView("just words", [{ kind: "pdf", name: "x.pdf", pages: 1 }]);
    expect(view.text).toBe("just words");
  });

  test("the block it removes is exactly `splitFileBlocks`'s (one parser, not two)", () => {
    const split = splitFileBlocks(`a\n${block}\nb`);
    expect(userMessageView(`a\n${block}\nb`, [{ kind: "pdf", name: "report.pdf" }]).text).toBe(
      split.text,
    );
    expect(split.blocks).toHaveLength(1);
  });
});

describe("NO_DOCUMENT_SEAM", () => {
  test("is off, with a sentence a writer can read", () => {
    expect(NO_DOCUMENT_SEAM.kind).toBe("off");
    if (NO_DOCUMENT_SEAM.kind === "off") {
      expect(NO_DOCUMENT_SEAM.reason.length).toBeGreaterThan(0);
    }
  });
});
