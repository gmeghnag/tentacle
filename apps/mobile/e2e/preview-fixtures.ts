/**
 * Flow 36's workspace files (docs/feat/mobile-file-preview-cards.md): a real
 * multi-page PDF and a real PNG, GENERATED per run (no binary fixture in the
 * repo, nothing real), so QuickLook on the phone has a page to draw and the
 * image card real pixels.
 */
import { deflateSync } from "node:zlib";

/** A text PDF: one page per entry, each a title and some lines (Helvetica, A4). */
export function pdfFixture(
  pages: readonly { title: string; lines: readonly string[] }[],
): Uint8Array {
  const esc = (text: string): string => text.replace(/[\\()]/g, (c) => `\\${c}`);
  const objects: string[] = [];
  const pageIds: number[] = [];
  // 1 catalog, 2 pages, 3 font; then per page: page object + content stream.
  const first = 4;
  pages.forEach((page, at) => {
    const pageId = first + at * 2;
    pageIds.push(pageId);
    const ops = [
      "0.05 0.45 0.56 rg 0 792 595 50 re f",
      "BT /F1 24 Tf 0.1 0.1 0.12 rg 56 740 Td",
      `(${esc(page.title)}) Tj`,
      "/F1 12 Tf 0 -34 Td 0.35 0.35 0.4 rg",
      ...page.lines.flatMap((line) => [`(${esc(line)}) Tj`, "0 -18 Td"]),
      "ET",
      "0.85 0.87 0.9 rg 56 300 483 180 re f",
      "0.05 0.45 0.56 rg 76 320 60 120 re f 156 320 60 80 re f 236 320 60 150 re f 316 320 60 60 re f",
    ].join("\n");
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
    objects[pageId + 1] = `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`;
  });
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id += 1) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A `width × height` RGB PNG: a sky-to-sea gradient with a sun and hills. */
export function pngFixture(width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  const sun = { x: width * 0.72, y: height * 0.34, r: height * 0.12 };
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    const t = y / height;
    for (let x = 0; x < width; x += 1) {
      const hill = height * (0.68 + 0.06 * Math.sin(x / 90) + 0.03 * Math.sin(x / 37));
      let r = Math.round(14 + 120 * t);
      let g = Math.round(116 + 80 * t);
      let b = Math.round(144 + 90 * (1 - t));
      if (Math.hypot(x - sun.x, y - sun.y) < sun.r) {
        r = 250;
        g = 204;
        b = 21;
      } else if (y > hill) {
        r = 21;
        g = Math.round(94 + 30 * Math.sin(x / 50));
        b = 89;
      }
      const at = row + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The report PDF flow 36 presents (7 pages, so the card says "7 pages"). */
export function reportPdf(): Uint8Array {
  return pdfFixture(
    Array.from({ length: 7 }, (_, at) => ({
      title: at === 0 ? "Q3 Infrastructure Report" : `Section ${at + 1}`,
      lines: [
        "Compute spend fell 12% quarter over quarter.",
        "Storage grew with the session archive rollout.",
        "Egress is flat; the relay moved to the edge.",
        "Next: right-size the build fleet, retire v1 nodes.",
      ],
    })),
  );
}
