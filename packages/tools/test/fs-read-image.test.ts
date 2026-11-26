/**
 * docs/feat/image-files.md T3: `fs_read` of a `.png` / `.jpg` puts the FILE into
 * the session's store through image-view's own path (`putTool`, no `low`) and
 * answers with the ref marker — 0 refs, `high` only. Everything about the file
 * comes from its BYTES: the type, the format, the sizes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AttachmentRef,
  ExecutionEnvironment,
  HeicConverter,
  ToolContext,
  ToolImagePut,
  ToolImageStore,
} from "@tentacle/core";
import { MAX_IMAGE_BYTES } from "@tentacle/core";
import { AttachmentStore, UploadBudget } from "../../daemon/src/attachment-store.ts";
import { HostExecution } from "../../exec/src/index.ts";
import { createFsReadTool, fsReadTool } from "../src/builtins.ts";

let dir: string;
let env: HostExecution;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "fs-read-image-"));
  env = new HostExecution({ cwd: dir });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tool = createFsReadTool({ images: true });

const ctxFor = (environment: ExecutionEnvironment, images?: ToolImageStore): ToolContext => ({
  sessionId: "s1",
  signal: new AbortController().signal,
  env: environment,
  ...(images !== undefined ? { images } : {}),
});
const read = (input: Record<string, unknown>, context: ToolContext) =>
  tool.execute({ ...input } as never, context);

async function writeFileOf(name: string, value: Uint8Array): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, value);
  return path;
}

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

/** A PNG built the way a real one is: signature, IHDR with a real CRC, IEND. */
function png(w: number, h: number): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const crcOf = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...ascii(type), ...data]);
    return crc32(body);
  };
  const chunkOf = (type: string, data: Uint8Array) => [
    ...be32(data.length),
    ...ascii(type),
    ...data,
    ...be32(crcOf(type, data)),
  ];
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunkOf("IHDR", ihdr),
    ...chunkOf("IEND", new Uint8Array(0)),
  ]);
}

/** A complete baseline JPEG: SOI, SOF0, SOS, one byte, EOI. */
function jpeg(w: number, h: number, components = 3): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xc0,
    ...be16(8 + 3 * components),
    8,
    ...be16(h),
    ...be16(w),
    components,
    ...Array.from({ length: components * 3 }, () => 1),
    0xff,
    0xda,
    ...be16(6),
    1,
    0,
    0,
    0,
    0x01,
    0xff,
    0xd9,
  ]);
}

/** CRC-32, the test's own copy (the module's is not exported from here). */
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let i = 0; i < 8; i += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** A real store, wrapped so a test counts puts and can refuse them. */
function storeOf(refuse: (put: ToolImagePut, n: number) => boolean = () => false) {
  const real = new AttachmentStore(new UploadBudget());
  let n = 0;
  const store = {
    puts: [] as ToolImagePut[],
    store: undefined as unknown as AttachmentStore,
    putTool: (put: ToolImagePut) => {
      store.puts.push(put);
      return refuse(put, n++)
        ? Promise.resolve({ refused: "image store full" })
        : real.putTool(put);
    },
    resolve: (p: string) => real.resolve(p),
    holds: (r: AttachmentRef) => real.holds(r),
    read: (r: AttachmentRef) => real.read(r),
  };
  store.store = real;
  return store;
}

const PNG_HEADER = "\u0089PNG\r\n\u001a\n";

