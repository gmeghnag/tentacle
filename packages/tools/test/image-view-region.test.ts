/**
 * `image_view`'s `region` and the `low` of a high-only PNG
 * (docs/feat/image-region-png.md D1/D4/D5, T6/T7), over a REAL memory
 * `AttachmentStore`: what is sent is a new stored picture holding exactly the
 * asked pixels, and its own id views it again.
 */
import { describe, expect, test } from "bun:test";
import { promisify } from "node:util";
import { deflateSync, inflate as inflateCb } from "node:zlib";
import {
  type AttachmentRef,
  type ChatMessage,
  type DecodedPng,
  type Tool,
  type ToolContext,
  type ToolImageEntry,
  type ToolImagePut,
  type ToolImageStore,
  crc32,
  decodePng,
  downscalePixels,
  encodePng,
  formatBytes,
} from "@tentacle/core";
import { AttachmentStore, UploadBudget } from "../../daemon/src/attachment-store.ts";
import { type ImageViewInput, createImageViewTool } from "../src/image-view.ts";

const inflateAsync = promisify(inflateCb);
const deflate = (bytes: Uint8Array): Uint8Array => new Uint8Array(deflateSync(bytes));
const decode = async (bytes: Uint8Array): Promise<DecodedPng> => {
  const result = await decodePng(
    bytes,
    async (b, max) => new Uint8Array(await inflateAsync(b, { maxOutputLength: max })),
  );
  if ("refused" in result) throw new Error(result.refused);
  return result;
};

/** RGB pixels that name their position. */
const pattern = (width: number, height: number): Uint8Array =>
  new Uint8Array(width * height * 3).map((_, i) => {
    const pixel = Math.floor(i / 3);
    return [pixel % width, Math.floor(pixel / width), 7][i % 3] ?? 0;
  });
const pngOf = (width: number, height: number, pixels = pattern(width, height)): Uint8Array =>
  encodePng(width, height, pixels, "rgb", deflate);

/** A real store that counts its reads and puts. */
function storeOf(toolMaxBytes?: number) {
  const real = new AttachmentStore(
    new UploadBudget(),
    toolMaxBytes !== undefined ? { toolMaxBytes } : {},
  );
  const store = {
    real,
    reads: 0,
    puts: [] as ToolImagePut[],
    putTool: (put: ToolImagePut) => {
      store.puts.push(put);
      return real.putTool(put);
    },
    resolve: (p: string) => real.resolve(p),
    holds: (r: AttachmentRef) => real.holds(r),
    read: (r: AttachmentRef) => {
      store.reads += 1;
      return real.read(r);
    },
  };
  return store;
}

async function keep(
  store: ReturnType<typeof storeOf>,
  high: { bytes: Uint8Array; width: number; height: number },
  opts: {
    low?: { bytes: Uint8Array; width: number; height: number };
    mimeType?: "image/png" | "image/jpeg";
    label?: string;
  } = {},
): Promise<ToolImageEntry> {
  const entry = await store.real.putTool({
    variants: { high, ...(opts.low !== undefined ? { low: opts.low } : {}) },
    mimeType: opts.mimeType ?? "image/png",
    label: opts.label ?? "shot.png",
  });
  if ("refused" in entry) throw new Error(entry.refused);
  return entry;
}
const keepPng = (store: ReturnType<typeof storeOf>, width: number, height: number) =>
  keep(store, { bytes: pngOf(width, height), width, height });

const ctx = (images: ToolImageStore, history?: readonly ChatMessage[]): ToolContext => ({
  sessionId: "s1",
  signal: new AbortController().signal,
  env: undefined as unknown as ToolContext["env"],
  images,
  ...(history !== undefined ? { history } : {}),
});

const short = (ref: AttachmentRef): string => ref.id.slice(0, 12);

/** Run the tool as the agent does: the input goes through the schema first. */
async function view(
  store: ToolImageStore,
  input: object,
  tool: Tool<ImageViewInput> = createImageViewTool(),
  history?: readonly ChatMessage[],
) {
  return tool.execute(tool.inputSchema.parse(input), ctx(store, history));
}

/** The pixels of the picture a result sends. */
async function sent(
  store: ReturnType<typeof storeOf>,
  image: AttachmentRef | undefined,
): Promise<DecodedPng> {
  if (image === undefined) throw new Error("the result sends no image");
  const bytes = await store.real.read(image);
  if (bytes === null) throw new Error("the sent image's bytes are not held");
  return decode(bytes);
}

const QUARTER = { left: 0.5, top: 0, width: 0.5, height: 0.5 };

