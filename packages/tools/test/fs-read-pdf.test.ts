/**
 * `fs_read` on a PDF (docs/feat/pdf-read.md §Tests P3, D3): a real
 * `HostExecution` on a temp dir, so the byte read, the size refusal and the
 * extraction are the shipping ones. Fakes that implement `readFile` only
 * (`ExecutionEnvironment.readBytes` is optional) must keep today's behaviour.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_PDF_BYTES } from "@tentacle/core";
import type { ExecutionEnvironment, ToolContext } from "@tentacle/core";
import { HostExecution } from "../../exec/src/index.ts";
import { fsReadTool } from "../src/builtins.ts";
import { makeEncryptedPdf, makePdf } from "./pdf-fixture.ts";

let dir: string;
let env: HostExecution;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-read-pdf-"));
  env = new HostExecution({ cwd: dir });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctxFor(environment: ExecutionEnvironment): ToolContext {
  return { sessionId: "s1", signal: new AbortController().signal, env: environment };
}

const read = (input: Record<string, unknown>, environment: ExecutionEnvironment = env) =>
  fsReadTool.execute({ ...input } as never, ctxFor(environment));

const hello = () => makePdf([["Hello PDF world"], ["Second page"]]);

function bytes(parts: number[]): Uint8Array {
  return new Uint8Array(parts);
}

async function writePdf(name: string, value: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, value);
  return path;
}

describe("fs_read on a PDF", () => {
  test("detects a PDF by its bytes and returns extracted text with page markers", async () => {
    const path = await writePdf("report.pdf", hello());
    const result = await read({ path });
    expect(result.content).toContain("[pdf report.pdf: 2 pages, pages 1-2 shown]");
    expect(result.content).toContain("--- page 1 / 2 ---");
    expect(result.content).toContain("Hello PDF world");
    expect(result.content).toContain("--- page 2 / 2 ---");
    expect(result.content).toContain("Second page");
    // Not the raw file: no PDF object syntax reaches the model.
    expect(result.content).not.toContain("%PDF-1.4");
  });

  test("pages reads only the named pages and footers the rest", async () => {
    const path = await writePdf("paged.pdf", hello());
    const result = await read({ path, pages: "2" });
    expect(result.content).toContain("--- page 2 / 2 ---");
    expect(result.content).not.toContain("--- page 1 / 2 ---");
    expect(result.content).not.toContain("Hello PDF world");
    expect(result.content).toContain('[pages 1 not read — call fs_read with pages: "1"]');
  });

  test("a malformed pages spec is a tool error naming the rule", async () => {
    const path = await writePdf("bad-pages.pdf", hello());
    await expect(read({ path, pages: "0" })).rejects.toThrow(/pages start at 1/);
    await expect(read({ path, pages: "9" })).rejects.toThrow(/2 pages/);
  });

  test("a line range on a PDF is refused, naming `pages`", async () => {
    const path = await writePdf("ranged.pdf", hello());
    await expect(read({ path: `${path}:1:5` })).rejects.toThrow(/use pages/);
    await expect(read({ path, offset: 1, limit: 5 })).rejects.toThrow(/use pages/);
  });

  test("`pages` on a text file is refused", async () => {
    const path = join(dir, "note.txt");
    await writeFile(path, "line one\nline two\n");
    await expect(read({ path, pages: "1" })).rejects.toThrow(/only to PDFs/);
  });

  test("a text file named .pdf is read as text (the bytes decide, not the name)", async () => {
    const path = join(dir, "notes.pdf");
    await writeFile(path, "just some text\n");
    const result = await read({ path });
    expect(result.content).toBe("just some text\n");
  });

  // Round-6 HIGH: a text file that *mentions* `%PDF-` in its first KiB was
  // sniffed as a PDF, so `fs_read` threw `corrupt PDF` (whole) or "use pages"
  // (ranged) on prose, docs and source about PDFs — with no model workaround.
  test("prose that mentions `%PDF-` is read as text, whole and ranged", async () => {
    const path = join(dir, "notes.md");
    const body = "# PDF notes\nEvery PDF starts with `%PDF-1.7`.\nline three\n";
    await writeFile(path, body);
    expect((await read({ path })).content).toBe(body);
    expect((await read({ path: `${path}:2:3` })).content).toBe(
      `[${path} lines 2-3 of 4]\nEvery PDF starts with \`%PDF-1.7\`.\nline three`,
    );
  });

  test("`%PDF-` alone on a line, after blank lines, is still prose", async () => {
    const path = join(dir, "header.md");
    const body = "\n\n%PDF-1.7 is the magic number\nmore prose here\n";
    await writeFile(path, body);
    expect((await read({ path })).content).toBe(body);
    await expect(read({ path, offset: 3, limit: 1 })).resolves.toBeDefined();
  });

  test("a PDF with a junk prefix before `%PDF-` is still a PDF", async () => {
    // The false-positive fix must not lose the wild case the head window exists
    // for: binary junk (a NUL run here) then the header.
    const junk = new Uint8Array(8);
    const path = await writePdf("junk-prefix.pdf", bytes([...junk, ...hello()]));
    const result = await read({ path });
    expect(result.content).toContain("Hello PDF world");
    await expect(read({ path: `${path}:1:5` })).rejects.toThrow(/use pages/);
  });

  test("a text file that DOES sniff as a PDF falls back to text when parsing says corrupt", async () => {
    // The fallback branch: the head is a legal-looking header line, so the sniff
    // says PDF, pdf.js says corrupt — but the bytes are valid UTF-8, so it is a
    // text file, and `pages` on it gets the honest non-PDF refusal.
    const path = join(dir, "fake.pdf");
    const body = "%PDF-1.7\nthis is not a real PDF body\njust prose\n";
    await writeFile(path, body);
    expect((await read({ path })).content).toBe(body);
    expect((await read({ path, offset: 2, limit: 1 })).content).toBe(
      `[${path} lines 2-2 of 4]\nthis is not a real PDF body`,
    );
    await expect(read({ path, pages: "1" })).rejects.toThrow(/only to PDFs/);
  });

  test("a corrupt BINARY PDF is still a corrupt-PDF error, not text", async () => {
    // The fallback is gated on the bytes being text: a damaged real PDF (gzip
    // stream, NUL runs) must keep saying so.
    const path = await writePdf(
      "damaged.pdf",
      new Uint8Array([
        ...new TextEncoder().encode("%PDF-1.4\n1 0 obj\nstream\n"),
        0x00,
        0x01,
        0x02,
      ]),
    );
    await expect(read({ path })).rejects.toThrow(/damaged\.pdf.*corrupt PDF/);
  });

  test("a PDF with no extension is extracted", async () => {
    const path = await writePdf("download", hello());
    const result = await read({ path });
    expect(result.content).toContain("Hello PDF world");
  });

  test("an encrypted PDF is a tool error naming the file", async () => {
    const path = await writePdf("locked.pdf", makeEncryptedPdf());
    await expect(read({ path })).rejects.toThrow(/locked\.pdf.*password-protected/);
  });

  test("a PDF with no text layer says it looks scanned", async () => {
    const path = await writePdf("scan.pdf", makePdf([[""], [""], [""]]));
    await expect(read({ path })).rejects.toThrow(/scan\.pdf.*looks scanned.*OCR is not supported/);
  });

  test("a partly readable PDF returns its text and names the empty pages", async () => {
    // Dense enough to be a real text layer (P1's density rule: > 16 non-space
    // chars per page), with one image-only page in the middle.
    const dense = [
      "Section one: the introduction",
      "This page carries a normal body of text.",
      "and a third line so the text layer is unmistakable.",
    ];
    const path = await writePdf(
      "mixed.pdf",
      makePdf([dense, [""], ["Section three: the conclusion", ...dense]]),
    );
    const result = await read({ path });
    expect(result.content).toContain("Section one: the introduction");
    expect(result.content).toContain("Section three: the conclusion");
    expect(result.content).toContain("mixed.pdf: pages 2 have no text (images)");
  });

  test("a tool aborted (Esc / steer) rejects instead of parsing", async () => {
    const path = await writePdf("aborted.pdf", hello());
    const controller = new AbortController();
    controller.abort();
    const aborted: ToolContext = { sessionId: "s1", signal: controller.signal, env };
    // The signal reaches the extractor: an already-aborted call never parses,
    // so no worker is started for a turn the user has interrupted.
    await expect(fsReadTool.execute({ path } as never, aborted)).rejects.toThrow(/aborted/);
  });

  test("a file over MAX_PDF_BYTES is refused before the bytes are read", async () => {
    const path = join(dir, "huge.pdf");
    const handle = await open(path, "w");
    await handle.truncate(MAX_PDF_BYTES + 1);
    await handle.write("%PDF-1.4", 0);
    await handle.close();

    // Spy on the only way bytes are read: a refusal must not open the file body.
    const realFile = Bun.file;
    let opens = 0;
    Bun.file = ((...args: Parameters<typeof realFile>) => {
      opens += 1;
      return realFile(...args);
    }) as typeof Bun.file;
    let message = "";
    try {
      await read({ path });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    } finally {
      Bun.file = realFile;
    }
    expect(message).toContain("MiB limit");
    expect(message).toContain("huge.pdf");
    // ONE bounded head read (1 KiB) to see it is a PDF; the size refusal then
    // comes from the stat, so the body is never opened at all.
    expect(opens).toBe(1);
  });
});

describe("fs_read without readBytes", () => {
  /** A fake that implements `readFile` only, as ~20 existing fakes do. */
  function fakeEnv(files: Record<string, string>): ExecutionEnvironment {
    return {
      id: "fake",
      async exec() {
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readFile(path) {
        const value = files[path];
        if (value === undefined) {
          throw new Error(`no such file: ${path}`);
        }
        return value;
      },
      async writeFile() {},
    };
  }

  test("a text read is unchanged", async () => {
    const fake = fakeEnv({ "a.txt": "one\ntwo\nthree" });
    expect((await read({ path: "a.txt" }, fake)).content).toBe("one\ntwo\nthree");
    expect((await read({ path: "a.txt", offset: 2, limit: 1 }, fake)).content).toBe(
      "[a.txt lines 2-2 of 3]\ntwo",
    );
  });

  test("a PDF read returns the raw bytes, as today", async () => {
    const fake = fakeEnv({ "x.pdf": "%PDF-1.4 raw" });
    expect((await read({ path: "x.pdf" }, fake)).content).toBe("%PDF-1.4 raw");
  });

  test("`pages` is refused rather than silently ignored", async () => {
    const fake = fakeEnv({ "a.txt": "one" });
    // Not the non-PDF rule ("applies only to PDFs: …"): this env cannot read
    // bytes at all, so the message must say the capability is missing.
    await expect(read({ path: "a.txt", pages: "1" }, fake)).rejects.toThrow(
      /cannot read file bytes/,
    );
  });
});

describe("fs_read on a plain text file (real env)", () => {
  test("is byte-identical to the environment's own read", async () => {
    const path = join(dir, "plain.txt");
    const body = "alpha\nbeta\ngamma\n";
    await writeFile(path, body);
    expect((await read({ path })).content).toBe(await env.readFile(path));
  });
});
