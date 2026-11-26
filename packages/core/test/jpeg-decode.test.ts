import { describe, expect, test } from "bun:test";
import {
  type JpegDecoder,
  type JpegHeader,
  MAX_JPEG_DECODE_BYTES,
  decodeJpeg,
  jpegDecodeCost,
  readJpegHeader,
} from "../src/jpeg-decode.ts";
import { MAX_PNG_DECODE_BYTES } from "../src/png-decode.ts";

const load = async (name: string): Promise<Uint8Array> =>
  new Uint8Array(await Bun.file(`${import.meta.dir}/fixtures/jpeg/${name}.jpg`).arrayBuffer());
const base = await load("small-baseline");

const cat = (...parts: ArrayLike<number>[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** The offset of the first `FF marker` among the segments before the scan. */
function segment(bytes: Uint8Array, marker: number): { at: number; end: number } {
  let i = 2;
  while (i + 3 < bytes.length) {
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    if (bytes[i + 1] === marker) {
      return { at: i, end: i + 2 + length };
    }
    i += 2 + length;
  }
  throw new Error(`no marker ${marker.toString(16)}`);
}

/** `base` with the segment at `marker` replaced. */
function replaced(marker: number, next: ArrayLike<number>): Uint8Array {
  const { at, end } = segment(base, marker);
  return cat(base.subarray(0, at), next, base.subarray(end));
}

/** `base` with `extra` inserted just before the segment at `marker`. */
function insertedAt(marker: number, extra: ArrayLike<number>): Uint8Array {
  const { at } = segment(base, marker);
  return cat(base.subarray(0, at), extra, base.subarray(at));
}

const seg = (marker: number, payload: ArrayLike<number>): Uint8Array =>
  cat([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 255], payload);

/** A frame header's payload. */
function sofPayload(
  width: number,
  height: number,
  sampling: readonly (readonly [number, number])[],
  precision = 8,
): number[] {
  return [
    precision,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    sampling.length,
    ...sampling.flatMap(([h, v], i) => [i + 1, (h << 4) | v, i === 0 ? 0 : 1]),
  ];
}

const S420 = [
  [2, 2],
  [1, 1],
  [1, 1],
] as const;

const entropyAt = segment(base, 0xda).end;
const eoiAt = base.length - 2;
const DNL = [0xff, 0xdc, 0x00, 0x04, 0x01, 0x00];

/** A decoder spy: the refusal cases must never reach it. */
function spy(): { decoder: JpegDecoder; calls: () => number } {
  let calls = 0;
  return {
    decoder: () => {
      calls += 1;
      return { width: 64, height: 48, components: 3, pixels: new Uint8Array(64 * 48 * 3) };
    },
    calls: () => calls,
  };
}

/** The refusal sentence, after checking the decoder was never reached. */
function refusal(bytes: Uint8Array): string {
  const header = readJpegHeader(bytes);
  const s = spy();
  if (!("refused" in header)) {
    decodeJpeg(bytes, header, s.decoder);
    return `ACCEPTED ${header.width}×${header.height}`;
  }
  expect(s.calls()).toBe(0);
  return header.refused;
}

function accepted(bytes: Uint8Array): JpegHeader {
  const header = readJpegHeader(bytes);
  if ("refused" in header) {
    throw new Error(`refused: ${header.refused}`);
  }
  return header;
}

describe("readJpegHeader: the real fixtures (T1)", () => {
  const colour420 = S420.map(([h, v]) => ({ h, v }));
  const full = [
    { h: 1, v: 1 },
    { h: 1, v: 1 },
    { h: 1, v: 1 },
  ];
  const cases = [
    ["small-baseline", 3, colour420, false, 1],
    ["small-progressive", 3, colour420, true, 1],
    ["small-gray", 1, [{ h: 1, v: 1 }], false, 1],
    ["small-444", 3, full, false, 1],
    ["small-rgb-colorspace", 3, full, false, 1],
    ...([1, 2, 3, 4, 5, 6, 7, 8] as const).map(
      (o) => [`small-orient-${o}`, 3, colour420, false, o] as const,
    ),
  ] as const;

  for (const [name, components, sampling, progressive, orientation] of cases) {
    test(name, async () => {
      expect(accepted(await load(name))).toEqual({
        width: 64,
        height: 48,
        components,
        sampling: [...sampling],
        progressive,
        orientation,
      });
    });
  }

  test("a 12 MP 4:2:0 frame costs exactly pdf.js's allocations", () => {
    const bytes = replaced(0xc0, seg(0xc0, sofPayload(4032, 3024, S420)));
    expect(jpegDecodeCost(accepted(bytes))).toBe(73_253_376);
    expect(MAX_JPEG_DECODE_BYTES).toBe(MAX_PNG_DECODE_BYTES);
  });
});

describe("readJpegHeader: strict refusals (T2)", () => {
  const layout = (what: string) => `the JPEG has an unexpected layout (${what})`;
  const sof = segment(base, 0xc0);
  const sofBytes = base.subarray(sof.at + 4, sof.end);

  test("a DNL marker in the first scan", () => {
    const bytes = cat(base.subarray(0, entropyAt), DNL, base.subarray(entropyAt));
    expect(refusal(bytes)).toBe(layout("a DNL marker that changes the height"));
  });

  test("a DNL marker after a restart marker and a fill byte", () => {
    const bytes = cat(base.subarray(0, eoiAt), [0xff, 0xd0, 0xff], DNL, [0xff, 0xd9]);
    expect(refusal(bytes)).toBe(layout("a DNL marker that changes the height"));
  });

  // pdf.js SKIPS a marker under C0, takes the restart marker and reads on, DNL
  // included: it allocates for the DNL's height (Execution step 0, probe A).
  test("junk under FFC0 in the first scan, which pdf.js skips past", () => {
    const bytes = cat(base.subarray(0, eoiAt), [0xff, 0x10, 0xff, 0xd0], DNL, [0xff, 0xd9]);
    expect(refusal(bytes)).toBe("the JPEG has an unexpected marker FF10");
  });

  test("a marker that cannot end a first scan", () => {
    const bytes = cat(base.subarray(0, eoiAt), [0xff, 0xd8], [0xff, 0xd9]);
    expect(refusal(bytes)).toBe("the JPEG has an unexpected marker FFD8");
  });

  // pdf.js then scans the APP PAYLOAD for markers and parses what it finds
  // there (Execution step 0, probe B).
  for (const marker of [0xe1, 0xfe]) {
    test(`a fill byte after segment FF${marker.toString(16)}, smuggling a frame`, () => {
      const hidden = seg(0xc0, sofPayload(60_000, 60_000, S420));
      const bytes = cat([0xff, 0xd8], seg(marker, hidden), [0xff], base.subarray(2));
      expect(refusal(bytes)).toBe(layout("a fill byte after an application or comment segment"));
    });
  }

  test("a fill byte before an application segment or a table is fine", () => {
    expect(accepted(cat([0xff, 0xd8, 0xff], base.subarray(2))).width).toBe(64);
    expect(accepted(insertedAt(0xc4, [0xff, 0xff])).width).toBe(64);
  });

  test("a SOF length one over its content", () => {
    const bytes = replaced(0xc0, seg(0xc0, [...sofBytes, 0]));
    expect(refusal(bytes)).toBe(layout("a frame header whose length does not match"));
  });

  test("a DHT length one under its content", () => {
    const dht = segment(base, 0xc4);
    const bytes = Uint8Array.from(base);
    const length = dht.end - dht.at - 2 - 1;
    bytes[dht.at + 2] = length >> 8;
    bytes[dht.at + 3] = length & 255;
    expect(refusal(bytes)).toBe(layout("a Huffman table that does not fill its segment"));
  });

  test("a DQT whose third table is cut short", () => {
    const table = (id: number, n: number) => [id, ...new Array<number>(n).fill(1)];
    const bytes = replaced(0xdb, seg(0xdb, [...table(0, 64), ...table(1, 64), ...table(2, 10)]));
    expect(refusal(bytes)).toBe(layout("a quantization table that does not fill its segment"));
  });

  test("a DQT precision over 1", () => {
    const bytes = replaced(0xdb, seg(0xdb, [0x20, ...new Array<number>(64).fill(1)]));
    expect(refusal(bytes)).toBe(layout("a quantization table with an unknown precision"));
  });

  test("a DRI of the wrong length", () => {
    expect(refusal(insertedAt(0xda, seg(0xdd, [0, 0, 0])))).toBe(
      layout("a restart interval segment of the wrong length"),
    );
    expect(accepted(insertedAt(0xda, seg(0xdd, [0, 0]))).width).toBe(64);
  });

  test("an SOS length that does not match its selectors", () => {
    const sos = segment(base, 0xda);
    const payload = base.subarray(sos.at + 4, sos.end);
    expect(refusal(replaced(0xda, seg(0xda, [...payload, 0])))).toBe(
      layout("a scan header whose length does not match"),
    );
  });

  test("an SOS naming a component the frame does not have", () => {
    const sos = segment(base, 0xda);
    const bytes = Uint8Array.from(base);
    bytes[sos.at + 5] = 0x77;
    expect(refusal(bytes)).toBe(layout("a scan that names a component the frame does not have"));
  });

  test("an unknown marker before the scan", () => {
    expect(refusal(insertedAt(0xda, [0xff, 0x10, 0x00, 0x02]))).toBe(
      "the JPEG has an unexpected marker FF10",
    );
  });

  test("a second frame header", () => {
    expect(refusal(insertedAt(0xda, seg(0xc0, sofBytes)))).toBe(layout("a second frame header"));
  });

  test("a sampling factor of 0 or over 4", () => {
    for (const bad of [
      [0, 1],
      [5, 1],
      [1, 0],
    ] as const) {
      const bytes = replaced(0xc0, seg(0xc0, sofPayload(64, 48, [bad, [1, 1], [1, 1]])));
      expect(refusal(bytes)).toBe("the JPEG is corrupt (a sampling factor outside 1…4)");
    }
  });

  test("a height of 0 (set later by a DNL)", () => {
    expect(refusal(replaced(0xc0, seg(0xc0, sofPayload(64, 0, S420))))).toBe(
      "the JPEG is corrupt (an invalid pixel size)",
    );
  });

  test("CMYK, arithmetic, lossless and 12-bit get fs_read's sentences", () => {
    const four = [
      [1, 1],
      [1, 1],
      [1, 1],
      [1, 1],
    ] as const;
    expect(refusal(replaced(0xc0, seg(0xc0, sofPayload(64, 48, four))))).toBe(
      "a CMYK JPEG — convert it to RGB first",
    );
    expect(refusal(replaced(0xc0, seg(0xc9, sofPayload(64, 48, S420))))).toBe(
      "an arithmetic-coded JPEG — only Huffman coding is supported",
    );
    expect(refusal(replaced(0xc0, seg(0xc3, sofPayload(64, 48, S420))))).toBe(
      "a lossless or hierarchical JPEG — only baseline or progressive is supported",
    );
    expect(refusal(replaced(0xc0, seg(0xc0, sofPayload(64, 48, S420, 12))))).toBe(
      "a 12-bit JPEG — only 8-bit is supported",
    );
  });

  test("a missing EOI is a truncated file", () => {
    const sentence = "the JPEG is corrupt (it is truncated: no end-of-image marker)";
    expect(refusal(base.subarray(0, eoiAt))).toBe(sentence);
    expect(refusal(base.subarray(0, entropyAt + 40))).toBe(sentence);
  });

  test("no SOI, no frame before the scan, a segment past the end", () => {
    expect(refusal(base.subarray(2))).toBe("the JPEG is corrupt (no start-of-image marker)");
    expect(refusal(replaced(0xc0, []))).toBe(
      "the JPEG is corrupt (no frame header before the image data)",
    );
    expect(refusal(base.subarray(0, 30))).toBe(
      "the JPEG is corrupt (a segment runs past the end of the file)",
    );
    expect(refusal(base.subarray(0, 2))).toBe(
      "the JPEG is corrupt (it ends before its image data)",
    );
  });

  test("never throws on any truncation or single-byte damage", () => {
    for (let n = 0; n < entropyAt + 8; n += 1) {
      expect(() => readJpegHeader(base.subarray(0, n))).not.toThrow();
      const damaged = Uint8Array.from(base);
      damaged[n] = 0xff;
      expect(() => readJpegHeader(damaged)).not.toThrow();
    }
  });
});

// pdf.js walks every block of the frame once per scan, so the decode's CPU is
// bounded by what EVERY scan up to the EOI may say, not only the first one.
describe("readJpegHeader: every scan bounds the decode's CPU (T2)", () => {
  const layout = (what: string) => `the JPEG has an unexpected layout (${what})`;
  const sos = segment(base, 0xda);
  const sosPayload = [...base.subarray(sos.at + 4, sos.end)];
  const [, first = 0, , second = 0] = sosPayload;
  const scan = cat(seg(0xda, sosPayload), [0]);
  const scans = (n: number) => cat(...new Array<Uint8Array>(n).fill(scan));
  /** `base` (one scan) with `extra` between its entropy data and its EOI. */
  const afterScan = (...extra: ArrayLike<number>[]) =>
    cat(base.subarray(0, eoiAt), ...extra, [0xff, 0xd9]);
  const sosWith = (change: (payload: number[]) => void) => {
    const payload = [...sosPayload];
    change(payload);
    return seg(0xda, payload);
  };
  const twice = sosWith((p) => {
    p[3] = first;
  });
  // `Se`, the second byte from the end.
  const pastEnd = sosWith((p) => {
    p[p.length - 2] = 64;
  });

  test("32 scans are accepted, 33 refused", () => {
    expect(accepted(afterScan(scans(31))).width).toBe(64);
    expect(refusal(afterScan(scans(32)))).toBe(layout("more than 32 scans"));
  });

  test("an EOI inside a later APP segment does not end the count", () => {
    const bytes = afterScan(seg(0xe1, [0xff, 0xd9]), scans(32));
    expect(refusal(bytes)).toBe(layout("more than 32 scans"));
  });

  test("bytes after the EOI are not part of the image", () => {
    const bytes = cat(base, scans(100), seg(0xc0, sofPayload(60_000, 60_000, S420)));
    expect(accepted(bytes).width).toBe(64);
  });

  test("a scan that names a component twice, first or later", () => {
    expect(second).not.toBe(first);
    const sentence = layout("a scan that names a component twice");
    expect(refusal(replaced(0xda, twice))).toBe(sentence);
    expect(refusal(afterScan(twice))).toBe(sentence);
  });

  test("a spectral selection past coefficient 63, first or later", () => {
    const sentence = layout("a scan that ends past coefficient 63");
    expect(refusal(replaced(0xda, pastEnd))).toBe(sentence);
    expect(refusal(afterScan(pastEnd))).toBe(sentence);
  });

  test("a later scan gets the same walk as the first", () => {
    const unknown = sosWith((p) => {
      p[1] = 0x77;
    });
    expect(refusal(afterScan(unknown))).toBe(
      layout("a scan that names a component the frame does not have"),
    );
    expect(refusal(afterScan(scan, DNL))).toBe(layout("a DNL marker that changes the height"));
    expect(refusal(afterScan(scan, [0xff, 0x10]))).toBe("the JPEG has an unexpected marker FF10");
    const frame = seg(0xc0, sofPayload(64, 48, S420));
    expect(refusal(afterScan(frame))).toBe("the JPEG has an unexpected marker FFC0");
    expect(refusal(afterScan(seg(0xfe, []), frame))).toBe(layout("a second frame header"));
    // pdf.js would search this APP payload and find the scans hidden in it.
    expect(refusal(afterScan(seg(0xe1, scans(40)), [0xff]))).toBe(
      layout("a fill byte after an application or comment segment"),
    );
  });
});

describe("readJpegHeader: EXIF orientation", () => {
  /** An APP1 Exif segment whose IFD0 holds one entry. */
  function exif(order: "MM" | "II", value: number, ifdOffset = 8, type = 3): Uint8Array {
    const tiff = new Uint8Array(26);
    const view = new DataView(tiff.buffer);
    const little = order === "II";
    tiff.set([...order].map((c) => c.charCodeAt(0)));
    view.setUint16(2, 42, little);
    view.setUint32(4, ifdOffset, little);
    view.setUint16(8, 1, little);
    view.setUint16(10, 0x0112, little);
    view.setUint16(12, type, little);
    view.setUint32(14, 1, little);
    view.setUint16(18, value, little);
    return seg(0xe1, cat([0x45, 0x78, 0x69, 0x66, 0, 0], tiff));
  }
  const orientationOf = (segmentBytes: Uint8Array) =>
    accepted(cat([0xff, 0xd8], segmentBytes, base.subarray(2))).orientation;

  test("both byte orders", () => {
    expect(orientationOf(exif("MM", 6))).toBe(6);
    expect(orientationOf(exif("II", 8))).toBe(8);
  });

  test("malformed EXIF is orientation 1, never a refusal", () => {
    expect(orientationOf(exif("MM", 6, 4000))).toBe(1);
    expect(orientationOf(exif("MM", 9))).toBe(1);
    expect(orientationOf(exif("MM", 0))).toBe(1);
    expect(orientationOf(exif("MM", 6, 8, 4))).toBe(1);
    expect(orientationOf(seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0]))).toBe(1);
    expect(orientationOf(seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, 1, 2, 3]))).toBe(1);
  });

  test("the first Exif segment decides", () => {
    expect(orientationOf(cat(exif("MM", 3), exif("MM", 6)))).toBe(3);
  });
});