describe("region", () => {
  test("sends a NEW picture holding exactly that part of the pixels", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 200, 100);
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r.isError).toBeUndefined();
    expect(r.image?.id).not.toBe(entry.high.ref.id);
    const crop = await sent(store, r.image);
    expect([crop.width, crop.height, crop.color]).toEqual([100, 50, "rgb"]);
    // Top-left pixel is source (100, 0); bottom-right is source (199, 49).
    expect([...crop.pixels.subarray(0, 3)]).toEqual([100, 0, 7]);
    expect([...crop.pixels.subarray(-3)]).toEqual([199, 49, 7]);
    expect(r.content).toBe(
      `shot.png · region 100,0 100×50 of 200×100 · sent 100×50 · low · ${formatBytes(r.image?.size ?? 0)}`,
    );
    expect(store.puts.map((p) => [p.label, p.mimeType])).toEqual([
      ["shot.png region", "image/png"],
    ]);
  });

  test("the crop's own id views it again (the prune stub's promise)", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 200, 100);
    const first = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    const image = first.image;
    if (image === undefined) throw new Error("no crop");
    expect(image.id).not.toBe(entry.high.ref.id);
    expect(store.resolve(short(image)).kind).toBe("found");
    const again = await view(store, { ref: short(image) });
    expect(again.image).toEqual(image);
  });

  test("low is at most 768 px and high at most 1568 px on the long edge", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 4000, 2000);
    const region = { left: 0, top: 0, width: 0.5, height: 0.5 };
    const ref = short(entry.high.ref);
    const low = await sent(store, (await view(store, { ref, region })).image);
    expect([low.width, low.height]).toEqual([768, 384]);
    const high = await sent(store, (await view(store, { ref, region, detail: "high" })).image);
    expect([high.width, high.height]).toEqual([1568, 784]);
  });

  test("crops the HIGH variant, whichever id was passed", async () => {
    const store = storeOf();
    const white = new Uint8Array(1000 * 500 * 3).fill(255);
    const black = new Uint8Array(500 * 250 * 3);
    const entry = await keep(
      store,
      { bytes: pngOf(1000, 500, white), width: 1000, height: 500 },
      { low: { bytes: pngOf(500, 250, black), width: 500, height: 250 } },
    );
    const r = await view(store, { ref: short(entry.low.ref), region: QUARTER });
    const crop = await sent(store, r.image);
    expect([crop.width, crop.height, crop.pixels[0]]).toEqual([500, 250, 255]);
    expect(r.content).toContain("of 1000×500");
  });

  test("a part equal to a stored LOW variant sends those bytes, not that entry's high", async () => {
    // A PDF page picture: its low is the box downscale of its high, so a
    // whole-picture region at low renders the very same bytes (same id).
    const store = storeOf();
    const pixels = pattern(1000, 500);
    const small = downscalePixels(pixels, 1000, 500, 3, 768, 384);
    const entry = await keep(
      store,
      { bytes: pngOf(1000, 500, pixels), width: 1000, height: 500 },
      { low: { bytes: pngOf(768, 384, small), width: 768, height: 384 } },
    );
    const r = await view(store, {
      ref: short(entry.high.ref),
      region: { left: 0, top: 0, width: 1, height: 1 },
    });
    expect(r.image).toEqual(entry.low.ref);
  });

  test("past an edge it is clamped, and says so", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 200, 100);
    const r = await view(store, {
      ref: short(entry.high.ref),
      region: { left: 0.75, top: 0.5, width: 0.5, height: 1 },
    });
    expect(r.content).toContain("region 150,50 50×50 of 200×100 · sent 50×50");
    expect(r.content).toEndWith(" · clamped to the picture's edge");
  });

  for (const [name, region, said] of [
    ["starting on the edge", { left: 1, top: 0, width: 0.5, height: 0.5 }, "starts at the"],
    ["too small", { left: 0, top: 0, width: 0.01, height: 0.5 }, "2×50 px — too small"],
  ] as const) {
    test(`a part ${name} is an error; nothing is decoded or stored`, async () => {
      const store = storeOf();
      // A valid header over a broken stream: decoding it would say "corrupt".
      const broken = withStream(pngOf(200, 100), new Uint8Array([1, 2, 3]));
      const entry = await keep(store, { bytes: broken, width: 200, height: 100 });
      const r = await view(store, { ref: short(entry.high.ref), region });
      expect(r.isError).toBe(true);
      expect(r.content).toStartWith("shot.png: ");
      expect(r.content).toContain(said);
      expect(r.image).toBeUndefined();
      expect(store.puts).toEqual([]);
    });
  }

  test("a JPEG is an error naming PNG: nothing read, nothing stored", async () => {
    const store = storeOf();
    const bytes = new Uint8Array(500).fill(3);
    const entry = await keep(
      store,
      { bytes, width: 200, height: 100 },
      { mimeType: "image/jpeg", label: "photo.jpg" },
    );
    const held = store.real.held;
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r).toEqual({
      content:
        "region needs a PNG picture; this one is JPEG (JPEG regions come later) — call image_view without region",
      isError: true,
    });
    expect([store.reads, store.puts.length, store.real.held]).toEqual([0, 0, held]);
  });

  test("a corrupt stored PNG is one sentence; nothing stored", async () => {
    const store = storeOf();
    const bytes = withStream(pngOf(200, 100), new Uint8Array([1, 2, 3]));
    const entry = await keep(store, { bytes, width: 200, height: 100 });
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r).toEqual({
      content: "shot.png: the PNG is corrupt (the compressed image data is truncated or invalid)",
      isError: true,
    });
    expect(store.puts).toEqual([]);
  });

  test("a picture over the decode budget is refused with both sizes", async () => {
    const store = storeOf();
    const bytes = withSize(pngOf(200, 100), 20000, 20000);
    const entry = await keep(store, { bytes, width: 20000, height: 20000 });
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r.isError).toBe(true);
    expect(r.content).toBe(
      "shot.png: the PNG is 20000×20000: decoding it needs 2289 MiB, over the 128 MiB limit",
    );
    expect(store.puts).toEqual([]);
  });

  test("bytes the store no longer returns → read the file again", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 200, 100);
    store.read = async () => null;
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r).toEqual({
      content: `image ${short(entry.high.ref)} (shot.png) is no longer held — fs_read the file again, or ask the user to attach it again`,
      isError: true,
    });
  });

  test("a full store refuses without eviction", async () => {
    const source = pngOf(200, 100);
    const store = storeOf(source.length + 10);
    const entry = await keep(store, { bytes: source, width: 200, height: 100 });
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r).toEqual({
      content: "the region was not kept: image store full",
      isError: true,
    });
    expect(store.holds(entry.high.ref)).toBe(true);
  });

  test("over the model's byte cap: scaled down with a note, then refused", async () => {
    let seed = 1;
    const noise = new Uint8Array(400 * 200 * 3).map(() => {
      seed = (seed * 48271) % 2147483647;
      return seed & 255;
    });
    const store = storeOf();
    const entry = await keep(store, {
      bytes: pngOf(400, 200, noise),
      width: 400,
      height: 200,
    });
    const input = { ref: short(entry.high.ref), region: { left: 0, top: 0, width: 1, height: 1 } };
    const scaled = await view(
      store,
      input,
      createImageViewTool("auto", { maxImageBytes: 150_000 }),
    );
    expect(scaled.content).toContain("sent 300×150");
    expect(scaled.content).toEndWith(" · scaled down to fit the image limit");
    const refused = await view(store, input, createImageViewTool("auto", { maxImageBytes: 100 }));
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("too detailed to send under this model's 100 B image limit");
  });

  test("the same part twice, together, is stored once", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 200, 100);
    const input = { ref: short(entry.high.ref), region: QUARTER };
    const tool = createImageViewTool();
    const [a, b] = await Promise.all([view(store, input, tool), view(store, input, tool)]);
    expect(a.image?.id).toBe(b.image?.id ?? "");
    expect(store.real.held).toBe(entry.high.ref.size + (a.image?.size ?? 0));
  });

  test("one decode at a time: the second read waits for the first", async () => {
    const store = storeOf();
    const a = await keepPng(store, 200, 100);
    const b = await keepPng(store, 100, 200);
    const log: string[] = [];
    const read = store.read;
    store.read = async (r: AttachmentRef) => {
      log.push("read");
      return read(r);
    };
    const put = store.putTool;
    store.putTool = (p: ToolImagePut) => {
      log.push("put");
      return put(p);
    };
    const tool = createImageViewTool();
    await Promise.all(
      [a, b].map((e) => view(store, { ref: short(e.high.ref), region: QUARTER }, tool)),
    );
    expect(log).toEqual(["read", "put", "read", "put"]);
  });

  test("a failed decode does not wedge the next one", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 200, 100);
    const read = store.read;
    let calls = 0;
    store.read = async (r: AttachmentRef) => {
      calls += 1;
      if (calls === 1) throw new Error("disk gone");
      return read(r);
    };
    const tool = createImageViewTool();
    const input = { ref: short(entry.high.ref), region: QUARTER };
    await expect(view(store, input, tool)).rejects.toThrow("disk gone");
    expect((await view(store, input, tool)).image).toBeDefined();
  });

  test("a region on the user's own PNG works", async () => {
    const store = storeOf();
    const bytes = pngOf(200, 100);
    // An upload: in the store, never in the tool index.
    const put = await store.real.putTool({
      variants: { high: { bytes, width: 200, height: 100 } },
      mimeType: "image/png",
      label: "mine.png",
    });
    if ("refused" in put) throw new Error(put.refused);
    store.resolve = () => ({ kind: "none" });
    const history: ChatMessage[] = [{ role: "user", content: "see", attachments: [put.high.ref] }];
    const r = await view(
      store,
      { ref: short(put.high.ref), region: QUARTER },
      createImageViewTool(),
      history,
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("region 100,0 100×50 of 200×100");
    expect(r.content).not.toContain("sent as attached");
    expect((await sent(store, r.image)).width).toBe(100);
  });

  test("a region on the user's own JPEG is the same PNG-only error", async () => {
    const store = storeOf();
    const ref: AttachmentRef = { id: "cd".repeat(32), mimeType: "image/jpeg", size: 10 };
    store.holds = () => true;
    const history: ChatMessage[] = [{ role: "user", content: "see", attachments: [ref] }];
    const r = await view(
      store,
      { ref: short(ref), region: QUARTER },
      createImageViewTool(),
      history,
    );
    expect(r.content).toContain("region needs a PNG picture; this one is JPEG");
    expect(store.reads).toBe(0);
  });

  test("a forced setting accepts region and wins over the call's detail", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 4000, 2000);
    const r = await view(
      store,
      { ref: short(entry.high.ref), detail: "low", region: QUARTER },
      createImageViewTool("high"),
    );
    expect((await sent(store, r.image)).width).toBe(1568);
    expect(r.content).toContain(" · high · ");
    expect(r.content).toContain("detail is set to high (a setting); the call's detail was ignored");
  });
});

