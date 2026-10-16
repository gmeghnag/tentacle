import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePodBinary } from "../src/pod-binary-build.ts";
import type { PodBinaryTarget } from "../src/pod-binary.ts";

/** A fake build that "compiles" by writing a marker file (no real build). */
function fakeBuild(marker: (outfile: string) => string) {
  const built: string[] = [];
  return {
    built,
    build: async (outfile: string, _target: string): Promise<boolean> => {
      built.push(outfile);
      writeFileSync(outfile, marker(outfile));
      return true;
    },
  };
}

describe("resolvePodBinary", () => {
  test("TENTACLE_POD_BIN override is read directly (no cache, no build)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const override = join(dir, "my-prebuilt");
    writeFileSync(override, "PREBUILT-BYTES");
    const saved = process.env.TENTACLE_POD_BIN;
    process.env.TENTACLE_POD_BIN = override;
    const logs: string[] = [];
    try {
      const bytes = await resolvePodBinary("bun-linux-x64", {
        cacheDir: join(dir, "cache"),
        build: fakeBuild(() => "SHOULD-NOT-BUILD").build,
        log: (l) => logs.push(l),
      });
      expect(Buffer.from(bytes).toString()).toBe("PREBUILT-BYTES");
      expect(logs.some((l) => l.includes("TENTACLE_POD_BIN"))).toBe(true);
      // The override wins: nothing is cached or built.
      expect(existsSync(join(dir, "cache"))).toBe(false);
    } finally {
      // `saved` is `undefined` when the var wasn't set. (Assigning `undefined`
      // would stringify to "undefined" in Bun, so delete the key instead —
      // `Reflect.deleteProperty` keeps biome's `noDelete` happy.)
      if (saved === undefined) {
        Reflect.deleteProperty(process.env, "TENTACLE_POD_BIN");
      } else {
        process.env.TENTACLE_POD_BIN = saved;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a cache miss builds into the cache and returns the bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const cacheDir = join(dir, "cache");
    const { built, build } = fakeBuild((o) => `BUILT:${o}`);
    const target: PodBinaryTarget = "bun-linux-arm64";
    try {
      const bytes = await resolvePodBinary(target, { cacheDir, build });
      expect(built).toHaveLength(1);
      expect(built[0]).toBe(join(cacheDir, "tentacle-bun-linux-arm64"));
      expect(Buffer.from(bytes).toString()).toBe(
        `BUILT:${join(cacheDir, "tentacle-bun-linux-arm64")}`,
      );
      expect(existsSync(join(cacheDir, "tentacle-bun-linux-arm64"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a cache hit does not rebuild", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const cacheDir = join(dir, "cache");
    const outfile = join(cacheDir, "tentacle-bun-linux-x64");
    // Seed the cache with an existing binary (the cache dir must exist first).
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(outfile, "CACHED-BYTES");
    const { built, build } = fakeBuild(() => "SHOULD-NOT-REBUILD");
    const logs: string[] = [];
    try {
      const bytes = await resolvePodBinary("bun-linux-x64", {
        cacheDir,
        build,
        log: (l) => logs.push(l),
      });
      expect(Buffer.from(bytes).toString()).toBe("CACHED-BYTES");
      expect(built).toHaveLength(0);
      expect(logs.some((l) => l.includes("using cache"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed build throws with a helpful hint (no stale cache entry)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "harness-podbin-"));
    const cacheDir = join(dir, "cache");
    const build = async (): Promise<boolean> => false; // simulate a failing build
    try {
      await expect(resolvePodBinary("bun-linux-x64", { cacheDir, build })).rejects.toThrow(
        /failed to build the bun-linux-x64/,
      );
      await expect(resolvePodBinary("bun-linux-x64", { cacheDir, build })).rejects.toThrow(
        /TARGET=bun-linux-x64 bun run compile/,
      );
      // A failed build must not leave a partial cache entry.
      expect(existsSync(join(cacheDir, "tentacle-bun-linux-x64"))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
