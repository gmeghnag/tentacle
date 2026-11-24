/**
 * docs/feat/image-view.md T3 / T5 / T6 / T9: `fs_read` keeps a PDF's pictures
 * in the session store and returns 0 refs (the refs are marker text);
 * `image_view` picks ONE variant by prefix and never reads a byte.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AttachmentRef,
  ToolContext,
  ToolImageEntry,
  ToolImagePut,
  ToolImageStore,
} from "@tentacle/core";
import { AttachmentStore, UploadBudget } from "../../daemon/src/attachment-store.ts";
import { HostExecution } from "../../exec/src/index.ts";
import { createFsReadTool, fsReadTool } from "../src/builtins.ts";
import { createImageViewTool, viewImage } from "../src/image-view.ts";
import { imageOp, makeImagePdf, textOp } from "./pdf-fixture.ts";

let dir: string;
let env: HostExecution;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "image-view-"));
  env = new HostExecution({ cwd: dir });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ctx = (images?: ToolImageStore): ToolContext => ({
  sessionId: "s1",
  signal: new AbortController().signal,
  env,
  ...(images !== undefined ? { images } : {}),
});
const gray = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * seed + seed) & 0xff);
async function writePdf(name: string, value: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, value);
  return path;
}
/** One page with `n` distinct 40×30 pictures. */
function picturesPdf(n: number): Uint8Array {
  const images: Record<
    string,
    { width: number; height: number; colorSpace: string; data: Uint8Array }
  > = {};
  const ops = [textOp(72, 740, "Figures")];
  for (let i = 0; i < n; i++) {
    images[`F${i}`] = { width: 40, height: 30, colorSpace: "/DeviceGray", data: gray(1200, i + 3) };
    ops.push(imageOp(`F${i}`, 100, 680 - i * 100, 120, 90));
  }
  return makeImagePdf([{ content: ops.join("\n"), images }]);
}
const refsIn = (text: string): string[] =>
  [...text.matchAll(/ref ([0-9a-f]{12})\]/g)].map((m) => m[1] ?? "");

/** A real store, wrapped so a test can refuse chosen puts and count reads. */
function storeOf(refuse: (put: ToolImagePut, n: number) => boolean = () => false) {
  const real = new AttachmentStore(new UploadBudget());
  let n = 0;
  const store = {
    reads: 0,
    puts: 0,
    putTool: (put: ToolImagePut) => {
      store.puts += 1;
      return refuse(put, n++)
        ? Promise.resolve({ refused: "image store full" })
        : real.putTool(put);
    },
    resolve: (p: string) => real.resolve(p),
    holds: (r: AttachmentRef) => real.holds(r),
    read: async (r: AttachmentRef) => {
      store.reads += 1;
      return real.read(r);
    },
  };
  return store;
}

describe("fs_read with the session store (T3)", () => {
  test("6 pictures → 0 refs on the result, 6 marker refs, every one held", async () => {
    const store = storeOf();
    const path = await writePdf("six.pdf", picturesPdf(6));
    const result = await fsReadTool.execute({ path } as never, ctx(store));
    expect(result.image).toBeUndefined();
    const refs = refsIn(result.content);
    expect(refs).toHaveLength(6);
    for (const r of refs) {
      const found = store.resolve(r);
      expect(found.kind).toBe("found");
      if (found.kind === "found") expect(store.holds(found.entry.high.ref)).toBe(true);
    }
    // Every picture kept: nothing to explain, so no footer (as before).
    expect(result.content).not.toContain("[images:");
    expect(store.reads).toBe(0);
  });

  test("a store refusal rewrites only that picture's marker and the footer counts it", async () => {
    const store = storeOf((_put, n) => n === 1);
    const path = await writePdf("refuse.pdf", picturesPdf(3));
    const result = await fsReadTool.execute({ path } as never, ctx(store));
    expect(refsIn(result.content)).toHaveLength(2);
    expect(result.content.match(/· not kept: image store full\]/g)).toHaveLength(1);
    expect(result.content).toContain("2 kept for image_view, 1 not kept (see the markers)");
  });

  test("no store → today's bytes (no ref, `sent`)", async () => {
    const path = await writePdf("plain.pdf", picturesPdf(1));
    const result = await fsReadTool.execute({ path } as never, ctx());
    expect(result.content).toContain("[image p.1 · 40×30]");
    expect(result.content).not.toContain("ref ");
  });

  test("a scan with a store → the verdict first, then the markers (owner Q4)", async () => {
    const scan = { width: 60, height: 80, colorSpace: "/DeviceGray", data: gray(4800, 7) };
    const page = (s: number) => ({
      content: imageOp("Scan", 0, 0, 612, 792),
      images: { Scan: { ...scan, data: gray(4800, s) } },
    });
    const path = await writePdf("scan.pdf", makeImagePdf([page(7), page(9)]));
    const result = await fsReadTool.execute({ path } as never, ctx(storeOf()));
    expect(result.content.split("\n")[0]).toMatch(/looks scanned/);
    expect(
      refsIn(`${result.content}`.replaceAll(` · full page — detail "high" for small text]`, "]")),
    ).toHaveLength(2);
    expect(result.content).toContain('full page — detail "high" for small text');
    // Without a store the same scan is still refused.
    await expect(fsReadTool.execute({ path } as never, ctx())).rejects.toThrow(/looks scanned/);
  });

  test("the same PDF read twice gives the same refs (T6)", async () => {
    const path = await writePdf("twice.pdf", picturesPdf(2));
    const a = await fsReadTool.execute({ path } as never, ctx(storeOf()));
    const b = await fsReadTool.execute({ path } as never, ctx(storeOf()));
    expect(refsIn(a.content)).toEqual(refsIn(b.content));
  });

  test("the image variant adds the image_view sentence; the shared constant is untouched", () => {
    expect(createFsReadTool({ images: true }).description).toContain("image_view");
    expect(fsReadTool.description).not.toContain("image_view");
    expect(createFsReadTool({ images: false })).toBe(fsReadTool);
  });
});

