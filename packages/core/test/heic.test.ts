/**
 * docs/feat/image-heic.md T1: the pure half of the HEIC conversion — what is
 * asked of the decoder, and what is believed of its answer (it exits 0 on a
 * truncated input, so nothing is believed until the strict JPEG checks pass).
 */
import { describe, expect, test } from "bun:test";
import {
  HEIC_ATTACH_MAX_EDGE,
  HEIC_FILE_MAX_EDGE,
  type HeicOps,
  checkHeicOutput,
  convertHeicWith,
  heicFormatLabel,
  heicJpegName,
  heicTarget,
  imageOverCapReason,
} from "../src/index.ts";

const read = async (path: string) =>
  new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/${path}`).arrayBuffer());
const baseline = await read("jpeg/small-baseline.jpg");
const png = await read("png/basn2c08.png");

/** The offset of the first SOF marker. */
const sofAt = (bytes: Uint8Array): number => {
  for (let i = 0; i + 1 < bytes.length; i += 1) {
    if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) return i;
  }
  throw new Error("no SOF in the fixture");
};

/** The real fixture with another size written into its frame header, plus padding. */
const jpegOf = (width: number, height: number, padding = 0): Uint8Array => {
  const out = new Uint8Array(baseline.length + padding);
  out.set(baseline);
  const at = sofAt(baseline) + 5;
  out.set([height >> 8, height & 0xff, width >> 8, width & 0xff], at);
  return out;
};

/** Ops that record every `toJpeg` edge; the output is `w×h` scaled to the edge. */
const fakeOps = (
  size: { w: number; h: number } | undefined,
  padding = 0,
): HeicOps & { edges: (number | undefined)[] } => {
  const edges: (number | undefined)[] = [];
  return {
    edges,
    size: async () => size,
    toJpeg: async (edge) => {
      edges.push(edge);
      if (size === undefined) throw new Error("toJpeg without a size");
      const scale = (edge ?? Math.max(size.w, size.h)) / Math.max(size.w, size.h);
      return jpegOf(Math.round(size.w * scale), Math.round(size.h * scale), padding);
    },
  };
};

const LIMITS = { maxEdge: 4032, maxBytes: 1_000_000 };

describe("heicTarget", () => {
  test("the two entry points' sides", () => {
    expect([HEIC_FILE_MAX_EDGE, HEIC_ATTACH_MAX_EDGE]).toEqual([4032, 2048]);
  });

  test("never upscales", () => {
    expect(heicTarget({ w: 64, h: 48 }, 4032)).toEqual({ edge: 64, downscale: false });
    expect(heicTarget({ w: 4032, h: 3024 }, 4032)).toEqual({ edge: 4032, downscale: false });
  });

  test("shrinks to the side asked", () => {
    expect(heicTarget({ w: 8064, h: 6048 }, 4032)).toEqual({ edge: 4032, downscale: true });
    expect(heicTarget({ w: 3024, h: 4032 }, 1568)).toEqual({ edge: 1568, downscale: true });
  });

  test("refuses over 64 MP and a size that cannot be read", () => {
    expect(heicTarget({ w: 8000, h: 8000 }, 4032)).toEqual({ edge: 4032, downscale: true });
    expect(heicTarget({ w: 8001, h: 8000 }, 4032)).toEqual({
      refused: "the HEIC is 8001×8000, over the 64 MP limit",
    });
    const unreadable = { refused: "the HEIC is corrupt (no readable size)" };
    expect(heicTarget(undefined, 4032)).toEqual(unreadable);
    expect(heicTarget({ w: 0, h: 10 }, 4032)).toEqual(unreadable);
    expect(heicTarget({ w: 10, h: Number.NaN }, 4032)).toEqual(unreadable);
  });
});

describe("checkHeicOutput", () => {
  const broken = {
    refused: "the HEIC is corrupt or truncated (its decoded JPEG is not whole)",
  };

  test("a whole JPEG of the planned side passes", () => {
    expect(checkHeicOutput(baseline, 64)).toMatchObject({
      mimeType: "image/jpeg",
      width: 64,
      height: 48,
    });
  });

  test("another long edge than the planned one is refused, over or under", () => {
    expect(checkHeicOutput(baseline, 63)).toEqual(broken);
    expect(checkHeicOutput(baseline, 65)).toEqual(broken);
  });

  test("a JPEG cut before its frame header, or before its end, is refused", () => {
    expect(checkHeicOutput(baseline.subarray(0, sofAt(baseline)), 64)).toEqual(broken);
    expect(checkHeicOutput(baseline.subarray(0, baseline.length - 2), 64)).toEqual(broken);
  });

  test("a header the strict walk refuses is refused", () => {
    // An EOI-looking pair after the scan start satisfies the lax walk; data
    // where a marker belongs does not satisfy the strict one.
    const at = sofAt(baseline);
    const bad = new Uint8Array([...baseline.subarray(0, at), 0, ...baseline.subarray(at)]);
    expect(checkHeicOutput(bad, 64)).toEqual(broken);
  });

  test("a PNG is refused", () => {
    // 32×32, so the side asked matches and only the type can refuse it.
    expect(checkHeicOutput(png, 32)).toEqual(broken);
  });
});

describe("convertHeicWith", () => {
  test("no downscale: the decoder is asked for no side at all", async () => {
    const ops = fakeOps({ w: 64, h: 48 });
    const result = await convertHeicWith(LIMITS, ops);
    expect(ops.edges).toEqual([undefined]);
    expect(result).toMatchObject({ width: 64, height: 48, sourceWidth: 64, sourceHeight: 48 });
  });

  test("a bigger source is asked at the side", async () => {
    const ops = fakeOps({ w: 8064, h: 6048 });
    const result = await convertHeicWith(LIMITS, ops);
    expect(ops.edges).toEqual([4032]);
    expect(result).toMatchObject({ width: 4032, height: 3024, sourceWidth: 8064 });
  });

  test("over the byte cap: three smaller steps, then the cap sentence", async () => {
    const ops = fakeOps({ w: 4032, h: 3024 }, 2000);
    const result = await convertHeicWith({ maxEdge: 4032, maxBytes: 500 }, ops);
    expect(ops.edges).toEqual([undefined, 3024, 2268, 1701]);
    expect(result).toEqual({ refused: imageOverCapReason(baseline.length + 2000, 500) });
  });

  test("a step that fits is the answer", async () => {
    const edges: (number | undefined)[] = [];
    const ops: HeicOps = {
      size: async () => ({ w: 4032, h: 3024 }),
      toJpeg: async (edge) => {
        edges.push(edge);
        return edge === undefined ? jpegOf(4032, 3024, 2000) : jpegOf(3024, 2268);
      },
    };
    const result = await convertHeicWith({ maxEdge: 4032, maxBytes: baseline.length }, ops);
    expect(edges).toEqual([undefined, 3024]);
    expect(result).toMatchObject({ width: 3024, height: 2268, sourceWidth: 4032 });
  });

  test("a refused or unreadable size never decodes", async () => {
    for (const size of [undefined, { w: 9000, h: 9000 }]) {
      const ops = fakeOps(size);
      expect(await convertHeicWith(LIMITS, ops)).toHaveProperty("refused");
      expect(ops.edges).toEqual([]);
    }
    let decodes = 0;
    const refused = await convertHeicWith(LIMITS, {
      size: async () => ({ refused: "slow" }),
      toJpeg: async () => {
        decodes += 1;
        return baseline;
      },
    });
    expect([refused, decodes]).toEqual([{ refused: "slow" }, 0]);
  });

  test("the decoder's own refusal passes through", async () => {
    const result = await convertHeicWith(LIMITS, {
      size: async () => ({ w: 64, h: 48 }),
      toJpeg: async () => ({ refused: "no" }),
    });
    expect(result).toEqual({ refused: "no" });
  });

  test("a broken output is refused, never returned", async () => {
    const result = await convertHeicWith(LIMITS, {
      size: async () => ({ w: 64, h: 48 }),
      toJpeg: async () => baseline.subarray(0, baseline.length - 2),
    });
    expect(result).toEqual({
      refused: "the HEIC is corrupt or truncated (its decoded JPEG is not whole)",
    });
  });
});

describe("names and labels", () => {
  test("a converted name wears .jpg", () => {
    expect(heicJpegName("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
    expect(heicJpegName("a.heif")).toBe("a.jpg");
    expect(heicJpegName("noextension")).toBe("noextension");
    expect(heicJpegName(".heic")).toBe(".heic");
    expect(heicJpegName("a.jpeg")).toBe("a.jpeg");
    // A shorter extension must not push the name over the wire's 255.
    const long = heicJpegName(`${"a".repeat(253)}.h`);
    expect(long).toBe(`${"a".repeat(251)}.jpg`);
  });

  test("the label names the source size only when it shrank", () => {
    const whole = { width: 64, height: 48, sourceWidth: 64, sourceHeight: 48 };
    expect(heicFormatLabel(whole)).toBe("HEIC→JPEG");
    expect(
      heicFormatLabel({ width: 4032, height: 3024, sourceWidth: 8064, sourceHeight: 6048 }),
    ).toBe("HEIC 8064×6048→JPEG");
  });
});
