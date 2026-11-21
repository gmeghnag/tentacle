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

/** One image XObject of `makeImagePdf` (docs/feat/pdf-images.md §Tests). */
export interface FixtureImage {
  width: number;
  height: number;
  /** `/DeviceRGB`, `/DeviceGray`, or e.g. `[/Indexed /DeviceRGB 1 <FF000000FF00>]`. */
  colorSpace?: string;
  /** The stream's bytes before decoding (written as ASCIIHex, so the file stays text). */
  data: Uint8Array;
  /** Filters after `/ASCIIHexDecode`, e.g. `/DCTDecode` or `/JPXDecode`. */
  filter?: string;
  bpc?: number;
  /** A soft mask (a `/DeviceGray` image), applied by pdf.js → RGBA. */
  smask?: FixtureImage;
  /** A stencil mask (`/ImageMask true`, 1 bit): painted with the fill colour. */
  imageMask?: boolean;
}

/** Bytes as an ASCIIHex stream body (`…>`). */
export function hexBytes(bytes: Uint8Array): string {
  return `${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}>`;
}

/** `BT … Tj ET` at (x, y), Helvetica 12. */
export function textOp(x: number, y: number, text: string): string {
  return `BT /F1 12 Tf ${x} ${y} Td (${escapePdfString(text)}) Tj ET`;
}

/** Paint XObject `/name` into the box (x, y, w, h). */
export function imageOp(name: string, x: number, y: number, w: number, h: number): string {
  return `q ${w} 0 0 ${h} ${x} ${y} cm /${name} Do Q`;
}

/** An inline RGB image (`BI … ID … EI`) painted into the box (x, y, w, h). */
export function inlineImageOp(
  pixels: { width: number; height: number; rgb: Uint8Array },
  box: [number, number, number, number],
): string {
  const [x, y, w, h] = box;
  return `q ${w} 0 0 ${h} ${x} ${y} cm BI /W ${pixels.width} /H ${pixels.height} /CS /RGB /BPC 8 /F /AHx ID ${hexBytes(pixels.rgb)} EI Q`;
}

/**
 * A PDF whose pages carry image XObjects: each page is its raw content plus
 * the images its content names (`/Im1 Do`). All streams are ASCIIHex, so the
 * whole file is text and goes through the same writer as `makePdf`.
 */
export function makeImagePdf(
  pages: { content: string; images?: Record<string, FixtureImage> }[],
): Uint8Array {
  const objs: string[] = [];
  const add = (s: string) => {
    objs.push(s);
    return objs.length;
  };
  const catalog = add("<< /Type /Catalog /Pages 2 0 R >>");
  add("PAGES");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const addImage = (image: FixtureImage): number => {
    const smask = image.smask === undefined ? "" : `/SMask ${addImage(image.smask)} 0 R `;
    const body = hexBytes(image.data);
    const space = image.imageMask
      ? "/ImageMask true "
      : image.colorSpace === undefined
        ? ""
        : `/ColorSpace ${image.colorSpace} `;
    return add(
      `<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} ${space}/BitsPerComponent ${image.bpc ?? (image.imageMask ? 1 : 8)} /Filter [/ASCIIHexDecode ${image.filter ?? ""}] ${smask}/Length ${body.length} >>\nstream\n${body}\nendstream`,
    );
  };
  const kids: number[] = [];
  for (const page of pages) {
    const xobjects = Object.entries(page.images ?? {})
      .map(([name, image]) => `/${name} ${addImage(image)} 0 R`)
      .join(" ");
    const content = add(`<< /Length ${page.content.length} >>\nstream\n${page.content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << ${xobjects} >> >> /Contents ${content} 0 R >>`,
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
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/**
 * A 48×32 baseline JPEG, left half red and right half blue (made once with
 * `sips` from a PNG this repo's encoder wrote; lossy, so tests compare colours
 * approximately).
 */
export const RED_BLUE_JPEG = Uint8Array.from(
  atob(
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAMKADAAQAAAABAAAAIAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAIAAwAwERAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/bAEMBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAf/dAAQABv/aAAwDAQACEQMRAD8A/F+v8pz/AL+AoAKAPyHr/wBVA/8ANfCgAoA//9D8X6/ynP8Av4CgAoA/Iev/AFUD/wA18KACgD//0fxfr/Kc/wC/gKACgD8h6/8AVQP/ADXwoAKAP//S/F+v8pz/AL+AoAKAPyHr/wBVA/8ANfCgAoA//9k=",
  ),
  (c) => c.charCodeAt(0),
);

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
