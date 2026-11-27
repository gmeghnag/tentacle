/**
 * `image_view`'s `region` and the `low` of a high-only PNG
 * (docs/feat/image-region-png.md D1/D4/D5, T6/T7), over a REAL memory
 * `AttachmentStore`: what is sent is a new stored picture holding exactly the
 * asked pixels, and its own id views it again.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { deflateSync, inflate as inflateCb } from "node:zlib";
import {
  type AttachmentRef,
  type ChatMessage,
  type DecodedPng,
  PNG_CHANNELS,
  type Tool,
  type ToolContext,
  type ToolImageEntry,
  type ToolImagePut,
  type ToolImageStore,
  crc32,
  cropPixels,
  decodePng,
  downscalePixels,
  encodePng,
  formatBytes,
} from "@tentacle/core";
import { AttachmentStore, UploadBudget } from "../../daemon/src/attachment-store.ts";
import { createFsReadTool } from "../src/builtins.ts";
import { type ImageViewInput, createImageViewTool } from "../src/image-view.ts";
import { BunImage, difference, fixture, reference } from "./support/jpeg-oracle.ts";

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

  test("a corrupt stored JPEG is one sentence; nothing stored", async () => {
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
      content: "photo.jpg: the JPEG is corrupt (no start-of-image marker)",
      isError: true,
    });
    expect([store.puts.length, store.real.held]).toEqual([0, held]);
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

  for (const format of ["GIF", "WEBP"] as const) {
    test(`a region on the user's own ${format} is an error naming it; nothing read`, async () => {
      const store = storeOf();
      const mimeType = format === "GIF" ? "image/gif" : "image/webp";
      const ref: AttachmentRef = { id: "cd".repeat(32), mimeType, size: 10 };
      store.holds = () => true;
      const history: ChatMessage[] = [{ role: "user", content: "see", attachments: [ref] }];
      const r = await view(
        store,
        { ref: short(ref), region: QUARTER },
        createImageViewTool(),
        history,
      );
      expect(r).toEqual({
        content: `region needs a PNG or JPEG picture; this one is ${format} — call image_view without region`,
        isError: true,
      });
      expect(store.reads).toBe(0);
    });
  }

  test("region on the user's own JPEG crops it", async () => {
    const store = storeOf();
    const bytes = await fixture("small-orient-3");
    const ref: AttachmentRef = {
      id: createHash("sha256").update(bytes).digest("hex"),
      mimeType: "image/jpeg",
      size: bytes.length,
      name: "me.jpg",
    };
    store.holds = () => true;
    store.read = async () => bytes;
    const history: ChatMessage[] = [{ role: "user", content: "see", attachments: [ref] }];
    const r = await view(
      store,
      { ref: short(ref), region: QUARTER },
      createImageViewTool(),
      history,
    );
    expect(r.isError).toBeUndefined();
    expect(r.content).toStartWith("me.jpg · region 32,0 32×24 of 64×48 · sent 32×24 · low");
    expect(r.content).toContain(" · EXIF orientation 3 applied");
    expect(store.puts.map((p) => [p.label, p.mimeType])).toEqual([["me.jpg region", "image/jpeg"]]);
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
      expect(description).toContain(
        "`region` zooms into part of a PNG or JPEG picture: fractions 0–1",
      );
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

  test("a high-only JPEG it cannot decode keeps the high-only note", async () => {
    const store = storeOf();
    const entry = await keep(
      store,
      { bytes: new Uint8Array(500).fill(3), width: 2000, height: 1000 },
      { mimeType: "image/jpeg", label: "photo.jpg" },
    );
    const r = await view(store, { ref: short(entry.high.ref) });
    expect(r.image).toEqual(entry.high.ref);
    expect(r.content).toContain("low is not available for this image yet — sent at high");
    expect(store.puts).toEqual([]);
  });
});

describe("JPEG pictures (docs/feat/image-region-jpeg.md T6)", () => {
  const HIGH_NOTE = " · low is not available for this image yet — sent at high";

  const keepJpeg = (
    store: ReturnType<typeof storeOf>,
    bytes: Uint8Array,
    width = 64,
    height = 48,
  ) => keep(store, { bytes, width, height }, { mimeType: "image/jpeg", label: "photo.jpg" });

  /** A 1600×1200 JPEG from the independent encoder, never from our code. */
  const large = async (): Promise<Uint8Array> =>
    new BunImage(await fixture("small-baseline")).resize(1600, 1200).jpeg().bytes();

  /** The bytes a result sends, which must be a JPEG. */
  async function sentJpeg(
    store: ReturnType<typeof storeOf>,
    image: AttachmentRef | undefined,
  ): Promise<DecodedPng> {
    if (image === undefined) throw new Error("the result sends no image");
    expect(image.mimeType).toBe("image/jpeg");
    const bytes = await store.real.read(image);
    if (bytes === null) throw new Error("the sent image's bytes are not held");
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
    return reference(bytes, false);
  }

  test("a region sends a NEW stored JPEG of that size, viewable by its own id", async () => {
    const store = storeOf();
    const entry = await keepJpeg(store, await fixture("small-baseline"));
    const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
    expect(r.isError).toBeUndefined();
    const image = r.image;
    if (image === undefined) throw new Error("no crop");
    expect([entry.high.ref.id, entry.low.ref.id]).not.toContain(image.id);
    expect(r.content).toBe(
      `photo.jpg · region 32,0 32×24 of 64×48 · sent 32×24 · low · ${formatBytes(image.size)}`,
    );
    const crop = await sentJpeg(store, image);
    expect([crop.width, crop.height]).toEqual([32, 24]);
    expect(store.resolve(short(image)).kind).toBe("found");
    expect((await view(store, { ref: short(image) })).image).toEqual(image);
  });

  for (const o of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`orientation ${o}: the region is the DISPLAYED top-right quarter`, async () => {
      const store = storeOf();
      const bytes = await fixture(`small-orient-${o}`);
      const entry = await keepJpeg(store, bytes);
      const r = await view(store, { ref: short(entry.high.ref), region: QUARTER });
      const [width, height] = o < 5 ? [64, 48] : [48, 64];
      expect(r.content).toContain(`of ${width}×${height} · sent ${width / 2}×${height / 2}`);
      if (o === 1) {
        expect(r.content).not.toContain("EXIF");
      } else {
        expect(r.content).toContain(` · EXIF orientation ${o} applied`);
      }
      const oracle = await reference(bytes, true);
      const quarter: DecodedPng = {
        width: width / 2,
        height: height / 2,
        color: oracle.color,
        pixels: cropPixels(oracle.pixels, width, height, PNG_CHANNELS[oracle.color], {
          x: width / 2,
          y: 0,
          width: width / 2,
          height: height / 2,
          clamped: false,
        }),
      };
      // Twice lossy (4:2:0 in, q85 out): looser than the decoder's own check,
      // and still far from any other part or turn of the picture.
      const delta = difference(await sentJpeg(store, r.image), quarter);
      expect(delta.mean).toBeLessThanOrEqual(4);
    });
  }

  for (const [name, setting, input] of [
    ["by default", "auto", {}],
    ["asked", "auto", { detail: "low" }],
    ["forced", "low", {}],
  ] as const) {
    test(`low ${name} of a high-only JPEG: ≤ 768 px, with no note`, async () => {
      const store = storeOf();
      const entry = await keepJpeg(store, await large(), 1600, 1200);
      const r = await view(
        store,
        { ref: short(entry.high.ref), ...input },
        createImageViewTool(setting),
      );
      expect(r.content).toBe(`photo.jpg · 768×576 · low · ${formatBytes(r.image?.size ?? 0)}`);
      const small = await sentJpeg(store, r.image);
      expect([small.width, small.height]).toEqual([768, 576]);
    });
  }

  test("a forced setting accepts a region and decides its size", async () => {
    const store = storeOf();
    const entry = await keepJpeg(store, await large(), 1600, 1200);
    const r = await view(
      store,
      { ref: short(entry.high.ref), detail: "low", region: { ...QUARTER, left: 0, width: 1 } },
      createImageViewTool("high"),
    );
    expect(r.content).toContain("region 0,0 1600×600 of 1600×1200 · sent 1568×588 · high");
    expect(r.content).toContain("detail is set to high (a setting)");
  });

  /** `small-baseline` with the segment at `marker` rewritten by `change`. */
  async function crafted(marker: number, change: (segment: number[]) => number[]) {
    const base = await fixture("small-baseline");
    let i = 2;
    while (base[i + 1] !== marker) {
      i += 2 + (((base[i + 2] ?? 0) << 8) | (base[i + 3] ?? 0));
    }
    const end = i + 2 + (((base[i + 2] ?? 0) << 8) | (base[i + 3] ?? 0));
    return new Uint8Array([
      ...base.subarray(0, i),
      ...change([...base.subarray(i, end)]),
      ...base.subarray(end),
    ]);
  }
  const sized = (segment: number[], width: number, height: number) => {
    segment.splice(5, 4, height >> 8, height & 255, width >> 8, width & 255);
    return segment;
  };
  const refusals: readonly [string, () => Promise<Uint8Array>, string][] = [
    [
      "a CMYK JPEG",
      () =>
        crafted(0xc0, (s) => {
          s.splice(2, 2, 0, 20);
          s[9] = 4;
          return [...s, 4, 0x11, 0];
        }),
      "a CMYK JPEG — convert it to RGB first",
    ],
    [
      "a JPEG the strict walk refuses",
      () => crafted(0xda, (s) => [...s, 0xff, 0xdc, 0, 4, 1, 0]),
      "the JPEG has an unexpected layout (a DNL marker that changes the height)",
    ],
    [
      "an over-budget JPEG",
      () => crafted(0xc0, (s) => sized(s, 8000, 8000)),
      "the JPEG is 8000×8000: decoding it needs 367 MiB, over the 128 MiB limit",
    ],
    ["a JPEG the decoder fails on", () => crafted(0xc4, () => []), "the JPEG is corrupt ("],
  ];
  for (const [name, make, said] of refusals) {
    test(`${name}: a region is one error; a plain low view sends high`, async () => {
      const store = storeOf();
      const entry = await keepJpeg(store, await make(), 2000, 1000);
      const held = store.real.held;
      const ref = short(entry.high.ref);
      const region = await view(store, { ref, region: QUARTER });
      expect(region.isError).toBe(true);
      expect(region.content).toStartWith(`photo.jpg: ${said}`);
      expect(region.image).toBeUndefined();
      expect(await view(store, { ref })).toEqual({
        content: `photo.jpg · 2000×1000 · low · ${formatBytes(entry.high.ref.size)}${HIGH_NOTE}`,
        image: entry.high.ref,
      });
      expect([store.puts.length, store.real.held]).toEqual([0, held]);
    });
  }

  test("a region the picture cannot give decodes and stores nothing", async () => {
    const store = storeOf();
    const entry = await keepJpeg(store, await fixture("small-orient-6"));
    const r = await view(store, {
      ref: short(entry.high.ref),
      region: { left: 0, top: 0, width: 0.1, height: 1 },
    });
    // Judged on the DISPLAYED 48×64 picture.
    expect(r.content).toBe("photo.jpg: 5×64 px — too small; pick a larger part");
    expect(store.puts).toEqual([]);
  });

  test("over the byte cap: a region is refused, a plain low view sends high", async () => {
    const store = storeOf();
    const entry = await keepJpeg(store, await large(), 1600, 1200);
    const tool = createImageViewTool("auto", { maxImageBytes: 100 });
    const ref = short(entry.high.ref);
    const region = await view(store, { ref, region: QUARTER }, tool);
    expect(region.content).toContain("too detailed to send under this model's 100 B image limit");
    const plain = await view(store, { ref }, tool);
    expect([plain.image, plain.content.toString().endsWith(HIGH_NOTE)]).toEqual([
      entry.high.ref,
      true,
    ]);
    expect(store.puts).toEqual([]);
  });

  test("a full store: a region is an error, a plain low view sends high", async () => {
    const source = await large();
    const store = storeOf(source.length + 10);
    const entry = await keepJpeg(store, source, 1600, 1200);
    const ref = short(entry.high.ref);
    const region = await view(store, { ref, region: QUARTER });
    expect(region.isError).toBe(true);
    expect(region.content).toStartWith("the region was not kept: ");
    const plain = await view(store, { ref });
    expect([plain.isError, plain.image]).toEqual([undefined, entry.high.ref]);
    expect(plain.content).toEndWith(HIGH_NOTE);
  });

  test("bytes the store no longer returns end both kinds of call", async () => {
    const store = storeOf();
    const entry = await keepJpeg(store, await large(), 1600, 1200);
    store.read = async () => null;
    const ref = short(entry.high.ref);
    for (const input of [{ ref }, { ref, region: QUARTER }]) {
      const r = await view(store, input);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("is no longer held");
    }
  });
});