describe("fs_read of an image file", () => {
  test("a PNG → a ref marker, 0 refs, putTool once with image/png and no low", async () => {
    const path = await writeFileOf("shot.png", png(1200, 800));
    const images = storeOf();
    const result = await read({ path }, ctxFor(env, images));
    expect(images.puts).toHaveLength(1);
    const put = images.puts[0];
    expect(put?.mimeType).toBe("image/png");
    expect(put?.variants.low).toBeUndefined();
    expect(put?.variants.high.width).toBe(1200);
    expect(put?.variants.high.height).toBe(800);
    expect(result.image).toBeUndefined();
    const id12 = result.content.match(/ref ([0-9a-f]{12}) · high only\]/)?.[1] ?? "";
    expect(id12).toHaveLength(12);
    expect(result.content).toBe(
      `[image shot.png · 1200×800 · PNG · ${sizeText(png(1200, 800).length)} · ref ${id12} · high only]\n${hintLine()}`,
    );
    // The ref really names the bytes: the same id the store resolved.
    expect(images.store.resolve(id12).kind).toBe("found");
  });

  test("a JPEG → the same marker with image/jpeg and format JPEG", async () => {
    const bytes = jpeg(640, 480);
    const path = await writeFileOf("photo.jpg", bytes);
    const images = storeOf();
    const result = await read({ path }, ctxFor(env, images));
    expect(images.puts[0]?.mimeType).toBe("image/jpeg");
    expect(result.content).toContain("· JPEG ·");
    expect(result.content).toContain(`ref ${sha12(bytes)}`);
    expect(result.content.endsWith(hintLine())).toBe(true);
  });

  test("a .jpg holding PNG bytes is stored as image/png (the type comes from the bytes)", async () => {
    const path = await writeFileOf("mislabelled.jpg", png(300, 200));
    const images = storeOf();
    const result = await read({ path }, ctxFor(env, images));
    expect(images.puts[0]?.mimeType).toBe("image/png");
    expect(result.content).toContain("· PNG ·");
  });

  test("a JPEG with a bad header is refused by a sentence, nothing stored", async () => {
    // A PNG's magic is fine; a JPEG cut before EOI is the corrupt case.
    const truncated = jpeg(64, 64).subarray(0, 20);
    const path = await writeFileOf("cut.jpg", truncated);
    const images = storeOf();
    const result = await read({ path }, ctxFor(env, images));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("cut.jpg: the JPEG is truncated or corrupt");
    expect(images.puts).toHaveLength(0);
  });

  test("over the model's cap → the shared reason line, no putTool, no full read", async () => {
    const path = await writeFileOf("big.png", png(40, 40));
    const images = storeOf();
    let fullReads = 0;
    const small: ExecutionEnvironment = {
      ...env,
      readBytes: env.readBytes?.bind(env),
      readConfinedBytes: env.readConfinedBytes?.bind(env),
      async readFile(p: string) {
        fullReads += 1;
        return env.readFile(p);
      },
      // A 1-byte cap stands in for a model whose limit this file crosses.
      exec: env.exec.bind(env),
      writeFile: env.writeFile.bind(env),
      id: env.id,
    };
    const result = await tool.execute({ path } as never, ctxFor(small, images));
    expect(result.isError).toBeUndefined();
    // Non-vacuity: with the real cap the same file is read.
    expect(result.content).toContain("[image big.png");
    const over = await createFsReadTool({ images: true, maxImageBytes: 1 }).execute(
      { path } as never,
      ctxFor(small, images),
    );
    expect(over.isError).toBe(true);
    expect(over.content).toBe(
      `[image omitted: ${sizeText(png(40, 40).length)} is over this model's 1 B limit — big.png]`,
    );
    expect(images.puts).toHaveLength(1); // only the in-cap read stored anything
    expect(fullReads).toBe(0);
  });

  test("a store refusal → `not kept: …`, isError, no ref", async () => {
    const path = await writeFileOf("kept.png", png(100, 100));
    const images = storeOf(() => true);
    const result = await read({ path }, ctxFor(env, images));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("· not kept: image store full]");
    expect(result.content).not.toContain(hintLine());
  });

  test("a line range on an image is refused", async () => {
    const path = await writeFileOf("ranged.png", png(100, 100));
    const images = storeOf();
    for (const input of [{ path, offset: 1, limit: 2 }, { path: `${path}:1:2` }]) {
      const result = await read(input, ctxFor(env, images));
      expect(result.isError).toBe(true);
      expect(result.content).toContain("is an image: no line ranges");
    }
    expect(images.puts).toHaveLength(0);
  });

  test("GIF and WebP are refused with a sentence naming the type (Q2)", async () => {
    const gif = Uint8Array.from([...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0]);
    const webp = Uint8Array.from([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBPVP8 "), 0, 0, 0, 0]);
    for (const [name, bytes, word] of [
      ["a.gif", gif, "GIF"],
      ["b.webp", webp, "WebP"],
    ] as const) {
      const path = await writeFileOf(name, bytes);
      const result = await read({ path }, ctxFor(env, storeOf()));
      expect(result.isError).toBe(true);
      expect(result.content).toContain(word);
      expect(result.content).toContain("not readable as images yet");
    }
  });

  test("a .png holding text is read as TEXT (the bytes decide, never the name)", async () => {
    const text = "hello, not an image\nsecond line\n";
    const path = await writeFileOf("notes.png", new TextEncoder().encode(text));
    const images = storeOf();
    const result = await read({ path }, ctxFor(env, images));
    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(text);
    expect(images.puts).toHaveLength(0);
  });

  test("a .png holding unknown binary is refused: not a PNG or JPEG image", async () => {
    const path = await writeFileOf("blob.png", Uint8Array.from([0, 1, 2, 3, 0xff, 0xfe, 0, 9]));
    const images = storeOf();
    const result = await read({ path }, ctxFor(env, images));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("blob.png is not a PNG or JPEG image");
    expect(images.puts).toHaveLength(0);
  });

  test("without ctx.images: exactly the bytes readFile returns today (golden)", async () => {
    const path = await writeFileOf("plain.png", png(50, 50));
    const viaTool = await read({ path }, ctxFor(env));
    const golden = await fsReadTool.execute({ path } as never, ctxFor(env));
    expect(viaTool).toEqual(golden);
    // Non-vacuity: today's path is the UTF-8 decode, so the PNG's ASCII chunk
    // types survive as mojibake text and NO store was touched.
    expect(viaTool.content).toContain("IHDR");
  });

  test("without vision the tool IS the shared constant, so the branch cannot run", () => {
    expect(createFsReadTool({ images: false })).toBe(fsReadTool);
    expect(createFsReadTool({ images: true })).not.toBe(fsReadTool);
  });

  test("the marker's size is capped by the session's own maxImageBytes, not the global one", () => {
    // Non-vacuity for the wiring test: the option really reaches the read.
    expect(createFsReadTool({ images: true, maxImageBytes: 1 })).not.toBe(
      createFsReadTool({ images: true, maxImageBytes: MAX_IMAGE_BYTES }),
    );
  });
});

/** docs/feat/image-heic.md T4: the HEIC branch, over a fake converter. */
describe("fs_read of a HEIC", () => {
  /** An `ftyp heic` head and some body. */
  const heicBytes = (size = 64) => {
    const bytes = new Uint8Array(size);
    bytes.set([...be32(24), ...ascii("ftypheic")]);
    return bytes;
  };
  const converted = jpeg(4032, 3024);
  function converterOf(
    answer: Awaited<ReturnType<HeicConverter>> = {
      bytes: converted,
      width: 4032,
      height: 3024,
      sourceWidth: 8064,
      sourceHeight: 6048,
    },
  ) {
    const calls: { bytes: Uint8Array; maxEdge: number; maxBytes: number }[] = [];
    const heic: HeicConverter = async (bytes, limits) => {
      calls.push({ bytes, ...limits });
      return answer;
    };
    return { calls, heic };
  }
  /** The environment, recording the bound of every read past the head. */
  function counting() {
    const full: number[] = [];
    const wrapped = {
      id: env.id,
      readFile: (p: string) => env.readFile(p),
      writeFile: env.writeFile.bind(env),
      exec: env.exec.bind(env),
      readBytes: (p: string, o?: { maxBytes?: number; readLimitBytes?: number }) => {
        if (o?.readLimitBytes === undefined) full.push(o?.maxBytes ?? -1);
        return env.readBytes(p, o);
      },
    } as ExecutionEnvironment;
    return { full, wrapped };
  }
  const run = (
    path: string,
    context: ToolContext,
    options: Parameters<typeof createFsReadTool>[0],
    input: Record<string, unknown> = {},
  ) => createFsReadTool(options).execute({ path, ...input } as never, context);

  test("the converted JPEG is what is stored, and the marker says so", async () => {
    const path = await writeFileOf("IMG_0001.HEIC", heicBytes());
    const images = storeOf();
    const { calls, heic } = converterOf();
    const result = await run(path, ctxFor(env, images), { images: true, heic });
    expect(result.isError).toBeUndefined();
    expect(calls.map((c) => c.bytes.length)).toEqual([64]);
    expect(images.puts).toHaveLength(1);
    expect(images.puts[0]?.mimeType).toBe("image/jpeg");
    expect(images.puts[0]?.label).toBe("IMG_0001.HEIC");
    expect(images.puts[0]?.variants.high).toEqual({ bytes: converted, width: 4032, height: 3024 });
    expect(images.puts[0]?.variants.low).toBeUndefined();
    expect(result.image).toBeUndefined();
    expect(result.content).toBe(
      `[image IMG_0001.HEIC · 4032×3024 · HEIC 8064×6048→JPEG · ${sizeText(converted.length)} · ref ${sha12(converted)} · high only]\n${hintLine()}`,
    );
  });

  test("the converter gets the model's side (at most 4032) and byte cap", async () => {
    const path = await writeFileOf("caps.heic", heicBytes());
    for (const [maxEdge, asked] of [
      [8000, 4032],
      [1568, 1568],
    ] as const) {
      const { calls, heic } = converterOf();
      // A cap smaller than the INPUT: it bounds the output, never the read.
      const options = { images: true, heic, maxEdge, maxImageBytes: 10 };
      await run(path, ctxFor(env, storeOf()), options);
      expect(calls.map((c) => [c.maxEdge, c.maxBytes])).toEqual([[asked, 10]]);
    }
    const { calls, heic } = converterOf();
    const options = { images: true, heic, maxImageBytes: MAX_IMAGE_BYTES * 2 };
    await run(path, ctxFor(env, storeOf()), options);
    expect(calls[0]?.maxBytes).toBe(MAX_IMAGE_BYTES);
  });

  test("no decoder on this host: a sentence naming it, nothing read past the head", async () => {
    const path = await writeFileOf("linux.heic", heicBytes());
    const images = storeOf();
    const { full, wrapped } = counting();
    const result = await run(path, ctxFor(wrapped, images), { images: true });
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      `linux.heic: HEIC/HEIF pictures are converted by macOS's own decoder, and this host (${process.platform}) has none — convert it to JPEG first`,
    );
    expect(full).toEqual([]);
    expect(images.puts).toHaveLength(0);
  });

  test("a converter refusal is the file's sentence, nothing stored", async () => {
    const path = await writeFileOf("bad.heic", heicBytes());
    const images = storeOf();
    const { heic } = converterOf({ refused: "the HEIC is corrupt (no readable size)" });
    const result = await run(path, ctxFor(env, images), { images: true, heic });
    expect(result).toEqual({
      content: "bad.heic: the HEIC is corrupt (no readable size)",
      isError: true,
    });
    expect(images.puts).toHaveLength(0);
  });

  test("a store refusal → `not kept: …`", async () => {
    const path = await writeFileOf("full.heic", heicBytes());
    const { heic } = converterOf();
    const images = storeOf(() => true);
    const result = await run(path, ctxFor(env, images), { images: true, heic });
    expect(result).toEqual({
      content: "[image full.heic · 4032×3024 · not kept: image store full]",
      isError: true,
    });
  });

  test("a line range is refused before anything is converted", async () => {
    const path = await writeFileOf("ranged.heic", heicBytes());
    const { calls, heic } = converterOf();
    const context = ctxFor(env, storeOf());
    const result = await run(path, context, { images: true, heic }, { offset: 1 });
    expect(result.content).toBe(`${path} is an image: no line ranges`);
    expect(calls).toHaveLength(0);
  });

  test("over 15 MiB: refused before the body is read", async () => {
    const path = await writeFileOf("huge.heic", heicBytes(MAX_IMAGE_BYTES + 1));
    const { calls, heic } = converterOf();
    const { full, wrapped } = counting();
    const result = await run(path, ctxFor(wrapped, storeOf()), { images: true, heic });
    expect(result.isError).toBe(true);
    expect(result.content).toBe("[image omitted: 15 MB is over the 15 MB limit — huge.heic]");
    expect(full).toEqual([MAX_IMAGE_BYTES]);
    expect(calls).toHaveLength(0);
  });
});

/** `formatBytes`' form, which the marker carries (one decimal only from MiB up). */
function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
function hintLine(): string {
  return "call image_view with this ref to see it; only high detail is available for image files";
}
function sha12(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex").slice(0, 12);
}
