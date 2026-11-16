import { describe, expect, test } from "bun:test";
import {
  MAX_PAGES_PER_READ,
  PDF_HEAD_BYTES,
  buildPageText,
  fileBlock,
  formatPdfText,
  isPdf,
  isTextItem,
  looksLikeTextBytes,
  parsePageRange,
  pdfVerdict,
  splitFileBlocks,
} from "../src/pdf-text.ts";

/**
 * One pdf.js text item. `x`/`y` are the baseline origin (transform[4] and [5]),
 * `width` the item's advance — the three numbers the spacing heuristic reads.
 */
function item(
  str: string,
  opts: { x?: number; y?: number; width?: number; height?: number; hasEOL?: boolean } = {},
): unknown {
  const x = opts.x ?? 0;
  const y = opts.y ?? 100;
  return {
    str,
    dir: "ltr",
    width: opts.width ?? str.length * 5,
    height: opts.height ?? 10,
    transform: [1, 0, 0, 1, x, y],
    hasEOL: opts.hasEOL ?? false,
  };
}

/** ASCII bytes of `text`, optionally preceded by `pad` zero bytes. */
function pdfBytes(pad: number, text = "%PDF-1.7\n"): Uint8Array {
  const bytes = new Uint8Array(pad + text.length);
  for (let i = 0; i < text.length; i += 1) {
    bytes[pad + i] = text.charCodeAt(i);
  }
  return bytes;
}

describe("isTextItem", () => {
  test("a text item carries a string; a marked-content item does not", () => {
    expect(isTextItem(item("Hello"))).toBe(true);
    expect(isTextItem({ type: "beginMarkedContent", tag: "P" })).toBe(false);
    expect(isTextItem(null)).toBe(false);
    expect(isTextItem({ str: 42 })).toBe(false);
  });
});

describe("buildPageText — the owner's spacing heuristic", () => {
  test("a gap wider than 0.25·fontSize inserts one space", () => {
    // gap = 33 − (0 + 30) = 3 > 0.25 · 10
    expect(buildPageText([item("Hello", { x: 0, width: 30 }), item("world", { x: 33 })])).toBe(
      "Hello world",
    );
  });

  test("a gap of 0.1·fontSize is kerning, not a space", () => {
    // gap = 31 − 30 = 1 ≤ 2.5
    expect(buildPageText([item("Hello", { x: 0, width: 30 }), item("world", { x: 31 })])).toBe(
      "Helloworld",
    );
  });

  test("a different baseline is not the same line, so no space", () => {
    // Δy = 20 > 0.5 · 10
    expect(
      buildPageText([item("Hello", { x: 0, width: 30, y: 100 }), item("world", { x: 33, y: 120 })]),
    ).toBe("Helloworld");
  });

  test("an item that already ends (or starts) with a space gets no second one", () => {
    expect(buildPageText([item("Hello ", { x: 0, width: 30 }), item("world", { x: 33 })])).toBe(
      "Hello world",
    );
    expect(buildPageText([item("Hello", { x: 0, width: 30 }), item(" world", { x: 33 })])).toBe(
      "Hello world",
    );
  });

  test("fontSize is the larger of the two heights", () => {
    // fontSize = 40, so a 9-unit gap is still kerning (0.25 · 40 = 10).
    expect(
      buildPageText([
        item("Hello", { x: 0, width: 30, height: 10 }),
        item("world", { x: 39, height: 40 }),
      ]),
    ).toBe("Helloworld");
  });

  test("hasEOL ends the line and suppresses the space", () => {
    expect(
      buildPageText([
        item("line one", { x: 0, width: 40, hasEOL: true }),
        item("line two", { x: 0, y: 80, width: 40 }),
      ]),
    ).toBe("line one\nline two");
  });

  test("an empty item never contributes a space", () => {
    expect(
      buildPageText([item("a", { x: 0, width: 5 }), item("", { x: 20 }), item("b", { x: 40 })]),
    ).toBe("a b");
  });

  test("non-text items are skipped, not stringified", () => {
    expect(
      buildPageText([
        item("Hello", { x: 0, width: 30 }),
        { type: "beginMarkedContent" },
        item("world", { x: 33 }),
      ]),
    ).toBe("Hello world");
  });

  test("runs of blank lines collapse to one, and lines are trimEnd'ed", () => {
    expect(
      buildPageText([
        item("a   ", { x: 0, hasEOL: true }),
        item("", { x: 0, hasEOL: true }),
        item("", { x: 0, hasEOL: true }),
        item("", { x: 0, hasEOL: true }),
        item("b", { x: 0 }),
      ]),
    ).toBe("a\n\nb");
  });

  test("a single blank line survives — it IS the paragraph break", () => {
    expect(
      buildPageText([
        item("Para one.", { hasEOL: true }),
        item("", { hasEOL: true }),
        item("Para two."),
      ]),
    ).toBe("Para one.\n\nPara two.");
  });

  test("two blank lines collapse to one (not to nothing)", () => {
    expect(
      buildPageText([
        item("A", { x: 0, hasEOL: true }),
        item("", { x: 0, hasEOL: true }),
        item("", { x: 0, hasEOL: true }),
        item("B", { x: 0 }),
      ]),
    ).toBe("A\n\nB");
  });

  test("C0 controls are dropped (they reach the model and the terminal); tab and newline stay", () => {
    expect(buildPageText([item("a\u0000b\u0007c")])).toBe("abc");
    expect(buildPageText([item("a\tb")])).toBe("a\tb");
    expect(buildPageText([item("a\r\nb")])).toBe("a\r\nb".replace("\r", ""));
  });

  test("an empty item list is empty text", () => {
    expect(buildPageText([])).toBe("");
  });
});

