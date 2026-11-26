/**
 * `decodePng` (docs/feat/image-region-png.md D2). T1/T2 read the official
 * PngSuite (an independent encoder: our own writes only 8-bit filter-None and
 * would test the decoder against itself); T3/T4 and the corrupt cases build
 * the exact malformed bytes they need.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { deflateSync, inflate as inflateCb } from "node:zlib";
import { type Inflate, MAX_PNG_DECODE_BYTES, decodePng, readPngHeader } from "../src/png-decode.ts";
import { crc32 } from "../src/png.ts";

const inflateAsync = promisify(inflateCb);
const inflate: Inflate = async (bytes, maxOutputLength) =>
  new Uint8Array(await inflateAsync(bytes, { maxOutputLength }));
const zip = (bytes: Uint8Array): Uint8Array => new Uint8Array(deflateSync(bytes));

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const concat = (parts: readonly Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(new Uint8Array(out.subarray(4, 8 + data.length))), 8 + data.length);
  return new Uint8Array(out);
}

interface Shape {
  readonly width?: number;
  readonly height?: number;
  readonly depth?: number;
  readonly colorType?: number;
  readonly compression?: number;
  readonly filter?: number;
  readonly interlace?: number;
}

function ihdr(s: Shape = {}): Uint8Array {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(s.width ?? 2, 0);
  data.writeUInt32BE(s.height ?? 2, 4);
  data.set(
    [s.depth ?? 8, s.colorType ?? 0, s.compression ?? 0, s.filter ?? 0, s.interlace ?? 0],
    8,
  );
  return chunk("IHDR", new Uint8Array(data));
}

/** A 2×2 8-bit gray image's rows (filter None). */
const ROWS = new Uint8Array([0, 10, 20, 0, 30, 40]);
const idat = (raw: Uint8Array = ROWS): Uint8Array => chunk("IDAT", zip(raw));
const iend = (): Uint8Array => chunk("IEND", new Uint8Array(0));
const png = (...chunks: Uint8Array[]): Uint8Array => concat([new Uint8Array(SIGNATURE), ...chunks]);

async function refusal(bytes: Uint8Array): Promise<string> {
  const result = await decodePng(bytes, inflate);
  return "refused" in result ? result.refused : "(decoded)";
}

describe("the decode budget (T3)", () => {
  test("a header claiming 60000×60000 is refused before inflate is ever called", async () => {
    let calls = 0;
    const spy: Inflate = (bytes, max) => {
      calls += 1;
      return inflate(bytes, max);
    };
    const bytes = png(ihdr({ width: 60000, height: 60000, colorType: 6 }), idat(), iend());
    const result = await decodePng(bytes, spy);
    expect("refused" in result ? result.refused : "").toBe(
      "the PNG is 60000×60000: decoding it needs 27466 MiB, over the 128 MiB limit",
    );
    expect(calls).toBe(0);
  });

  test("the budget counts the 8-bit output too (a 1-bit picture expands)", async () => {
    // 12000×12000 1-bit gray: 17 MiB inflated, 137 MiB of 8-bit output.
    const bytes = png(ihdr({ width: 12000, height: 12000, depth: 1 }), idat(), iend());
    expect(MAX_PNG_DECODE_BYTES).toBe(128 * 1024 * 1024);
    expect(await refusal(bytes)).toContain("over the 128 MiB limit");
  });

  test("the header alone names the exact inflated size and the output colour", () => {
    const header = readPngHeader(png(ihdr({ width: 5, height: 3, depth: 1 }), idat(), iend()));
    expect(header).toMatchObject({ width: 5, height: 3, rawBytes: 6, outColor: "gray" });
  });

  test("Adam7's size is the sum of its non-empty passes", () => {
    // 3×3 8-bit gray: passes 1, 4, 5, 6, 7 are non-empty → 2 + 2 + 3 + 4 + 4.
    const header = readPngHeader(png(ihdr({ width: 3, height: 3, interlace: 1 }), idat(), iend()));
    expect(header).toMatchObject({ rawBytes: 15 });
  });
});

