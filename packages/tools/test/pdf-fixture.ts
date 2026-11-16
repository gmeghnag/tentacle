/**
 * Test-only PDF generator (docs/feat/pdf-read.md §Tests): KB-sized PDFs built
 * in memory, so no binary fixture is committed. Grown from the R0 `make-pdf.ts`.
 */
import { deflateSync } from "node:zlib";

interface FixtureOptions {
  /** Extra trailer entries (e.g. an `/Encrypt` dictionary). */
  trailer?: string;
  /** The `/F1` font dictionary (default: Helvetica). */
  font?: string;
  /** Raw content per page instead of the default one-`Tj`-per-line text. */
  rawContent?: string[];
}

function escapePdfString(s: string): string {
  return s.replace(/[()\\]/g, "\\$&");
}

/** A text PDF: one page per entry, one line per string (Helvetica 12). */
export function makePdf(pages: string[][], options: FixtureOptions = {}): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => {
    objs.push(s);
    return objs.length;
  };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  const font = add(options.font ?? "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  const bodies =
    options.rawContent ??
    pages.map((lines) =>
      lines
        .map((l, i) => `BT /F1 12 Tf 72 ${720 - i * 16} Td (${escapePdfString(l)}) Tj ET`)
        .join("\n"),
    );
  for (const body of bodies) {
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R ${options.trailer ?? ""}>>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * A PDF with a standard-security `/Encrypt` whose user password is NOT empty
 * (`/U` matches no empty-password key), so pdf.js asks for a password.
 */
export function makeEncryptedPdf(): Uint8Array {
  const hex32 = "A1".repeat(32);
  const id = "00112233445566778899AABBCCDDEEFF";
  const encrypt = `/Encrypt << /Filter /Standard /V 1 /R 2 /Length 40 /P -4 /O <${hex32}> /U <${hex32}> >>`;
  return makePdf([["secret"]], { trailer: `${encrypt} /ID [<${id}> <${id}>] ` });
}

/** The first `keep` bytes of a valid PDF: no xref, no trailer. */
export function makeTruncatedPdf(keep = 60): Uint8Array {
  return makePdf([["Hello PDF world"], ["Second page"]]).slice(0, keep);
}

/** A simple font with a `/ToUnicode` CMap mapping code 0x01 → α (U+03B1). */
export function makeToUnicodePdf(): Uint8Array {
  const cmap = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Fixture def /CMapType 2 def",
    "1 begincodespacerange <00> <FF> endcodespacerange",
    "2 beginbfchar <01> <03B1> <02> <00E9> endbfchar",
    "endcmap CMapName currentdict /CMap defineresource pop end end",
  ].join("\n");
  // Objects: 1 catalog, 2 pages, 3 font, 4 content, 5 page; the CMap is
  // appended as object 6, which the font names.
  const content = "BT /F1 12 Tf 72 720 Td (\\001\\002) Tj ET";
  const pdf = makePdf([[]], {
    rawContent: [content],
    font: "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>",
  });
  return appendObject(pdf, `<< /Length ${cmap.length} >>\nstream\n${cmap}\nendstream`);
}

/**
 * Append one object to a `makePdf` output as an incremental update (a new
 * xref section + trailer with `/Prev`), so object numbers stay stable.
 */
function appendObject(pdf: Uint8Array, body: string): Uint8Array {
  const text = new TextDecoder("latin1").decode(pdf);
  const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
  const root = /\/Root (\d+) 0 R/.exec(text)?.[1];
  const prev = Number(/startxref\n(\d+)/.exec(text)?.[1]);
  const n = size;
  let out = text;
  const offset = out.length;
  out += `${n} 0 obj\n${body}\nendobj\n`;
  const xref = out.length;
  out += `xref\n${n} 1\n${String(offset).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${n + 1} /Root ${root} 0 R /Prev ${prev} >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * A pathological page: `ops` text-show operators in one content stream —
 * valid, slow to extract (pdf.js walks every one). The size grows linearly.
 */
export function makeHeavyPdf(ops: number): Uint8Array {
  const body = `BT /F1 12 Tf 72 720 Td ${"(x) Tj ".repeat(ops)}ET`;
  return makePdf([[]], { rawContent: [body] });
}

/**
 * A decompression bomb: one page whose FlateDecode content stream inflates to
 * `inflatedBytes` of spaces (≈ 1/1000 of that on disk). Binary, so it is
 * assembled as bytes rather than through `makePdf`'s text path.
 */
export function makeFlateBombPdf(inflatedBytes: number): Uint8Array {
  const z = deflateSync(new Uint8Array(inflatedBytes).fill(0x20), { level: 9 });
  const enc = new TextEncoder();
  const head = enc.encode(
    [
      "%PDF-1.4",
      "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj",
      "2 0 obj\n<< /Type /Pages /Kids [4 0 R] /Count 1 >>\nendobj",
      "3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj",
      "4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>\nendobj",
      `5 0 obj\n<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`,
    ].join("\n"),
  );
  const offsets: number[] = [];
  const text = new TextDecoder().decode(head);
  for (let n = 1; n <= 5; n++) offsets.push(text.indexOf(`\n${n} 0 obj`) + 1);
  const xref = head.length + z.length + "\nendstream\nendobj\n".length;
  let tail = "\nendstream\nendobj\nxref\n0 6\n0000000000 65535 f \n";
  for (const off of offsets) tail += `${String(off).padStart(10, "0")} 00000 n \n`;
  tail += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const end = enc.encode(tail);
  const out = new Uint8Array(head.length + z.length + end.length);
  out.set(head, 0);
  out.set(z, head.length);
  out.set(end, head.length + z.length);
  return out;
}