describe("parsePageRange — what the model asked for", () => {
  test("a range, a single page, an open range", () => {
    expect(parsePageRange("1-5", 12)).toEqual({ ok: true, pages: [1, 2, 3, 4, 5] });
    expect(parsePageRange("3", 12)).toEqual({ ok: true, pages: [3] });
    expect(parsePageRange("7-", 9)).toEqual({ ok: true, pages: [7, 8, 9] });
  });

  test("comma lists, spaces and duplicates converge to a sorted unique list", () => {
    expect(parsePageRange("2,4,9-11", 12)).toEqual({ ok: true, pages: [2, 4, 9, 10, 11] });
    expect(parsePageRange(" 3 , 1-2,3 ", 12)).toEqual({ ok: true, pages: [1, 2, 3] });
  });

  test("page 0, a reversed range, a page past the end and a page past MAX are all refused", () => {
    expect(parsePageRange("0", 12)).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(parsePageRange("5-3", 12)).toMatchObject({ ok: false, reason: "reversed" });
    expect(parsePageRange("13", 12)).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(parsePageRange("7-", 5)).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(parsePageRange(`1-${MAX_PAGES_PER_READ + 1}`, 5000)).toMatchObject({
      ok: false,
      reason: "too-many",
    });
  });

  test("a malformed or empty spec is refused, not guessed", () => {
    expect(parsePageRange("", 12)).toMatchObject({ ok: false, reason: "malformed" });
    expect(parsePageRange("  ", 12)).toMatchObject({ ok: false, reason: "malformed" });
    expect(parsePageRange("abc", 12)).toMatchObject({ ok: false, reason: "malformed" });
    expect(parsePageRange("1-2-3", 12)).toMatchObject({ ok: false, reason: "malformed" });
    expect(parsePageRange("2,,3", 12)).toMatchObject({ ok: false, reason: "malformed" });
    expect(parsePageRange("1.5", 12)).toMatchObject({ ok: false, reason: "malformed" });
  });

  test("the refusal names the rule the model broke", () => {
    const zero = parsePageRange("0", 12);
    expect(zero.ok).toBe(false);
    if (!zero.ok) {
      expect(zero.message).toContain("start at 1");
    }
    const beyond = parsePageRange("13", 12);
    if (!beyond.ok) {
      expect(beyond.message).toContain("12 pages");
    }
    const tooMany = parsePageRange("1-101", 5000);
    if (!tooMany.ok) {
      expect(tooMany.message).toContain("100");
    }
  });

  test(`exactly ${MAX_PAGES_PER_READ} pages is allowed`, () => {
    expect(parsePageRange(`1-${MAX_PAGES_PER_READ}`, 5000)).toEqual({
      ok: true,
      pages: Array.from({ length: MAX_PAGES_PER_READ }, (_, i) => i + 1),
    });
  });

  test("a 30-million-page claim is refused without walking the span", () => {
    // `numPages` is the PDF's own /Count. The old code filled a Set over the
    // whole span first: 30 million entries, ~2 s, for a call already over the
    // cap. Proven by time (the refusal is arithmetic) and by the message.
    const started = performance.now();
    const result = parsePageRange("1-", 30_000_000);
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ ok: false, reason: "too-many" });
    expect(elapsed).toBeLessThan(100);
  });

  test("a page count no Set could hold is refused the same way", () => {
    // The span alone can never fit the cap, so it is refused before any loop:
    // filling a Set with 2^31 entries is an out-of-memory, not a slow read.
    expect(parsePageRange("1-", 2 ** 31)).toMatchObject({ ok: false, reason: "too-many" });
    expect(parsePageRange(`1-${MAX_PAGES_PER_READ + 1}`, 2 ** 31 - 1)).toMatchObject({
      ok: false,
      reason: "too-many",
    });
  });

  test("many small parts that TOGETHER exceed the cap are refused", () => {
    // Each part is small, so only the running total catches it.
    expect(parsePageRange("1-100,201-300", 5000)).toMatchObject({
      ok: false,
      reason: "too-many",
    });
    expect(parsePageRange("1-50,201-250", 5000)).toEqual({
      ok: true,
      pages: [
        ...Array.from({ length: 50 }, (_, i) => i + 1),
        ...Array.from({ length: 50 }, (_, i) => i + 201),
      ],
    });
  });
});