describe("a lying IDAT (T4)", () => {
  test("10 MB behind a 16×16 header is cut by maxOutputLength and refused", async () => {
    const bomb = idat(new Uint8Array(10_000_000));
    const asked: number[] = [];
    const watched: Inflate = (bytes, max) => {
      asked.push(max);
      return inflate(bytes, max);
    };
    const result = await decodePng(png(ihdr({ width: 16, height: 16 }), bomb, iend()), watched);
    expect("refused" in result ? result.refused : "").toBe(
      "the PNG is corrupt (more image data than its header declares)",
    );
    expect(asked).toEqual([16 * 17]);
  });
});

describe("corrupt and unusual files", () => {
  const good = (): Uint8Array => png(ihdr(), idat(), iend());

  test("the hand-built base picture decodes", async () => {
    const result = await decodePng(good(), inflate);
    expect(result).toMatchObject({ width: 2, height: 2, color: "gray" });
    expect("pixels" in result ? [...result.pixels] : []).toEqual([10, 20, 30, 40]);
  });

  const flipped = (at: number): Uint8Array => {
    const bytes = good().slice();
    bytes[at] = (bytes[at] as number) ^ 0xff;
    return bytes;
  };
  const palette = chunk("PLTE", new Uint8Array([1, 2, 3, 4, 5, 6]));
  const cases: readonly [string, Uint8Array, string][] = [
    ["a bad signature", flipped(1), "signature"],
    ["a bad IHDR CRC", flipped(32), "IHDR checksum"],
    ["a bad IDAT CRC", flipped(good().length - 13), "IDAT checksum"],
    ["a bad IEND CRC", flipped(good().length - 1), "IEND checksum"],
    ["no IHDR first", png(idat(), ihdr(), iend()), "IHDR"],
    ["a second IHDR", png(ihdr(), ihdr(), idat(), iend()), "IHDR"],
    ["no IDAT", png(ihdr(), iend()), "no IDAT"],
    ["no IEND", png(ihdr(), idat()), "no IEND"],
    ["a file cut inside a chunk", good().subarray(0, 40), "truncated"],
    [
      "a truncated stream",
      png(ihdr(), chunk("IDAT", zip(ROWS).subarray(0, 6)), iend()),
      "compressed",
    ],
    ["less data than declared", png(ihdr(), idat(ROWS.subarray(0, 3)), iend()), "less image data"],
    ["filter byte 5", png(ihdr(), idat(new Uint8Array([0, 1, 2, 5, 3, 4])), iend()), "filter"],
    [
      "a palette index past the palette",
      png(ihdr({ colorType: 3 }), palette, idat(new Uint8Array([0, 0, 1, 0, 2, 0])), iend()),
      "palette",
    ],
    ["a palette picture with no PLTE", png(ihdr({ colorType: 3 }), idat(), iend()), "PLTE"],
    [
      "a PLTE of 4 bytes",
      png(ihdr({ colorType: 3 }), chunk("PLTE", new Uint8Array(4)), idat(), iend()),
      "PLTE",
    ],
    [
      "257 palette entries",
      png(ihdr({ colorType: 3 }), chunk("PLTE", new Uint8Array(771)), idat(), iend()),
      "PLTE",
    ],
    ["a short tRNS", png(ihdr(), chunk("tRNS", new Uint8Array(1)), idat(), iend()), "tRNS"],
    ["an unknown critical chunk", png(ihdr(), chunk("ABCD", ROWS), idat(), iend()), "ABCD"],
    [
      "IDATs that are not consecutive",
      png(ihdr(), idat(), chunk("teXt", ROWS), idat(), iend()),
      "consecutive",
    ],
    ["colour type 5", png(ihdr({ colorType: 5 }), idat(), iend()), "depth"],
    ["depth 3", png(ihdr({ depth: 3 }), idat(), iend()), "depth"],
    ["width 0", png(ihdr({ width: 0 }), idat(), iend()), "size"],
    ["compression method 1", png(ihdr({ compression: 1 }), idat(), iend()), "method"],
    ["filter method 1", png(ihdr({ filter: 1 }), idat(), iend()), "method"],
    ["interlace 2", png(ihdr({ interlace: 2 }), idat(), iend()), "interlace"],
  ];

  for (const [name, bytes, word] of cases) {
    test(`${name} → one sentence, never a throw`, async () => {
      const said = await refusal(bytes);
      expect(said).toStartWith("the PNG is corrupt (");
      expect(said).toContain(word);
    });
  }

  test("ancillary and animation chunks are ignored (an APNG shows its default image)", async () => {
    const bytes = png(
      ihdr(),
      chunk("acTL", new Uint8Array(8)),
      chunk("gAMA", new Uint8Array(4)),
      idat(),
      chunk("fdAT", ROWS),
      iend(),
    );
    const result = await decodePng(bytes, inflate);
    expect("pixels" in result ? [...result.pixels] : []).toEqual([10, 20, 30, 40]);
  });

  test("split IDATs are one stream", async () => {
    const stream = zip(ROWS);
    const bytes = png(
      ihdr(),
      chunk("IDAT", stream.subarray(0, 4)),
      chunk("IDAT", stream.subarray(4)),
      iend(),
    );
    const result = await decodePng(bytes, inflate);
    expect("pixels" in result ? [...result.pixels] : []).toEqual([10, 20, 30, 40]);
  });
});

