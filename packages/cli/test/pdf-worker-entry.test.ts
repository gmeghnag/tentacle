import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractPdf, pdfWorkerUrl } from "@tentacle/tools";
import { PDF_WORKER_URL } from "../src/pdf-worker-url.ts";
import { BINARY_ENTRYPOINTS } from "../src/pod-binary-build.ts";

const root = resolve(import.meta.dir, "../../..");

/** A two-page PDF, inline (the tools fixture is not a cli dependency). */
function helloPdf(): Uint8Array {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [5 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const body = "BT /F1 12 Tf 72 720 Td (Hello from the binary path) Tj ET";
  objs.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  objs.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 4 0 R >>",
  );
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

describe("the PDF worker is a binary entrypoint (docs/feat/pdf-read.md D2)", () => {
  test("buildBinary embeds pdf-worker.ts, and every entrypoint exists", () => {
    expect(BINARY_ENTRYPOINTS).toContain("packages/cli/src/pdf-worker.ts");
    for (const path of BINARY_ENTRYPOINTS) expect(existsSync(resolve(root, path))).toBe(true);
  });

  test("all entrypoints share one directory, so the $bunfs root (and ./worker.ts) does not move", () => {
    const dirs = new Set(BINARY_ENTRYPOINTS.map((path) => dirname(path)));
    expect([...dirs]).toEqual(["packages/cli/src"]);
  });

  test("the CLI points the extractor at that entrypoint", () => {
    const file = fileURLToPath(PDF_WORKER_URL);
    expect(file).toBe(resolve(root, "packages/cli/src/pdf-worker.ts"));
    expect(BINARY_ENTRYPOINTS.map((p) => basename(p))).toContain(basename(file));
    expect(pdfWorkerUrl()).toBe(PDF_WORKER_URL);
  });

  test("an extraction through the CLI entrypoint reads the text", async () => {
    const r = await extractPdf(helloPdf());
    expect(r.ok && r.pages).toEqual([{ n: 1, text: "Hello from the binary path" }]);
  });
});