describe("formatPdfText — markers, header, footer", () => {
  const twoPages = [
    { n: 1, text: "Hello PDF world" },
    { n: 2, text: "Second page" },
  ];

  test("every page gets a marker and the header names the range", () => {
    expect(formatPdfText({ pages: twoPages, numPages: 2, name: "report.pdf" })).toBe(
      [
        "[pdf report.pdf: 2 pages, pages 1-2 shown]",
        "--- page 1 / 2 ---",
        "Hello PDF world",
        "--- page 2 / 2 ---",
        "Second page",
      ].join("\n"),
    );
  });

  test("pages left out get a footer naming the NEXT call", () => {
    const pages = [1, 2, 3, 4, 5].map((n) => ({ n, text: `body ${n}` }));
    const out = formatPdfText({ pages, numPages: 12, name: "big.pdf" });
    expect(out).toContain("[pdf big.pdf: 12 pages, pages 1-5 shown]");
    expect(out).toContain('[pages 6-12 not read — call fs_read with pages: "6-12"]');
  });

  test("a 412-page read of the first 100 names 101-200 next", () => {
    const pages = Array.from({ length: 100 }, (_, i) => ({ n: i + 1, text: `p${i + 1}` }));
    const out = formatPdfText({ pages, numPages: 412, name: "spec.pdf" });
    expect(out).toContain('[pages 101-412 not read — call fs_read with pages: "101-200"]');
  });

  test("a page-range read in the middle names both sides", () => {
    const pages = [50, 51].map((n) => ({ n, text: `p${n}` }));
    const out = formatPdfText({ pages, numPages: 412, name: "spec.pdf" });
    expect(out).toContain("--- page 50 / 412 ---");
    expect(out).toContain("pages 1-49 not read");
    expect(out).toContain("pages 52-412 not read");
  });

  test("the text cap cuts at a page boundary and says so", () => {
    const pages = Array.from({ length: 4 }, (_, i) => ({ n: i + 1, text: "x".repeat(60) }));
    const out = formatPdfText({ pages, numPages: 4, name: "long.pdf", maxChars: 150 });
    expect(out).toContain("--- page 2 / 4 ---");
    expect(out).not.toContain("--- page 3 / 4 ---");
    expect(out).toContain('[pages 3-4 not read — call fs_read with pages: "3-4"]');
  });

  test("a hostile page count does not turn the footer into a walk over every page", () => {
    // `numPages` is the PDF's /Count. The old footer stepped 1..numPages: 300
    // million iterations (~360 ms) for a one-page read. Gaps are arithmetic now,
    // and there are none more than read.size + 1.
    const started = performance.now();
    const out = formatPdfText({
      pages: [{ n: 1, text: "only page read" }],
      numPages: 2 ** 31,
      name: "hostile.pdf",
    });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(100);
    expect(out).toContain("--- page 1 / 2147483648 ---");
    expect(out).toContain('[pages 2-2147483648 not read — call fs_read with pages: "2-101"]');
  });

  test("one page whose text alone exceeds the cap is still returned (never an empty read)", () => {
    const out = formatPdfText({
      pages: [{ n: 1, text: "y".repeat(500) }],
      numPages: 1,
      name: "one.pdf",
      maxChars: 100,
    });
    expect(out).toContain("y".repeat(500));
    expect(out).toContain("--- page 1 / 1 ---");
  });
});