describe("a HEIC read, then viewed (docs/feat/image-heic.md T5)", () => {
  test("fs_read's converted JPEG gives a region of the DISPLAYED picture", async () => {
    const heic = new Uint8Array(
      await Bun.file(
        `${import.meta.dir}/../../core/test/fixtures/heic/small-orient-6.heic`,
      ).arrayBuffer(),
    );
    const jpeg = await fixture("small-orient-6");
    const store = storeOf();
    const reading = createFsReadTool({
      images: true,
      heic: async () => ({
        bytes: jpeg,
        width: 64,
        height: 48,
        sourceWidth: 64,
        sourceHeight: 48,
      }),
    });
    const env = {
      readBytes: async (_path: string, o?: { readLimitBytes?: number }) =>
        o?.readLimitBytes === undefined ? heic : heic.subarray(0, o.readLimitBytes),
    } as unknown as ToolContext["env"];
    const read = await reading.execute({ path: "IMG_6.heic" }, { ...ctx(store), env });
    const ref = read.content.toString().match(/ref ([0-9a-f]{12})/)?.[1] ?? "";
    const r = await view(store, { ref, region: QUARTER });
    expect(r.isError).toBeUndefined();
    expect(r.image?.mimeType).toBe("image/jpeg");
    expect(r.content).toContain("IMG_6.heic · region ");
    expect(r.content).toContain(" of 48×64");
    expect(r.content).toContain(" · EXIF orientation 6 applied");
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