describe("image_view (T5, T9)", () => {
  const entry = (lowSame = false): ToolImageEntry => {
    const high = {
      ref: {
        id: `a1b2c3d4e5f6${"1".repeat(52)}`,
        mimeType: "image/png",
        size: 4096,
        name: "doc.pdf p.3",
      },
      width: 1568,
      height: 784,
    };
    const low = lowSame
      ? high
      : {
          ref: {
            id: `a1b2c3d4e5f6${"2".repeat(52)}`,
            mimeType: "image/png",
            size: 1024,
            name: "doc.pdf p.3",
          },
          width: 768,
          height: 384,
        };
    return { high, low, label: "doc.pdf p.3" };
  };
  /** A spy store: no `read` at all, so any byte read would throw. */
  const spy = (e: ToolImageEntry | "ambiguous" | null, held = true): ToolImageStore => ({
    putTool: async () => ({ refused: "x" }),
    resolve: () =>
      e === null
        ? { kind: "none" }
        : e === "ambiguous"
          ? { kind: "ambiguous", labels: ["a p.1", "b p.2"] }
          : { kind: "found", entry: e },
    holds: () => held,
  });

  test("low (default) and high pick the right ref", () => {
    const e = entry();
    const low = viewImage({ ref: "a1b2c3d4e5f6" }, { images: spy(e) }, "auto");
    expect(low.image).toEqual(e.low.ref);
    expect(low.content).toBe("doc.pdf p.3 · 768×384 · low · 1 KB");
    const high = viewImage(
      { ref: "sha256:A1B2C3D4E5F6", detail: "high" },
      { images: spy(e) },
      "auto",
    );
    expect(high.image).toEqual(e.high.ref);
  });

  test("low === high says it is already small", () => {
    const r = viewImage({ ref: "a1b2c3d4e5f6" }, { images: spy(entry(true)) }, "auto");
    expect(r.content).toContain("already ≤ 768 px");
  });

  test("a forced imageDetail hides `detail` from the schema and ignores a stale one with a note", () => {
    const schema = (setting: "auto" | "high") =>
      JSON.stringify(
        (createImageViewTool(setting).inputSchema as unknown as { shape: object }).shape,
      );
    expect(schema("auto")).toContain("detail");
    expect(schema("high")).not.toContain("detail");
    const r = viewImage({ ref: "a1b2c3d4e5f6", detail: "low" }, { images: spy(entry()) }, "high");
    expect(r.image).toEqual(entry().high.ref);
    expect(r.content).toContain("ignored");
  });

  test("unknown, ambiguous, malformed, not-held, no store → isError, no image", () => {
    const cases = [
      viewImage({ ref: "a1b2c3d4e5f6" }, { images: spy(null) }, "auto"),
      viewImage({ ref: "a1b2c3d4" }, { images: spy("ambiguous") }, "auto"),
      viewImage({ ref: "xyz" }, { images: spy(entry()) }, "auto"),
      viewImage({ ref: "a1b2c3d4e5f6" }, { images: spy(entry(), false) }, "auto"),
      viewImage({ ref: "a1b2c3d4e5f6" }, {}, "auto"),
    ];
    for (const r of cases) {
      expect(r.isError).toBe(true);
      expect(r.image).toBeUndefined();
    }
    expect(cases[0]?.content).toContain("fs_read the file again");
    expect(cases[1]?.content).toContain("a p.1, b p.2");
  });

  test("a user upload (not in the tool index) is unknown to image_view", async () => {
    const real = new AttachmentStore(new UploadBudget());
    const bytes = gray(500, 4);
    const id = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    real.put({ id, size: 500, offset: 0, data: Buffer.from(bytes).toString("base64") });
    const r = viewImage({ ref: id.slice(0, 12) }, { images: real }, "auto");
    expect(r.isError).toBe(true);
    expect(r.image).toBeUndefined();
  });

  test("permission none; the input is bounded (a forced ask has nothing long to cut)", () => {
    const tool = createImageViewTool();
    expect(tool.permission).toBe("none");
    expect(tool.inputSchema.safeParse({ ref: "a".repeat(72) }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ref: "a1b2c3d4e5f6", detail: "huge" }).success).toBe(false);
  });
});