describe("pdfVerdict — scanned, mixed, text", () => {
  test("every page empty means no text layer, said plainly", () => {
    const verdict = pdfVerdict({
      name: "scan.pdf",
      numPages: 12,
      pages: [
        { n: 1, text: "" },
        { n: 2, text: "   " },
      ],
    });
    expect(verdict.kind).toBe("no-text");
    expect(verdict.message).toBe(
      "scan.pdf: 12 pages, no extractable text — it looks scanned (pages are images); OCR is not supported",
    );
  });

  test("a few image-only pages are listed, the read still succeeds", () => {
    const verdict = pdfVerdict({
      name: "mixed.pdf",
      numPages: 4,
      pages: [
        { n: 1, text: "" },
        { n: 2, text: "real text that is long enough to count as text" },
        { n: 3, text: " \n " },
        { n: 4, text: "more real text, plenty of it, over the threshold" },
      ],
    });
    expect(verdict.kind).toBe("partial");
    if (verdict.kind === "text") {
      throw new Error("expected a verdict, got text");
    }
    expect(verdict.emptyPages).toEqual([1, 3]);
    expect(verdict.message).toBe("mixed.pdf: pages 1, 3 have no text (images)");
  });

  test("text on every page is no message at all", () => {
    const verdict = pdfVerdict({
      name: "ok.pdf",
      numPages: 2,
      pages: [
        { n: 1, text: "Hello PDF world" },
        { n: 2, text: "Second page" },
      ],
    });
    expect(verdict).toEqual({ kind: "text", message: "" });
  });
});

describe("fileBlock / splitFileBlocks — data, never a closing tag", () => {
  test("the block carries name, kind and page count", () => {
    expect(fileBlock({ name: "report.pdf", kind: "pdf", pages: 12, text: "body" })).toBe(
      '<file name="report.pdf" kind="pdf" pages="12">\nbody\n</file>',
    );
  });

  test("the name is attribute-escaped", () => {
    const block = fileBlock({ name: 'a"b<c>&d.pdf', kind: "pdf", pages: 1, text: "x" });
    expect(block).toContain('name="a&quot;b&lt;c&gt;&amp;d.pdf"');
  });

  test("a `</file` inside the text cannot close the block early", () => {
    const hostile = "before </file> after";
    const block = fileBlock({ name: "x.pdf", kind: "pdf", pages: 1, text: hostile });
    expect(block.match(/<\/file>/g)).toHaveLength(1);
    expect(block).toContain("<\\/file>");
    const split = splitFileBlocks(block);
    expect(split.blocks).toHaveLength(1);
    expect(split.blocks[0]?.text).toBe(hostile);
  });

  test("round-trip: a block inside prose comes back whole and the prose without it", () => {
    const text = "line one\nstill </file> hostile\nline three";
    const content = `here is my file\n${fileBlock({ name: "r.pdf", kind: "pdf", pages: 2, text })}`;
    const split = splitFileBlocks(content);
    expect(split.text).toBe("here is my file");
    expect(split.blocks).toHaveLength(1);
    expect(split.blocks[0]).toEqual({ name: "r.pdf", kind: "pdf", pages: 2, text });
  });

  test("content with no block is all text", () => {
    expect(splitFileBlocks("just words")).toEqual({ text: "just words", blocks: [] });
  });

  test("two blocks both parse", () => {
    const a = fileBlock({ name: "a.pdf", kind: "pdf", pages: 1, text: "A" });
    const b = fileBlock({ name: "b.pdf", kind: "pdf", pages: 3, text: "B" });
    const split = splitFileBlocks(`${a}\n${b}`);
    expect(split.blocks.map((block) => block.name)).toEqual(["a.pdf", "b.pdf"]);
    expect(split.text).toBe("");
  });
});