describe("the schema", () => {
  for (const setting of ["auto", "low", "high"] as const) {
    test(`${setting}: region is kept, and only fractions are accepted`, () => {
      const { inputSchema, description } = createImageViewTool(setting);
      const ref = "a1b2c3d4e5f6";
      expect(inputSchema.parse({ ref, region: QUARTER })).toMatchObject({ region: QUARTER });
      for (const bad of [
        { ...QUARTER, width: 0 },
        { ...QUARTER, height: -0.1 },
        { ...QUARTER, width: 1.5 },
        { ...QUARTER, left: -0.1 },
        { ...QUARTER, top: 200 },
        { left: 0, top: 0, width: 0.5 },
      ]) {
        expect(inputSchema.safeParse({ ref, region: bad }).success).toBe(false);
      }
      expect(description).toContain("`region` zooms into part of a PNG picture: fractions 0–1");
    });
  }
});

describe("low of a high-only PNG (D5)", () => {
  for (const [name, setting, input] of [
    ["by default", "auto", {}],
    ["asked", "auto", { detail: "low" }],
    ["forced", "low", {}],
  ] as const) {
    test(`${name}: a downscale to ≤ 768 px, with no high-only note`, async () => {
      const store = storeOf();
      const entry = await keepPng(store, 2000, 1000);
      const r = await view(
        store,
        { ref: short(entry.high.ref), ...input },
        createImageViewTool(setting),
      );
      const small = await sent(store, r.image);
      expect([small.width, small.height]).toEqual([768, 384]);
      expect(r.content).toBe(`shot.png · 768×384 · low · ${formatBytes(r.image?.size ?? 0)}`);
    });
  }

  // The downscale is an improvement over sending `high`, never a new way for a
  // plain view to fail: whatever stops it, the call answers as it did before.
  const HIGH_NOTE = " · low is not available for this image yet — sent at high";

  async function expectHigh(
    store: ReturnType<typeof storeOf>,
    entry: ToolImageEntry,
    setting: "auto" | "low" = "auto",
    options: { maxImageBytes?: number } = {},
    input: object = {},
  ) {
    const held = store.real.held;
    const r = await view(
      store,
      { ref: short(entry.high.ref), ...input },
      createImageViewTool(setting, options),
    );
    const { width, height, ref } = entry.high;
    expect(r).toEqual({
      content: `shot.png · ${width}×${height} · low · ${formatBytes(ref.size)}${HIGH_NOTE}`,
      image: ref,
    });
    expect(store.real.held).toBe(held);
  }

  for (const [name, setting, input] of [
    ["by default", "auto", {}],
    ["asked", "auto", { detail: "low" }],
    ["forced", "low", {}],
  ] as const) {
    test(`${name}: over the decode budget → the stored high picture, not an error`, async () => {
      const store = storeOf();
      const bytes = withSize(pngOf(200, 100), 8000, 4500);
      const entry = await keep(store, { bytes, width: 8000, height: 4500 });
      await expectHigh(store, entry, setting, {}, input);
    });
  }

  test("a PNG this parser refuses → the stored high picture", async () => {
    const store = storeOf();
    const bytes = new Uint8Array(500).fill(3);
    const entry = await keep(store, { bytes, width: 2000, height: 1000 });
    await expectHigh(store, entry);
  });

  test("a PNG that fails to decode → the stored high picture", async () => {
    const store = storeOf();
    const bytes = withStream(pngOf(2000, 1000), new Uint8Array([1, 2, 3]));
    const entry = await keep(store, { bytes, width: 2000, height: 1000 });
    await expectHigh(store, entry);
  });

  test("a downscale over the byte cap → the stored high picture", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 2000, 1000);
    await expectHigh(store, entry, "auto", { maxImageBytes: 100 });
  });

  test("a full store → the stored high picture", async () => {
    const source = pngOf(2000, 1000);
    const store = storeOf(source.length + 10);
    const entry = await keep(store, { bytes: source, width: 2000, height: 1000 });
    await expectHigh(store, entry);
  });

  test("bytes the store no longer returns → read the file again, as for a region", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 2000, 1000);
    store.read = async () => null;
    const r = await view(store, { ref: short(entry.high.ref) });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("is no longer held");
    expect(r.image).toBeUndefined();
  });

  test("high still sends the stored picture, reading nothing", async () => {
    const store = storeOf();
    const entry = await keepPng(store, 2000, 1000);
    const r = await view(store, { ref: short(entry.high.ref), detail: "high" });
    expect(r.image).toEqual(entry.high.ref);
    expect(store.reads).toBe(0);
  });

  test("a high-only JPEG keeps today's note", async () => {
    const store = storeOf();
    const entry = await keep(
      store,
      { bytes: new Uint8Array(500).fill(3), width: 2000, height: 1000 },
      { mimeType: "image/jpeg", label: "photo.jpg" },
    );
    const r = await view(store, { ref: short(entry.high.ref) });
    expect(r.image).toEqual(entry.high.ref);
    expect(r.content).toContain("low is not available for this image yet — sent at high");
    expect(store.reads).toBe(0);
  });
});