// Bytes written and expected values computed by hand from the PNG spec: they
// pin each case in-tree, beside (never instead of) PngSuite's real files.
describe("hand-computed from the spec", () => {
  async function pixels(shape: Shape, raw: number[], ...extra: Uint8Array[]): Promise<number[]> {
    const bytes = png(ihdr(shape), ...extra, idat(new Uint8Array(raw)), iend());
    const result = await decodePng(bytes, inflate);
    if ("refused" in result) throw new Error(result.refused);
    return [...result.pixels];
  }
  const plte = chunk("PLTE", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  const trns = (...data: number[]): Uint8Array => chunk("tRNS", new Uint8Array(data));

  test("every filter type, with Paeth taking each of its three neighbours", async () => {
    const raw = [
      [0, 10, 20, 30],
      [1, 5, 5, 5],
      [2, 1, 1, 1],
      [3, 2, 2, 2],
      [4, 250, 2, 1],
    ].flat();
    expect(await pixels({ width: 3, height: 5 }, raw)).toEqual([
      10, 20, 30, 5, 10, 15, 6, 11, 16, 5, 10, 15, 255, 1, 11,
    ]);
  });

  test("1, 2 and 4-bit gray scale to 0–255", async () => {
    expect(await pixels({ width: 10, height: 1, depth: 1 }, [0, 0xb0, 0x40])).toEqual([
      255, 0, 255, 255, 0, 0, 0, 0, 0, 255,
    ]);
    expect(await pixels({ width: 4, height: 1, depth: 2 }, [0, 0x1b])).toEqual([0, 85, 170, 255]);
    expect(await pixels({ width: 4, height: 1, depth: 4 }, [0, 0x0f, 0x80])).toEqual([
      0, 255, 136, 0,
    ]);
  });

  test("16-bit takes the high byte", async () => {
    const shape = { width: 1, height: 1, depth: 16, colorType: 6 };
    expect(await pixels(shape, [0, 0x12, 0xff, 0x34, 0xff, 0x56, 0xff, 0x78, 0xff])).toEqual([
      0x12, 0x34, 0x56, 0x78,
    ]);
  });

  test("a gray tRNS key is compared at the file's depth", async () => {
    const shape = { width: 2, height: 1, depth: 16 };
    expect(await pixels(shape, [0, 0x12, 0x34, 0x12, 0x99], trns(0x12, 0x34))).toEqual([
      0x12, 0x12, 0x12, 0, 0x12, 0x12, 0x12, 255,
    ]);
    expect(await pixels({ width: 4, height: 1, depth: 2 }, [0, 0x1b], trns(0, 2))).toEqual([
      0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 0, 255, 255, 255, 255,
    ]);
  });

  test("an RGB tRNS key needs all three channels", async () => {
    const shape = { width: 2, height: 1, colorType: 2 };
    expect(await pixels(shape, [0, 1, 2, 3, 1, 2, 4], trns(0, 1, 0, 2, 0, 3))).toEqual([
      1, 2, 3, 0, 1, 2, 4, 255,
    ]);
  });

  test("a palette picture is RGB, and RGBA with tRNS (missing entries opaque)", async () => {
    const shape = { width: 3, height: 1, depth: 2, colorType: 3 };
    expect(await pixels(shape, [0, 0x18], plte)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(await pixels(shape, [0, 0x18], plte, trns(40))).toEqual([
      1, 2, 3, 40, 4, 5, 6, 255, 7, 8, 9, 255,
    ]);
  });

  test("gray+alpha becomes RGBA", async () => {
    expect(await pixels({ width: 2, height: 1, colorType: 4 }, [0, 7, 9, 200, 0])).toEqual([
      7, 7, 7, 9, 200, 200, 200, 0,
    ]);
    const deep = { width: 1, height: 1, depth: 16, colorType: 4 };
    expect(await pixels(deep, [0, 0xab, 0x01, 0x7f, 0x02])).toEqual([0xab, 0xab, 0xab, 0x7f]);
  });

  test("Adam7: each pass lands where the spec's 8×8 diagram puts it", async () => {
    const diagram = [
      "16462646",
      "77777777",
      "56565656",
      "77777777",
      "36463646",
      "77777777",
      "56565656",
      "77777777",
    ];
    // The stream pass by pass; each pixel's value is its own index.
    const raw: number[] = [];
    for (let pass = 1; pass <= 7; pass += 1) {
      diagram.forEach((line, y) => {
        const row = [...line].flatMap((p, x) => (p === String(pass) ? [y * 8 + x] : []));
        if (row.length > 0) raw.push(0, ...row);
      });
    }
    expect(await pixels({ width: 8, height: 8, interlace: 1 }, raw)).toEqual(
      Array.from({ length: 64 }, (_, i) => i),
    );
  });
});

const FIXTURES = join(import.meta.dir, "fixtures", "png");

/** The named PngSuite subset (O12). */
const SUITE = [
  "basn0g01 basn0g02 basn0g04 basn0g08 basn0g16 basn2c08 basn2c16 basn3p01 basn3p08",
  "basn4a08 basn6a08 basn6a16 basi0g08 basi2c08 basi3p08 basi6a08 tbbn3p08 tbrn2c08",
  "f00n2c08 f01n2c08 f02n2c08 f03n2c08 f04n2c08",
  "xs1n0g01 xcrn0g04 xhdn0g08 xcsn0g01 xd0n2c08 xdtn0g01",
]
  .join(" ")
  .split(" ");

function fixture(name: string): Uint8Array {
  const path = join(FIXTURES, `${name}.png`);
  if (!existsSync(path)) {
    throw new Error(
      `PngSuite fixture ${name}.png is missing: drop PngSuite into the fixtures folder (docs/feat/image-region-png.md § Execution)`,
    );
  }
  return new Uint8Array(readFileSync(path));
}

async function decoded(name: string) {
  const result = await decodePng(fixture(name), inflate);
  if ("refused" in result) {
    throw new Error(`${name}: ${result.refused}`);
  }
  return result;
}

describe("PngSuite: formats (T1)", () => {
  const colors: Record<string, "gray" | "rgb" | "rgba"> = {
    basn0g01: "gray",
    basn0g02: "gray",
    basn0g04: "gray",
    basn0g08: "gray",
    basn0g16: "gray",
    basn2c08: "rgb",
    basn2c16: "rgb",
    basn3p01: "rgb",
    basn3p08: "rgb",
    basn4a08: "rgba",
    basn6a08: "rgba",
    basn6a16: "rgba",
    basi0g08: "gray",
    basi2c08: "rgb",
    basi3p08: "rgb",
    basi6a08: "rgba",
    tbbn3p08: "rgba",
    tbrn2c08: "rgba",
    f00n2c08: "rgb",
    f01n2c08: "rgb",
    f02n2c08: "rgb",
    f03n2c08: "rgb",
    f04n2c08: "rgb",
  };

  for (const [name, color] of Object.entries(colors)) {
    test(`${name} decodes to 32×32 ${color}`, async () => {
      const result = await decoded(name);
      expect([result.width, result.height, result.color]).toEqual([32, 32, color]);
      const channels = { gray: 1, rgb: 3, rgba: 4 }[color];
      expect(result.pixels.length).toBe(32 * 32 * channels);
    });
  }

  // `f0N` uses filter type N on every row. The five are NOT one picture (checked
  // with pngjs 3.4.0, an independent decoder), so each is pinned by spot pixels:
  // RGB at (1,1), (16,16) and (31,31) as pngjs reads them.
  const filtered: Record<string, number[]> = {
    f00n2c08: [255, 31, 8, 0, 0, 0, 0, 32, 255],
    f01n2c08: [255, 31, 8, 0, 0, 0, 0, 32, 255],
    f02n2c08: [255, 31, 8, 4, 255, 0, 0, 32, 255],
    f03n2c08: [255, 31, 8, 4, 255, 0, 0, 32, 255],
    f04n2c08: [255, 31, 8, 4, 255, 0, 0, 32, 255],
  };
  for (const [name, spots] of Object.entries(filtered)) {
    test(`${name} has its spot pixels`, async () => {
      const { pixels } = await decoded(name);
      const at = (x: number, y: number) => [...pixels.subarray((y * 32 + x) * 3).subarray(0, 3)];
      expect([...at(1, 1), ...at(16, 16), ...at(31, 31)]).toEqual(spots);
    });
  }

  // 16-bit: the high byte of each sample, worked out by hand from the inflated
  // IDAT bytes below (filters are bytewise, so the low bytes never carry).
  const wide: [string, number, [number, number, number[]][]][] = [
    // row 0: 01 (Sub) 0000 0900 · row 1: 02 (Up) 0200 0200
    // (1,0) = 09+00; (0,1) = 02+00; (1,1) = 02+09.
    [
      "basn0g16",
      1,
      [
        [0, 0, [0]],
        [1, 0, [9]],
        [0, 1, [2]],
        [1, 1, [11]],
      ],
    ],
    // row 0: 01 (Sub) ffff ffff 0000 · f8be 0000 0000
    // row 1: 04 (Paeth) 0000 f8be 0000 · 0000 0000 0000
    // (1,0) = f8+ff, 00+ff, 00; (0,1) = above + raw; (1,1) predicts f7 (above), f7 (left).
    [
      "basn2c16",
      3,
      [
        [0, 0, [255, 255, 0]],
        [1, 0, [247, 255, 0]],
        [0, 1, [255, 247, 0]],
        [1, 1, [247, 247, 0]],
      ],
    ],
    // row 0: 01 (Sub) ffff ffff 0000 0000 · f8bd 0000 0000 0000
    // row 1: 01 (Sub) ffff f7bc 0000 0000 · 0000 0843 0000 1085
    // (1,0) = f8+ff, 00+ff; (1,1) = 00+ff, 08+f7, 00, 10+00.
    [
      "basn6a16",
      4,
      [
        [0, 0, [255, 255, 0, 0]],
        [1, 0, [247, 255, 0, 0]],
        [0, 1, [255, 247, 0, 0]],
        [1, 1, [255, 255, 0, 16]],
      ],
    ],
  ];
  for (const [name, channels, spots] of wide) {
    test(`${name} keeps the high byte of each 16-bit sample`, async () => {
      const { pixels } = await decoded(name);
      for (const [x, y, want] of spots) {
        const from = (y * 32 + x) * channels;
        expect([...pixels.subarray(from, from + channels)]).toEqual(want);
      }
    });
  }

  // Adam7: each interlaced file is the same picture as its non-interlaced twin
  // (the bundled README does not say so; pngjs 3.4.0 decodes each pair equal).
  for (const kind of ["0g08", "2c08", "3p08", "6a08"]) {
    test(`basi${kind} has the pixels of basn${kind}`, async () => {
      const interlaced = await decoded(`basi${kind}`);
      const plain = await decoded(`basn${kind}`);
      expect(Buffer.compare(interlaced.pixels, plain.pixels)).toBe(0);
    });
  }

  test("tbbn3p08 has transparent pixels", async () => {
    const result = await decoded("tbbn3p08");
    expect(result.pixels.some((v, i) => i % 4 === 3 && v === 0)).toBe(true);
  });

  test("the fixtures folder holds exactly the named subset", () => {
    const have = existsSync(FIXTURES)
      ? readdirSync(FIXTURES).filter((f) => f.endsWith(".png"))
      : [];
    expect(have.sort()).toEqual(SUITE.map((n) => `${n}.png`).sort());
  });
});

describe("PngSuite: corrupt files (T2)", () => {
  for (const name of SUITE.filter((n) => n.startsWith("x"))) {
    test(`${name} is refused with a sentence`, async () => {
      expect(await refusal(fixture(name))).toStartWith("the PNG is corrupt (");
    });
  }
});