describe("isPdf — the bytes decide, never the extension", () => {
  test("`%PDF-` at offset 0", () => {
    expect(isPdf(pdfBytes(0))).toBe(true);
  });

  test("`%PDF-` inside the head window (offset 500)", () => {
    expect(isPdf(pdfBytes(500))).toBe(true);
  });

  test(`past the ${PDF_HEAD_BYTES}-byte window is not a PDF`, () => {
    expect(isPdf(pdfBytes(1100))).toBe(false);
  });

  test("text, an image and too few bytes are not PDFs", () => {
    expect(isPdf(new TextEncoder().encode("just some text\nwith newlines\n"))).toBe(false);
    expect(isPdf(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false);
    expect(isPdf(new Uint8Array([]))).toBe(false);
    expect(isPdf(new TextEncoder().encode("%PD"))).toBe(false);
  });

  test("a text file whose content merely mentions %PDF- later on is not parsed as a PDF", () => {
    const text = `${"a".repeat(2000)}%PDF-1.7`;
    expect(isPdf(new TextEncoder().encode(text))).toBe(false);
  });

  // Round-6 HIGH: prose quoting the magic inside the window used to sniff as a
  // PDF, so `fs_read` refused it as corrupt (whole) or "use pages" (ranged).
  test("prose quoting the magic is not a PDF, wherever the quote sits", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    // Mid-line, inline code.
    expect(isPdf(enc("Every PDF starts with `%PDF-1.7`."))).toBe(false);
    // At the start of a line: what FOLLOWS the version says it is prose.
    expect(isPdf(enc("\n\n%PDF-1.7 is the magic number\nmore\n"))).toBe(false);
    // Fix round 2 loosened this one deliberately: a printable PREFIX is now a
    // PDF (an HTTP response body, a banner line), so a header-looking line
    // after prose sniffs as a PDF and relies on the `corrupt` → text fallback.
    // `fs-read-pdf.test.ts` pins the property that matters: it still READS as
    // text. What the sniff alone must never accept is prose on the version line.
    expect(isPdf(enc("# PDF notes\n%PDF-1.7\nmore prose\n"))).toBe(true);
    // A real header line is `%PDF-<major>.<minor>`, then end of line.
    expect(isPdf(enc("%PDF-1.7"))).toBe(true);
    expect(isPdf(enc("%PDF-1.4\r\n1 0 obj\n"))).toBe(true);
    expect(isPdf(enc("%PDF-1.7  \n1 0 obj\n"))).toBe(true);
    expect(isPdf(enc("%PDF-x.y\n1 0 obj\n"))).toBe(false);
  });

  test("a header line after binary junk or a BOM is still a PDF", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const withBom = enc("\uFEFF%PDF-1.4\n1 0 obj\n");
    expect(isPdf(withBom)).toBe(true);
    const bytes = new Uint8Array(8 + 14);
    bytes.set(enc("%PDF-1.5\n1 0ob"), 8);
    expect(isPdf(bytes)).toBe(true);
  });
});