describe("concurrency (T7)", () => {
  const claims = (input: unknown) => {
    const concurrency = createImageViewTool().concurrency;
    return typeof concurrency === "function" ? concurrency(input) : concurrency;
  };

  test("a region also claims the one decode slot", () => {
    expect(claims({ ref: "a1b2c3d4", region: QUARTER })).toEqual([
      { mode: "read", resource: "tool-images" },
      { mode: "write", resource: "image-decode" },
    ]);
  });

  test("without a region: today's single read claim, even for garbage", () => {
    for (const input of [{ ref: "a1b2c3d4" }, null, undefined, "x"]) {
      expect(claims(input)).toEqual([{ mode: "read", resource: "tool-images" }]);
    }
  });
});

/** `png`'s IHDR with another size (its CRC redone): a header that lies. */
function withSize(png: Uint8Array, width: number, height: number): Uint8Array {
  const out = Buffer.from(png);
  out.writeUInt32BE(width, 16);
  out.writeUInt32BE(height, 20);
  out.writeUInt32BE(crc32(new Uint8Array(out.subarray(12, 29))), 29);
  return new Uint8Array(out);
}

/** `png` (signature, IHDR, IDAT, IEND) with another IDAT stream, CRC intact. */
function withStream(png: Uint8Array, stream: Uint8Array): Uint8Array {
  const idat = Buffer.alloc(12 + stream.length);
  idat.writeUInt32BE(stream.length, 0);
  idat.write("IDAT", 4, "latin1");
  idat.set(stream, 8);
  idat.writeUInt32BE(crc32(new Uint8Array(idat.subarray(4, 8 + stream.length))), 8 + stream.length);
  return new Uint8Array(
    Buffer.concat([png.subarray(0, 33), new Uint8Array(idat), png.subarray(-12)]),
  );
}
