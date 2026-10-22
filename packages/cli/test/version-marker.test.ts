import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MARKER_BYTES, findVersionMarker, readBinaryVersion } from "../src/version-marker.ts";
import { MARKER_PREFIX, formatVersionMarker, parseVersionMarker } from "../src/version.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
/** `n` filler bytes that can never form a marker. */
const filler = (n: number): Uint8Array => new Uint8Array(n).fill(0x5f); // "_"
const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-marker-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let seq = 0;
const file = (bytes: Uint8Array): string => {
  const path = join(dir, `bin-${seq++}`);
  writeFileSync(path, bytes);
  return path;
};

describe("version marker format", () => {
  test("format and parse round-trip; malformed markers parse to undefined", () => {
    expect(formatVersionMarker("0.1.0-beta.1")).toBe("TENTACLE_VERSION_MARKER:0.1.0-beta.1:END");
    expect(parseVersionMarker(formatVersionMarker("1.2.3+build.4"))).toBe("1.2.3+build.4");
    expect(parseVersionMarker(undefined)).toBeUndefined();
    expect(parseVersionMarker("TENTACLE_VERSION_MARKER:0.1.0")).toBeUndefined();
    expect(parseVersionMarker("TENTACLE_VERSION_MARKER::END")).toBeUndefined();
    expect(parseVersionMarker("TENTACLE_VERSION_MARKER:a b:END")).toBeUndefined();
    expect(() => formatVersionMarker("bad version")).toThrow(/invalid version/);
  });
});

describe("findVersionMarker", () => {
  test("finds the marker among binary bytes", () => {
    const bytes = concat(filler(100), enc(formatVersionMarker("0.3.1")), new Uint8Array(50));
    expect(findVersionMarker(bytes)).toBe("0.3.1");
  });

  test("no marker → undefined", () => {
    expect(findVersionMarker(filler(1000))).toBeUndefined();
    expect(findVersionMarker(new Uint8Array(0))).toBeUndefined();
  });

  test("corrupt or partial markers are skipped, never misread", () => {
    for (const bad of [
      MARKER_PREFIX, // the bare prefix literal (the scanner's own code has it)
      `${MARKER_PREFIX}"`,
      `${MARKER_PREFIX}0.1.0`, // truncated: no :END
      `${MARKER_PREFIX}0.1.0:EN`,
      `${MARKER_PREFIX}:END`, // empty version
      `${MARKER_PREFIX}0.1 0:END`, // bad charset
      `${MARKER_PREFIX}${"9".repeat(65)}:END`, // too long
    ]) {
      expect(findVersionMarker(concat(filler(10), enc(bad), filler(10)))).toBeUndefined();
    }
  });

  test("a malformed prefix after a valid marker does not hide it; the last valid one wins", () => {
    const bytes = concat(
      enc(formatVersionMarker("0.1.0")),
      filler(10),
      enc(formatVersionMarker("0.2.0")),
      filler(10),
      enc(`${MARKER_PREFIX}"`),
    );
    expect(findVersionMarker(bytes)).toBe("0.2.0");
  });
});

describe("readBinaryVersion (from the end, then a full scan)", () => {
  test("a marker near the end is found from the tail", async () => {
    const path = file(concat(filler(4096), enc(formatVersionMarker("0.4.0")), filler(64)));
    expect(await readBinaryVersion(path, { tailBytes: 512, chunkBytes: 256 })).toBe("0.4.0");
  });

  test("a marker outside the tail is found only by the full-scan fallback", async () => {
    const path = file(concat(filler(100), enc(formatVersionMarker("0.5.0")), filler(10_000)));
    // The tail alone cannot see it...
    const tail = new Uint8Array(await Bun.file(path).slice(-512).arrayBuffer());
    expect(findVersionMarker(tail)).toBeUndefined();
    // ...the fallback does.
    expect(await readBinaryVersion(path, { tailBytes: 512, chunkBytes: 256 })).toBe("0.5.0");
  });

  test("no marker anywhere → undefined (unknown version)", async () => {
    const path = file(filler(10_000));
    expect(await readBinaryVersion(path, { tailBytes: 512, chunkBytes: 256 })).toBeUndefined();
    expect(await readBinaryVersion(file(new Uint8Array(0)))).toBeUndefined();
  });

  test("a marker split across every possible chunk boundary is still found", async () => {
    const marker = enc(formatVersionMarker("10.20.30-rc.1"));
    const chunkBytes = 2 * MAX_MARKER_BYTES; // the minimum chunk
    const tailBytes = MAX_MARKER_BYTES;
    // Slide the marker over a whole chunk's worth of offsets, so it straddles
    // the tail boundary and the chunk boundaries at some offset.
    for (let pad = 0; pad < chunkBytes + 2; pad++) {
      const path = file(concat(filler(300 + pad), marker, filler(3 * chunkBytes - pad)));
      expect(await readBinaryVersion(path, { tailBytes, chunkBytes })).toBe("10.20.30-rc.1");
    }
  });

  test("a missing file throws (the caller decides 'missing' first)", async () => {
    await expect(readBinaryVersion(join(dir, "nope"))).rejects.toThrow();
  });
});

describe("findAllVersionMarkers (build check, review N1)", () => {
  test("lists every well-formed marker in file order, skipping malformed ones", async () => {
    const { findAllVersionMarkers } = await import("../src/version-marker.ts");
    const bytes = concat(
      enc(formatVersionMarker("0.1.0")),
      enc(`${MARKER_PREFIX}"`),
      enc(formatVersionMarker("0.2.0")),
    );
    expect(findAllVersionMarkers(bytes)).toEqual(["0.1.0", "0.2.0"]);
    expect(findAllVersionMarkers(filler(100))).toEqual([]);
  });
});

describe("APP_VERSION source (review N2)", () => {
  test("from source, a TENTACLE_VERSION_MARKER env var cannot fake a release version", () => {
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), "--version"], {
      env: { ...process.env, TENTACLE_VERSION_MARKER: formatVersionMarker("9.9.9") },
    });
    expect(proc.stdout.toString()).toBe("tentacle dev\n");
  });
});