describe("looksLikeTextBytes — the `corrupt` fallback's discriminator", () => {
  test("prose, source and JSON (what a sniff false positive is made of) are text", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(looksLikeTextBytes(enc("Every PDF starts with `%PDF-1.7`.\n"))).toBe(true);
    expect(looksLikeTextBytes(enc("<doc>\r\n\ttab\tand ünïcode ✓\f</doc>\n"))).toBe(true);
    expect(looksLikeTextBytes(new Uint8Array([]))).toBe(true);
  });

  test("a head that cuts a UTF-8 character in half is still text", () => {
    // The sniff passes a 1 KiB window: a multi-byte character may be split.
    const enc = (s: string) => new TextEncoder().encode(s);
    const whole = enc("prose about %PDF- ✓\n");
    expect(looksLikeTextBytes(whole.subarray(0, whole.length - 2))).toBe(true);
    expect(looksLikeTextBytes(whole)).toBe(true);
  });

  test("real PDF bytes are not text", () => {
    // A minimal document: header, a compressed stream, an xref with a NUL run.
    const pdf = new Uint8Array([
      ...new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<< /Length 6 >>\nstream\n"),
      0x78,
      0x9c,
      0x00,
      0x01,
      0x02,
      0x03,
      ...new TextEncoder().encode("\nendstream\nendobj\n"),
    ]);
    expect(looksLikeTextBytes(pdf)).toBe(false);
    // A lone NUL, a stray ESC, invalid UTF-8.
    expect(looksLikeTextBytes(new Uint8Array([0x61, 0x00, 0x62]))).toBe(false);
    expect(looksLikeTextBytes(new Uint8Array([0x1b, 0x61]))).toBe(false);
    expect(looksLikeTextBytes(new Uint8Array([0xff, 0x61]))).toBe(false);
  });
});

// Fix round 2 (review MEDIUM): the tight sniff must not lose a REAL PDF. pdf.js
// opens all of these; rejecting them returned raw PDF objects as "text".
describe("isPdf — real headers the tight sniff must still accept", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const body = enc("\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

  test("a printable junk line before the header (an HTTP response body)", () => {
    expect(isPdf(new Uint8Array([...enc("HTTP/1.1 200 OK\r\n\r\n%PDF-1.4"), ...body]))).toBe(true);
    // Any single printable prefix line, not just HTTP.
    expect(isPdf(new Uint8Array([...enc("GARBAGE\n%PDF-1.4"), ...body]))).toBe(true);
  });

  test("the binary comment producers append on the header line", () => {
    expect(isPdf(new Uint8Array([...enc("%PDF-1.4 %"), 0xe2, 0xe3, 0xcf, 0xd3, ...body]))).toBe(
      true,
    );
    // The latin1 form of the same comment (what a latin1 decoder gives).
    expect(isPdf(enc("%PDF-1.4 %âãÏÓ\n1 0 obj\n"))).toBe(true);
  });

  test("a byte-order mark stays a PDF", () => {
    expect(isPdf(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("%PDF-1.4"), ...body]))).toBe(true);
  });

  test("prose quoting the magic is STILL not a PDF (round-6 HIGH stays fixed)", () => {
    // The loosened rule must not regress the false positive it was added for:
    // in every false positive the version line is followed by PROSE.
    expect(isPdf(enc("Every PDF starts with `%PDF-1.7`."))).toBe(false);
    expect(isPdf(enc("\n\n%PDF-1.7 is the magic number\nmore\n"))).toBe(false);
  });
});

// Fix round 2, the spec-literal variant: a `%` after the version starts a
// comment that runs to the end of the line, so ASCII on it is a real header.
describe("isPdf — a same-line comment after the version", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  test("`%PDF-1.4 %<anything>` is a header, prose after a space is not", () => {
    expect(isPdf(enc("%PDF-1.4 %produced by a tool\n1 0 obj\n"))).toBe(true);
    expect(isPdf(enc("%PDF-1.7 % gs\n1 0 obj\n"))).toBe(true);
    // Without the comment marker the version line continues as prose.
    expect(isPdf(enc("%PDF-1.7 is the magic number\nmore\n"))).toBe(false);
  });
});