describe("decodeJpeg (T3)", () => {
  const header = (width: number, height: number): JpegHeader => ({
    width,
    height,
    components: 3,
    progressive: false,
    sampling: S420.map(([h, v]) => ({ h, v })),
    orientation: 1,
  });

  test("over the budget: refused with both figures, the decoder never called", () => {
    const bytes = replaced(0xc0, seg(0xc0, sofPayload(60_000, 60_000, S420)));
    const s = spy();
    expect(decodeJpeg(bytes, accepted(bytes), s.decoder)).toEqual({
      refused: "the JPEG is 60000×60000: decoding it needs 20602 MiB, over the 128 MiB limit",
    });
    expect(s.calls()).toBe(0);
  });

  test("a good decode is 8-bit gray or rgb", () => {
    const pixels = new Uint8Array(64 * 48 * 3);
    expect(
      decodeJpeg(base, header(64, 48), () => ({ width: 64, height: 48, components: 3, pixels })),
    ).toEqual({ width: 64, height: 48, color: "rgb", pixels });
    const gray = new Uint8Array(64 * 48);
    expect(
      decodeJpeg(base, { ...header(64, 48), components: 1, sampling: [{ h: 1, v: 1 }] }, () => ({
        width: 64,
        height: 48,
        components: 1,
        pixels: gray,
      })),
    ).toEqual({ width: 64, height: 48, color: "gray", pixels: gray });
  });

  test("a throwing decoder is one sentence, its message cut at 120 characters", () => {
    const result = decodeJpeg(base, header(64, 48), () => {
      throw new Error("x".repeat(500));
    });
    expect(result).toEqual({ refused: `the JPEG is corrupt (${"x".repeat(120)})` });
  });

  test("a decoded size that differs from the header is refused", () => {
    const sentence = {
      refused: "the JPEG is corrupt (decoded size differs from its header)",
    };
    const wrong = [
      { width: 64, height: 256, components: 3, pixels: new Uint8Array(64 * 256 * 3) },
      { width: 64, height: 48, components: 1, pixels: new Uint8Array(64 * 48) },
      { width: 64, height: 48, components: 3, pixels: new Uint8Array(10) },
    ];
    for (const out of wrong) {
      expect(decodeJpeg(base, header(64, 48), () => out)).toEqual(sentence);
    }
  });
});
